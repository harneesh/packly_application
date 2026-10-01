// components/search-widget.tsx
// Reusable search widget that wraps screen content.
// The search bar is always visible at the top. When search is active (the
// user typed OR set a filter), results replace the wrapped children; when
// idle the original content is visible. Nothing scrolls behind the bar.
//
// Advanced Search (migrations 016 + 019 — faceted search):
//   • A dedicated FULL-SCREEN "Advanced Search" page, opened from the funnel
//     button on the right of the search bar. It asks ONE question first —
//     single-select, remembered for the session — and then shows only the
//     filters that can answer it:
//        Which box is my item in? → The item (name, picture) +
//                                   Where it might be (location, box status,
//                                   packed by)
//        What's in a box?         → The box (box number, location)
//     Every field is a dropdown that starts CLOSED and NOTHING is required:
//     whatever the user fills in is what gets searched.
//   • "What's in a box" OPENS the box it resolves to: a lone match jumps
//     straight into that box's screen (that is what "what's in a box" means).
//     Box mode searches boxes only; item mode searches items and boxes, so a
//     term that looks like a box number still finds Box 12.
//   • Applied filters show as removable pills under the bar, so it is never a
//     mystery why results are narrowed; tap a pill to drop that facet. Pills
//     always belong to the question that produced them — applying one mode's
//     filters drops the other mode's, so a hidden filter can never narrow a
//     search silently.
//   • Search spans items and boxes in one round trip and works with an EMPTY
//     search term, so "Box 3" or "Kitchen" can be found by tapping instead of
//     typing. Rooms are never returned as rows — a room is reached by opening
//     one of its boxes. (The old "Room progress" filter is gone: the Home
//     progress card owns the "how far along is this move?" question.)
//   • Box results show a photo thumbnail when the box has one (the RPC returns
//     a storage path; it is signed into a temporary URL client-side), and a
//     room's boxes are listed in the app's numeric order (Box 2 before
//     Box 10) because the database can only sort the TEXT column literally.
//
// Everything else is unchanged from the previous behavior: typo-tolerant
// matching (pg_trgm, server-side), 200ms debounce, skeleton rows, highlighted
// matches, recent searches, and the result preview sheet with Open Box /
// Open Room.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, font, fonts, radius, shadow } from '../../packly-ui/theme';
import CollapsibleSection from '../../packly-ui/components/CollapsibleSection';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/auth-store';
import { useUiStore } from '@/store/ui-store';
import { signPhotoPaths } from '@/services/photos';
import { compareBoxNumbers, fetchRooms, ROOM_STALE_MS } from '@/services/rooms';
import { fetchMembers, MEMBERS_STALE_MS } from '@/services/members';
import {
  loadRecentSearches,
  addRecentSearch,
  clearRecentSearches,
} from '@/services/recent-searches';

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type ResultKind = 'item' | 'box' | 'room';

/**
 * The two questions Advanced Search can answer. Picking one is the first step
 * of the page, and it decides which filters exist and what a result row is.
 */
type SearchMode = 'item' | 'box';

const MODE_META: Record<
  SearchMode,
  { icon: keyof typeof Ionicons.glyphMap; title: string; helper: string }
> = {
  item: {
    icon: 'cube-outline',
    title: 'Which box is my item in?',
    helper: 'Find an item and see where it was packed',
  },
  box: {
    icon: 'archive-outline',
    title: "What's in a box?",
    helper: "See a box's contents without opening it",
  },
};

/**
 * Result kinds each question searches. Item mode also matches boxes, so a
 * term that looks like a box number ("12") still finds Box 12 and a
 * location-only search still browses that room's boxes; box mode is boxes
 * only, because the box IS the answer there.
 */
const MODE_KINDS: Record<SearchMode, ResultKind[]> = {
  item: ['item', 'box'],
  box: ['box'],
};

/**
 * Last question the user picked, remembered for the app session (not
 * persisted) so reopening the page resumes where they left off.
 */
let lastSearchMode: SearchMode = 'item';

/** Height of the Advanced Search footer bar (md padding + button + sm). */
const FILTERS_FOOTER_HEIGHT = spacing.md + 50 + spacing.sm;

const KIND_META: Record<
  ResultKind,
  { icon: keyof typeof Ionicons.glyphMap; plural: string }
> = {
  box: { icon: 'archive-outline', plural: 'Boxes' },
  item: { icon: 'cube-outline', plural: 'Items' },
  room: { icon: 'bed-outline', plural: 'Rooms' },
};

interface SearchResult {
  kind: ResultKind;
  /** id of the item / box / room this row represents. */
  entity_id: string;
  /** Display title: item name, box number, or room name. */
  title: string;
  box_id: string | null;
  box_number: string | null;
  room_id: string | null;
  room_name: string | null;
  move_id: string;
  move_name: string;
  /** Storage path of the box's first photo (private bucket — not a URL). */
  photo_path: string | null;
  /** Signed, temporary URL derived from photo_path. */
  photo_url: string | null;
  score: number;
}

/** "Item with picture" — three states, so it can be turned off again. */
type PhotoState = 'any' | 'with' | 'without';

/**
 * Box statuses the "Box status" filter can select — the same three states the
 * StatusPill shows across the app. A box matches when its state is ANY of the
 * selected states, so {empty, packing} means "everything left to pack".
 */
type BoxState = 'empty' | 'packing' | 'packed';

const BOX_STATE_LABEL: Record<BoxState, string> = {
  empty: 'Empty',
  packing: 'Packing',
  packed: 'Packed',
};

/** Right-hand summary for the "Box status" dropdown, e.g. "Empty, Packing". */
function boxStatesLabel(states: BoxState[]): string | undefined {
  return states.length === 0
    ? undefined
    : states.map((s) => BOX_STATE_LABEL[s]).join(', ');
}

/**
 * Committed "Packed by" selection, tagged with the move it was chosen in.
 * Switching moves must never leave a member from the previous move silently
 * narrowing the search — a stale selection simply stops applying.
 */
interface PackedByFilter {
  moveId: string;
  userId: string;
}

interface SearchFilters {
  kinds: ResultKind[];
  /**
   * Room ids the Location text resolved to. null = no location filter.
   * An EMPTY array means "typed a location that matches no room" → no rows.
   */
  roomIds: string[] | null;
  boxNumber: string;
  photoState: PhotoState;
  boxStates: BoxState[];
  /** 'any' or a move member's user id. */
  packedBy: string;
}

/**
 * Draft of the Advanced Search page, committed on "Show results". Fields are
 * grouped by the question they belong to, so editing one question's fields
 * leaves the other's untouched and switching back and forth is free.
 */
interface DraftFilters {
  /** Which question the page is answering right now. */
  mode: SearchMode;
  // ── "Which box is my item in?" ──
  itemName: string;
  itemLocation: string;
  photoState: PhotoState;
  boxStates: BoxState[];
  /** 'any' or a move member's user id. */
  packedBy: string;
  // ── "What's in a box?" ──
  boxNumber: string;
  boxLocation: string;
}

const DEFAULT_DRAFT: DraftFilters = {
  mode: 'item',
  itemName: '',
  itemLocation: '',
  photoState: 'any',
  boxStates: [],
  packedBy: 'any',
  boxNumber: '',
  boxLocation: '',
};

/** Right-hand summary shown on the "Item with picture" dropdown row. */
const PHOTO_LABEL: Record<PhotoState, string | undefined> = {
  any: undefined,
  with: 'With picture',
  without: 'No picture',
};

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function searchInventory(
  searchTerm: string,
  moveId: string | null | undefined,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const term = searchTerm.trim();
  const boxNumber = filters.boxNumber.trim();

  // Nothing typed and nothing filtered → nothing to search. The RPC refuses
  // an unfiltered query for the same reason (it would dump the whole
  // inventory), so this only saves a round trip.
  if (
    !term &&
    !filters.roomIds &&
    !boxNumber &&
    filters.photoState === 'any' &&
    filters.boxStates.length === 0 &&
    filters.packedBy === 'any'
  ) {
    return [];
  }

  const params: Record<string, unknown> = {
    // Empty string → NULL server-side: enables filter-only browsing.
    search_term: term || null,
    kinds: filters.kinds,
    has_photos_only: filters.photoState === 'with',
    no_photos_only: filters.photoState === 'without',
  };
  // Scope to the active move when on a move/room/home screen.
  // NULL (omitted) falls back to "all moves the user is a member of".
  if (moveId) params.move_scope_id = moveId;
  // Empty array = "location matched no room" → the RPC returns no rows.
  if (filters.roomIds) params.room_ids = filters.roomIds;
  if (boxNumber) params.box_number_filter = boxNumber;
  if (filters.boxStates.length > 0) params.box_states = filters.boxStates;
  if (filters.packedBy !== 'any') params.packed_by = filters.packedBy;

  const { data, error } = await supabase.rpc('search_inventory', params);

  if (error) {
    console.error('[SEARCH ERROR]', error.message, error.code, error.details);
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Array<Omit<SearchResult, 'photo_url'>>;

  // Browsing a room's boxes (box mode with nothing typed) is a LIST, not a
  // ranked search, so it is ordered the way boxes are ordered everywhere else
  // in the app — Box 2 before Box 10 (the RPC can only sort the TEXT column
  // lexicographically). A typed term keeps relevance order.
  const browsingBoxes =
    !term && filters.kinds.length === 1 && filters.kinds[0] === 'box';
  const ordered = browsingBoxes
    ? [...rows].sort((a, b) => compareBoxNumbers(a.title, b.title))
    : rows;

  // Only BOX rows show a thumbnail, so only their paths are signed — no
  // pointless signing calls for item/room results. The bucket is private, so
  // paths must be turned into short-lived URLs (cache-backed → repeat
  // searches cost zero network calls).
  const paths = ordered
    .filter((r) => r.kind === 'box')
    .map((r) => r.photo_path)
    .filter((p): p is string => !!p);
  const urlByPath = paths.length > 0 ? await signPhotoPaths(paths) : {};

  return ordered.map((r) => ({
    ...r,
    photo_url: r.photo_path ? urlByPath[r.photo_path] ?? null : null,
  }));
}

// ──────────────────────────────────────────
// Highlighted text
// ──────────────────────────────────────────

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) {
    return <Text style={styles.resultTitle} numberOfLines={1}>{text}</Text>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: { str: string; match: boolean }[] = [];
  let idx = 0;

  while (idx < text.length) {
    const found = lowerText.indexOf(lowerQuery, idx);
    if (found === -1) {
      parts.push({ str: text.slice(idx), match: false });
      break;
    }
    if (found > idx) {
      parts.push({ str: text.slice(idx, found), match: false });
    }
    parts.push({ str: text.slice(found, found + lowerQuery.length), match: true });
    idx = found + lowerQuery.length;
  }

  return (
    <Text style={styles.resultTitle} numberOfLines={1}>
      {parts.map((p, i) => (
        <Text key={i} style={p.match ? styles.resultTitleMatch : undefined}>
          {p.str}
        </Text>
      ))}
    </Text>
  );
}

// ──────────────────────────────────────────
// Skeleton row
// ──────────────────────────────────────────

function SkeletonRow({ opacity }: { opacity: Animated.Value }) {
  return (
    <Animated.View style={[styles.resultCard, { opacity }]}>
      <View style={[styles.resultIcon, { backgroundColor: colors.surfaceMuted }]}>
        <Ionicons name="cube-outline" size={18} color={colors.textTertiary} />
      </View>
      <View style={styles.resultInfo}>
        <View style={[styles.skeletonLine, { width: '68%' }]} />
        <View style={[styles.skeletonLine, { width: '42%' }]} />
      </View>
    </Animated.View>
  );
}

// ──────────────────────────────────────────
// Advanced Search button
// ──────────────────────────────────────────

/** Funnel button sitting in the search bar; badge counts the applied facets. */
function FilterButton({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        count > 0 ? `Advanced Search, ${count} applied` : 'Advanced Search'
      }
      style={({ pressed }) => [styles.filterButton, pressed && { opacity: 0.7 }]}>
      <Ionicons
        name="options-outline"
        size={18}
        color={count > 0 ? colors.primary : colors.textSecondary}
      />
      {count > 0 ? (
        <View style={styles.filterBadge}>
          <Text style={styles.filterBadgeText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A single applied facet under the bar; tapping it drops that facet. */
function AppliedFilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${label} filter`}
      style={({ pressed }) => [styles.appliedPill, pressed && { opacity: 0.7 }]}>
      <Text style={styles.appliedPillText} numberOfLines={1}>
        {label}
      </Text>
      <Ionicons name="close" size={13} color={colors.primary} />
    </Pressable>
  );
}

/** One selectable row inside a facet picker sheet. */
function PickerRow({
  label,
  icon,
  selected,
  onPress,
  multi = false,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
  /** Multi-select rows show a checkbox and combine with each other. */
  multi?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.7 }]}>
      <View
        style={[
          styles.pickerRowIcon,
          { backgroundColor: selected ? colors.primarySoft : colors.surfaceMuted },
        ]}>
        <Ionicons
          name={icon}
          size={18}
          color={selected ? colors.primary : colors.textSecondary}
        />
      </View>
      <Text style={[font.body, styles.pickerRowLabel]} numberOfLines={1}>
        {label}
      </Text>
      {multi ? (
        <Ionicons
          name={selected ? 'checkbox' : 'square-outline'}
          size={20}
          color={selected ? colors.primary : colors.textTertiary}
        />
      ) : selected ? (
        <Ionicons name="checkmark" size={20} color={colors.primary} />
      ) : null}
    </Pressable>
  );
}

/**
 * The first step of Advanced Search: one question at a time. Single-select —
 * picking a question swaps the filter sections below it, so only filters that
 * can answer the chosen question are ever on screen.
 */
function ModeRow({
  mode,
  selected,
  onPress,
}: {
  mode: SearchMode;
  selected: boolean;
  onPress: () => void;
}) {
  const meta = MODE_META[mode];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.modeRow, pressed && { opacity: 0.7 }]}>
      <View
        style={[
          styles.pickerRowIcon,
          { backgroundColor: selected ? colors.primarySoft : colors.surfaceMuted },
        ]}>
        <Ionicons
          name={meta.icon}
          size={18}
          color={selected ? colors.primary : colors.textSecondary}
        />
      </View>
      <View style={styles.modeRowText}>
        <Text
          style={[styles.modeRowTitle, selected && { color: colors.primary }]}
          numberOfLines={2}>
          {meta.title}
        </Text>
        <Text style={styles.modeRowHelper} numberOfLines={2}>
          {meta.helper}
        </Text>
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={selected ? colors.primary : colors.textTertiary}
      />
    </Pressable>
  );
}

/** Text field used inside a Filters-page dropdown. */
function FieldInput({
  placeholder,
  value,
  onChangeText,
  onClear,
}: {
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
}) {
  return (
    <View style={styles.fieldInputWrap}>
      <TextInput
        style={styles.fieldInput}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        value={value}
        onChangeText={onChangeText}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="done"
      />
      {value.length > 0 ? (
        <Pressable onPress={onClear} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────
// Result Card
// ──────────────────────────────────────────

/** Secondary line under a result title, adapted to the result kind. */
function resultSubtitle(result: SearchResult): string {
  if (result.kind === 'item') {
    const room = result.room_name ?? '';
    const box = result.box_number ? `Box ${result.box_number}` : '';
    return [room, box].filter(Boolean).join(' · ');
  }
  if (result.kind === 'box') {
    return result.room_name ?? result.move_name;
  }
  // room
  return result.move_name;
}

function SearchResultCard({
  result,
  query,
  onPress,
}: {
  result: SearchResult;
  query: string;
  onPress: () => void;
}) {
  const meta = KIND_META[result.kind];
  // Box results lead with the box's photo when it has one; items/rooms keep
  // their kind icon (an item row showing its box's photo reads as the wrong
  // entity).
  const thumb = result.kind === 'box' ? result.photo_url : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.resultCard, pressed && { opacity: 0.7 }]}>
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.resultThumb} />
      ) : (
        <View style={styles.resultIcon}>
          <Ionicons name={meta.icon} size={18} color={colors.primary} />
        </View>
      )}
      <View style={styles.resultInfo}>
        <HighlightedText text={result.title} query={query} />
        <Text style={styles.resultSubtitle} numberOfLines={1}>
          {resultSubtitle(result)}
        </Text>
      </View>
      <View style={styles.resultBadge}>
        <Text style={styles.resultBadgeText} numberOfLines={1}>
          {result.move_name}
        </Text>
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────
// Recent search chip
// ──────────────────────────────────────────

function RecentChip({ term, onPress }: { term: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.recentChip, pressed && { opacity: 0.7 }]}>
      <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
      <Text style={styles.recentChipText} numberOfLines={1}>
        {term}
      </Text>
    </Pressable>
  );
}

// ──────────────────────────────────────────
// SearchWidget
// ──────────────────────────────────────────

// Pressable that can be driven by an Animated.Value (the focus scrim's fade).
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface SearchWidgetProps {
  /** Content to show when search is idle (e.g. rooms or boxes) */
  children: React.ReactNode;
  /** Active move id — scopes search to that move when provided */
  moveId?: string | null;
  /** Optional element pinned to the right end of the search bar (e.g. settings gear) */
  trailing?: React.ReactNode;
  /**
   * Row rendered ABOVE the search bar (mockup §1: the move-selector pill and
   * settings gear live there on Home). Stays fixed with the bar; hidden while
   * results are shown so search results get the full page.
   */
  header?: React.ReactNode;
}

export default function SearchWidget({ children, moveId, trailing, header }: SearchWidgetProps) {
  const user = useAuthStore((state) => state.user);
  const setPendingRoomSelect = useUiStore((s) => s.setPendingRoomSelect);
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [previewResult, setPreviewResult] = useState<SearchResult | null>(null);

  // ── Filters ──────────────────────────────
  // Committed filters (written by the Filters page on "Show results").
  const [boxNumber, setBoxNumber] = useState('');
  const [location, setLocation] = useState('');
  const [photoState, setPhotoState] = useState<PhotoState>('any');
  const [boxStates, setBoxStates] = useState<BoxState[]>([]);
  const [packedBy, setPackedBy] = useState<PackedByFilter | null>(null);
  /** Which question the COMMITTED filters belong to (set by "Show results"). */
  const [mode, setMode] = useState<SearchMode>(lastSearchMode);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
  /** Apply came from "What's in a box" → open the box it resolves to. */
  const [autoOpenBox, setAutoOpenBox] = useState(false);
  /** Transient page message, floated above the footer (see showToast). */
  const [toast, setToast] = useState<string | null>(null);

  const me = user?.id ?? null;
  // The committed "Packed by" only applies inside the move it was chosen in.
  const activePackedBy =
    packedBy && packedBy.moveId === moveId ? packedBy.userId : 'any';

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Rooms (Location text) ────────────────
  // Shares the ['rooms', moveId] cache entry with the Move screen, so opening
  // a move then searching there costs no extra request.
  const { data: filterRooms } = useQuery({
    queryKey: ['rooms', moveId ?? 'none'],
    queryFn: () => fetchRooms(moveId!),
    enabled: !!moveId && (isFocused || filtersOpen || location.trim() !== ''),
    staleTime: ROOM_STALE_MS,
  });

  // ── Move members ("Packed by" picker) ────
  // Shares the ['members', moveId] cache entry with the Move screen. Only
  // fetched while the Filters page is open or a member filter is applied, so
  // ordinary searching costs no extra request.
  const { data: filterMembers } = useQuery({
    queryKey: ['members', moveId ?? 'none'],
    queryFn: () => fetchMembers(moveId!),
    enabled: !!moveId && (filtersOpen || activePackedBy !== 'any'),
    staleTime: MEMBERS_STALE_MS,
  });

  /** Display name for a "Packed by" user — "You" for the current user. */
  const memberLabel = useCallback(
    (userId: string) =>
      userId === me
        ? 'You'
        : filterMembers?.find((m) => m.user_id === userId)?.name ?? 'Member',
    [filterMembers, me],
  );

  // Location is free text, so resolve it against the move's room names. While
  // the rooms list is still loading we return null (no filter) rather than an
  // empty array, so a slow load can never blank the results.
  const resolvedRoomIds = useMemo(() => {
    const text = location.trim().toLowerCase();
    if (!text || !filterRooms) return null;
    return filterRooms
      .filter((room) => room.name.toLowerCase().includes(text))
      .map((room) => room.id);
  }, [location, filterRooms]);

  const hasActiveFilters =
    boxNumber.trim() !== '' ||
    location.trim() !== '' ||
    photoState !== 'any' ||
    boxStates.length > 0 ||
    activePackedBy !== 'any';

  // Search runs when there is text OR at least one filter (filter-only
  // browsing — "show me boxes with pictures" with nothing typed).
  const isSearching = debouncedSearch.length > 0 || hasActiveFilters;

  const filters = useMemo<SearchFilters>(
    () => ({
      kinds: MODE_KINDS[mode],
      roomIds: resolvedRoomIds,
      boxNumber,
      photoState,
      boxStates,
      packedBy: activePackedBy,
    }),
    [mode, resolvedRoomIds, boxNumber, photoState, boxStates, activePackedBy],
  );

  // ── Load recent searches on mount ──
  useEffect(() => {
    loadRecentSearches()
      .then(setRecentSearches)
      .catch(() => {});
  }, []);

  // ── Debounce the search input by 200ms ──
  const handleSearchChange = useCallback((text: string) => {
    setSearchText(text);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(text.trim());
    }, 200);
  }, []);

  // Cleanup debounce + toast timers on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // ── Query ────────────────────────────────
  const {
    data: results,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      'search-inventory',
      debouncedSearch,
      moveId ?? 'all',
      user?.id,
      resolvedRoomIds?.join(',') ?? 'all',
      boxNumber.trim(),
      photoState,
      boxStates.join(','),
      mode,
      activePackedBy,
    ],
    queryFn: () => searchInventory(debouncedSearch, moveId, filters),
    enabled: isSearching && !!user,
    gcTime: 0, // Don't cache search results across different queries
  });

  // ── Skeleton pulse ───────────────────────
  const skeletonOpacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(skeletonOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(skeletonOpacity, { toValue: 0.4, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [skeletonOpacity]);

  // ── Clear ────────────────────────────────
  // Exiting the search resets EVERYTHING (text + filters) so the next search
  // never inherits a stale filter the user forgot about.
  const handleClear = useCallback(() => {
    setSearchText('');
    setDebouncedSearch('');
    setIsFocused(false);
    setBoxNumber('');
    setLocation('');
    setPhotoState('any');
    setBoxStates([]);
    setPackedBy(null);
    setFiltersOpen(false);
    setAutoOpenBox(false);
    inputRef.current?.blur();
  }, []);

  /** Clear filters only — keeps the typed term. */
  const clearFilters = useCallback(() => {
    setBoxNumber('');
    setLocation('');
    setPhotoState('any');
    setBoxStates([]);
    setPackedBy(null);
  }, []);

  // ── Filters page ─────────────────────────
  // The page edits a DRAFT so several fields can be changed before one query
  // runs. Apply commits it; Clear all resets it in place.  // `forced` jumps straight to a question (the empty state offers the other
  // one); otherwise a typed term means the item question, and an untouched
  // bar reopens the last question the user looked at.
  const openFilters = useCallback(
    (forced?: SearchMode) => {
      const nextMode: SearchMode =
        forced ?? (searchText.trim() !== '' ? 'item' : lastSearchMode);
      // Seed from what is currently applied. The search bar term IS the
      // "Item name" field, so the two can never disagree. Filters are seeded
      // into the question that owns them only, so the other one starts clean.
      const committedItem = mode === 'item';
      lastSearchMode = nextMode;
      // A message from the previous visit must not reappear as a ghost.
      setToast(null);
      setDraft({
        mode: nextMode,
        itemName: searchText,
        itemLocation: committedItem ? location : '',
        photoState: committedItem ? photoState : 'any',
        boxStates: committedItem ? boxStates : [],
        packedBy: committedItem ? activePackedBy : 'any',
        boxNumber: committedItem ? '' : boxNumber,
        boxLocation: committedItem ? '' : location,
      });
      setFiltersOpen(true);
    },
    [searchText, mode, boxNumber, location, photoState, boxStates, activePackedBy],
  );

  // ── Toast ────────────────────────────────
  // Short-lived message floating above the footer, used for the one thing the
  // page refuses to do: search with nothing filled in.
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  /** True when the ACTIVE question has nothing filled in. */
  const draftIsEmpty =
    draft.mode === 'item'
      ? draft.itemName.trim() === '' &&
        draft.itemLocation.trim() === '' &&
        draft.photoState === 'any' &&
        draft.boxStates.length === 0 &&
        draft.packedBy === 'any'
      : draft.boxNumber.trim() === '' && draft.boxLocation.trim() === '';

  const applyFilters = useCallback(() => {
    // Nothing filled in → do NOT search. The database refuses an unfiltered
    // query outright (it would dump the whole inventory), so the rule is
    // stated with a toast instead of failing silently.
    if (draftIsEmpty) {
      showToast('Select at least one filter to search');
      return;
    }

    // Only the active question's filters are committed — the other question's
    // values are dropped, so a filter can never silently narrow a search it
    // does not belong to.
    const itemMode = draft.mode === 'item';
    setBoxNumber(itemMode ? '' : draft.boxNumber.trim());
    setLocation(itemMode ? draft.itemLocation.trim() : draft.boxLocation.trim());
    setPhotoState(itemMode ? draft.photoState : 'any');
    setBoxStates(itemMode ? draft.boxStates : []);
    setPackedBy(
      itemMode && draft.packedBy !== 'any' && moveId
        ? { moveId, userId: draft.packedBy }
        : null,
    );

    // The bar's term IS the item-name filter. Box mode answers a different
    // question, so the term is dropped instead of intersecting with it.
    if (itemMode) {
      handleSearchChange(draft.itemName);
    } else {
      setSearchText('');
      setDebouncedSearch('');
    }

    setMode(draft.mode);
    lastSearchMode = draft.mode;
    // "What's in a box" was used → open the box it lands on.
    setAutoOpenBox(!itemMode);
    setFiltersOpen(false);
  }, [draft, draftIsEmpty, handleSearchChange, moveId, showToast]);

  /**
   * "Clear all" clears the question on screen only — the other question's
   * draft is kept, so switching back does not punish the user for tidying up.
   */
  const clearDraft = useCallback(
    () =>
      setDraft((d) =>
        d.mode === 'item'
          ? {
              ...DEFAULT_DRAFT,
              mode: d.mode,
              boxNumber: d.boxNumber,
              boxLocation: d.boxLocation,
            }
          : {
              ...DEFAULT_DRAFT,
              mode: d.mode,
              itemName: d.itemName,
              itemLocation: d.itemLocation,
              photoState: d.photoState,
              boxStates: d.boxStates,
              packedBy: d.packedBy,
            },
      ),
    [],
  );

  // ── Question selector ───────────────────
  // Switching is instant and non-destructive: each question keeps its own
  // draft values until "Show results" commits one of them.
  const selectMode = useCallback((next: SearchMode) => {
    lastSearchMode = next;
    setDraft((d) => ({ ...d, mode: next }));
  }, []);

  // ── Filters-page pickers ─────────────────
  // Box status is multi-select (an OR over the three states: {empty, packing}
  // reads as "everything left to pack").
  const toggleDraftBoxState = useCallback((state: BoxState) => {
    setDraft((d) => ({
      ...d,
      boxStates: d.boxStates.includes(state)
        ? d.boxStates.filter((s) => s !== state)
        : [...d.boxStates, state],
    }));
  }, []);

  // ── Open preview sheet for a result ──────
  const handleResultPress = useCallback(
    (result: SearchResult) => {
      setPreviewResult(result);
      if (debouncedSearch) {
        addRecentSearch(debouncedSearch)
          .then(setRecentSearches)
          .catch(() => {});
      }
    },
    [debouncedSearch],
  );

  // ── Run a recent search term ─────────────
  const handleRecentPress = useCallback(
    (term: string) => {
      setSearchText(term);
      setDebouncedSearch(term);
      inputRef.current?.focus();
    },
    [],
  );

  // Close the preview sheet (BottomSheet animates the dismissal itself).
  const closePreview = useCallback(() => setPreviewResult(null), []);

  // ── Open Box / Open Room from preview ────
  // "Open Room" does NOT navigate — rooms are browsed on the Home screen
  // (room tiles + selected room's boxes live there). It closes the search UI,
  // dismisses any stacked screens back to Home, and requests that Home select
  // the room, exactly as if its tile had been tapped.
  // "Open Box" navigates to the box screen on top of Home.
  const navigateFromPreview = useCallback(
    (pathname: '/box/[id]' | '/room/[id]', id: string) => {
      setPreviewResult(null);
      setSearchText('');
      setDebouncedSearch('');
      setIsFocused(false);
      inputRef.current?.blur();

      const closeSearch = () => {
        // Pop stacked screens back to Home only when something is actually
        // stacked — dismissAll() from the Home root is an unhandled POP_TO_TOP.
        if (router.canDismiss()) router.dismissAll();
      };

      // Small delay so the sheet dismisses before navigation
      setTimeout(() => {
        if (pathname === '/room/[id]') {
          setPendingRoomSelect(id);
          closeSearch();
        } else {
          closeSearch();
          router.navigate({ pathname, params: { id } });
        }
      }, 200);
    },
    [setPendingRoomSelect],
  );

  // ── "What's in the box" → open the matched box ──
  // Once results land, a LONE box match jumps straight into that box (which
  // is what "what's in the box" means). Several matches keep the results list
  // so the user can choose.
  useEffect(() => {
    if (!autoOpenBox || !results) return;
    setAutoOpenBox(false);
    const boxMatches = results.filter((r) => r.kind === 'box');
    if (boxMatches.length === 1) {
      handleClear();
      navigateFromPreview('/box/[id]', boxMatches[0].entity_id);
    }
  }, [autoOpenBox, results, handleClear, navigateFromPreview]);

  const renderResult = useCallback(
    ({ item }: { item: SearchResult }) => (
      <SearchResultCard
        result={item}
        query={debouncedSearch}
        onPress={() => handleResultPress(item)}
      />
    ),
    [debouncedSearch, handleResultPress],
  );

  const keyExtractor = useCallback((item: SearchResult) => `${item.kind}:${item.entity_id}`, []);

  const hasResults = !!results && results.length > 0;
  const showRecentStrip = isFocused && !isSearching && recentSearches.length > 0;

  // ── Applied filters ──────────────────────
  // One removable pill per applied filter — the fastest way to widen a search
  // without reopening the whole Filters page.
  const appliedPills: { key: string; label: string; clear: () => void }[] = [];
  if (boxNumber.trim()) {
    appliedPills.push({
      key: 'box',
      label: `Box ${boxNumber.trim()}`,
      clear: () => setBoxNumber(''),
    });
  }
  if (location.trim()) {
    appliedPills.push({
      key: 'location',
      label: location.trim(),
      clear: () => setLocation(''),
    });
  }
  if (photoState !== 'any') {
    appliedPills.push({
      key: 'photo',
      label: photoState === 'with' ? 'With picture' : 'No picture',
      clear: () => setPhotoState('any'),
    });
  }
  if (boxStates.length > 0) {
    appliedPills.push({
      key: 'boxStates',
      label: boxStates.map((s) => BOX_STATE_LABEL[s]).join(', '),
      clear: () => setBoxStates([]),
    });
  }
  if (activePackedBy !== 'any') {
    appliedPills.push({
      key: 'packedBy',
      label: `Packed by ${memberLabel(activePackedBy)}`,
      clear: () => setPackedBy(null),
    });
  }
  const activeFilterCount = appliedPills.length;

  // ── Background dim on focus ───────────────
  // A dark scrim fades in OVER the page when the search bar is focused and no
  // search is running yet — an opacity fade on the content itself is
  // invisible here because the UI is white cards on a near-white background.
  // The scrim lives inside the content area only, so the search bar, the
  // applied-filter pills and the recent strip stay bright, and it clears as
  // soon as results are shown.
  const dimmed = isFocused && !isSearching;
  const contentFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(contentFade, {
      toValue: dimmed ? 0.45 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [dimmed, contentFade]);

  // ── Hardware back dismisses search first ──
  // While the search UI is active (focused, typed, or filtered), the Android
  // back button clears/exits the search instead of leaving the app. The
  // Filters page is a Modal, which consumes back itself via onRequestClose.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (filtersOpen) {
        setFiltersOpen(false);
        return true;
      }
      if (isFocused || isSearching) {
        handleClear();
        return true; // consumed — don't exit the app
      }
      return false;
    });
    return () => sub.remove();
  }, [filtersOpen, isFocused, isSearching, handleClear]);

  return (
    <View style={styles.container}>
      {/* ── Screen header row (above the bar; Home only) ── */}
      {header && !isSearching ? (
        <View style={styles.headerSlot}>{header}</View>
      ) : null}

      {/* ── Search Bar ──────────────────────── */}
      <View style={styles.searchBarWrapper}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
          <TextInput
            ref={inputRef}
            style={styles.searchInput}
            placeholder={
              mode === 'box'
                ? 'Search box numbers...'
                : 'Search items, boxes, rooms...'
            }
            placeholderTextColor={colors.textTertiary}
            value={searchText}
            onChangeText={handleSearchChange}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            maxLength={200}
          />
          {searchText.length > 0 && (
            <Pressable
              onPress={handleClear}
              style={({ pressed }) => [
                styles.clearButton,
                pressed && { opacity: 0.7 },
              ]}>
              <Ionicons name="close-outline" size={16} color={colors.textSecondary} />
            </Pressable>
          )}
          <FilterButton count={activeFilterCount} onPress={() => openFilters()} />
          {trailing}
        </View>
      </View>

      {/* ── Applied filters (removable) ─────── */}
      {appliedPills.length > 0 && (
        <View style={styles.appliedWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.appliedRow}
            keyboardShouldPersistTaps="handled">
            {appliedPills.map((pill) => (
              <AppliedFilterPill key={pill.key} label={pill.label} onRemove={pill.clear} />
            ))}
            {appliedPills.length > 1 && (
              <Pressable
                onPress={clearFilters}
                style={({ pressed }) => [styles.clearAllPill, pressed && { opacity: 0.7 }]}>
                <Text style={styles.clearAllPillText}>Clear all</Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
      )}

      {/* ── Recent Searches Strip (focused & idle) ── */}
      {showRecentStrip && (
        <View style={styles.recentStrip}>
          <View style={styles.recentStripHeader}>
            <Text style={styles.recentStripLabel}>Recent</Text>
            <Pressable
              onPress={() => {
                clearRecentSearches().catch(() => {});
                setRecentSearches([]);
              }}
              style={({ pressed }) => [styles.recentClearBtn, pressed && { opacity: 0.7 }]}
              hitSlop={8}>
              <Text style={styles.recentClearText}>Clear</Text>
            </Pressable>
          </View>
          <FlatList
            horizontal
            data={recentSearches}
            keyExtractor={(term) => term}
            renderItem={({ item }) => (
              <View style={styles.recentChipWrap}>
                <RecentChip term={item} onPress={() => handleRecentPress(item)} />
              </View>
            )}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        </View>
      )}

      {/* ── Content ──────────────────────────── */}
      <View style={styles.contentArea}>
        {/* Search is active and loading */}
        {isSearching && isLoading && (
          <View style={styles.skeletonList}>
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
          </View>
        )}

        {/* Search is active and errored */}
        {isSearching && error && (
          <View style={styles.centeredContent}>
            <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              Could not search your inventory.
            </Text>
            <Pressable
              onPress={() => refetch()}
              style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.7 }]}>
              <Text style={{ color: colors.primary }}>Tap to retry</Text>
            </Pressable>
          </View>
        )}

        {/* Search is active and has results */}
        {isSearching && !isLoading && !error && hasResults && (
          <FlatList
            data={results}
            renderItem={renderResult}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews={true}
            windowSize={10}
            maxToRenderPerBatch={10}
            ListHeaderComponent={
              <View style={styles.resultsHeader}>
                <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] }}>
                  {results.length} {results.length === 1 ? 'result' : 'results'}
                </Text>
              </View>
            }
          />
        )}

        {/* Search is active but nothing matched */}
        {isSearching && !isLoading && !error && !hasResults && (
          <View style={styles.centeredContent}>
            <Ionicons name="search-outline" size={48} color={colors.textTertiary} />
            <Text style={[font.headline, { color: colors.textSecondary, marginTop: spacing.md }]}>
              Nothing found
            </Text>
            <Text style={[font.body, { color: colors.textTertiary, textAlign: 'center' }]}>
              {hasActiveFilters
                ? 'No matches with these filters. Try widening them.'
                : `Try checking the spelling, or use\nfewer words.`}
            </Text>

            {hasActiveFilters && (
              <Pressable
                onPress={clearFilters}
                style={({ pressed }) => [styles.clearFiltersBtn, pressed && { opacity: 0.7 }]}>
                <Ionicons name="close-outline" size={16} color={colors.primary} />
                <Text style={styles.clearFiltersText}>Clear filters</Text>
              </Pressable>
            )}

            {/* 0 item matches — the other question may be the one they meant */}
            {mode === 'item' && (
              <Pressable
                onPress={() => openFilters('box')}
                style={({ pressed }) => [styles.clearFiltersBtn, pressed && { opacity: 0.7 }]}>
                <Ionicons name="archive-outline" size={16} color={colors.primary} />
                <Text style={styles.clearFiltersText}>See inside a box</Text>
              </Pressable>
            )}

            {recentSearches.length > 0 && (
              <>
                <Text style={[styles.recentStripLabel, { marginTop: spacing.xl }]}>
                  Try a recent search
                </Text>
                <View style={styles.recentChipWrap}>
                  {recentSearches.slice(0, 4).map((term) => (
                    <RecentChip key={term} term={term} onPress={() => handleRecentPress(term)} />
                  ))}
                </View>
              </>
            )}
          </View>
        )}

        {/* Search is idle — show original content; taps blocked while the
            search UI is the active layer */}
        {!isSearching && (
          <Animated.View style={styles.contentFade} pointerEvents={dimmed ? 'none' : 'auto'}>
            {children}
          </Animated.View>
        )}

        {/* ── Focus scrim — dark wash fading over the page. Tapping it
            dismisses the search; it only captures touches while visible. ── */}
        <AnimatedPressable
          onPress={handleClear}
          pointerEvents={dimmed ? 'auto' : 'none'}
          style={[styles.focusScrim, { opacity: contentFade }]}
        />
      </View>

      {/* ── Filters page (full screen) ──────── */}
      <Modal
        visible={filtersOpen}
        animationType="slide"
        onRequestClose={() => setFiltersOpen(false)}
        statusBarTranslucent>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <SafeAreaView style={styles.filtersPage} edges={['top', 'bottom']}>
            <View style={styles.filtersHeader}>
              <Text style={styles.filtersTitle}>Advanced Search</Text>
              <Pressable
                onPress={() => setFiltersOpen(false)}
                hitSlop={10}
                style={({ pressed }) => pressed && { opacity: 0.6 }}>
                <Ionicons name="close-outline" size={26} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={styles.filtersBody}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {/* ── Step 1: which question? ──────── */}
              <Text style={styles.filterSectionTitle}>What do you want to know?</Text>
              <View style={styles.filterSectionCard}>
                <ModeRow
                  mode="item"
                  selected={draft.mode === 'item'}
                  onPress={() => selectMode('item')}
                />
                <View style={styles.filterDivider} />
                <ModeRow
                  mode="box"
                  selected={draft.mode === 'box'}
                  onPress={() => selectMode('box')}
                />
              </View>

              {draft.mode === 'item' ? (
                <>
                  {/* ── Which box is my item in? ─── */}
                  <Text style={styles.filterSectionTitle}>The item</Text>
                  <View style={styles.filterSectionCard}>
                    <CollapsibleSection
                      icon="text-outline"
                      title="Item name"
                      meta={draft.itemName.trim() || undefined}
                      defaultOpen={false}>
                      <FieldInput
                        placeholder="Type an item name"
                        value={draft.itemName}
                        onChangeText={(t) => setDraft((d) => ({ ...d, itemName: t }))}
                        onClear={() => setDraft((d) => ({ ...d, itemName: '' }))}
                      />
                    </CollapsibleSection>

                    <View style={styles.filterDivider} />

                    <CollapsibleSection
                      icon="image-outline"
                      title="Item with picture"
                      meta={PHOTO_LABEL[draft.photoState]}
                      defaultOpen={false}>
                      <PickerRow
                        label="With picture"
                        icon="image-outline"
                        selected={draft.photoState === 'with'}
                        onPress={() =>
                          setDraft((d) => ({
                            ...d,
                            photoState: d.photoState === 'with' ? 'any' : 'with',
                          }))
                        }
                      />
                      <PickerRow
                        label="No picture"
                        icon="image-outline"
                        selected={draft.photoState === 'without'}
                        onPress={() =>
                          setDraft((d) => ({
                            ...d,
                            photoState: d.photoState === 'without' ? 'any' : 'without',
                          }))
                        }
                      />
                    </CollapsibleSection>
                  </View>

                  <Text style={styles.filterSectionTitle}>Where it might be</Text>
                  <View style={styles.filterSectionCard}>
                    <CollapsibleSection
                      icon="location-outline"
                      title="Location"
                      meta={draft.itemLocation.trim() || undefined}
                      defaultOpen={false}>
                      <FieldInput
                        placeholder="Type a room name"
                        value={draft.itemLocation}
                        onChangeText={(t) => setDraft((d) => ({ ...d, itemLocation: t }))}
                        onClear={() => setDraft((d) => ({ ...d, itemLocation: '' }))}
                      />
                    </CollapsibleSection>

                    <View style={styles.filterDivider} />

                    <CollapsibleSection
                      icon="cube-outline"
                      title="Box status"
                      meta={boxStatesLabel(draft.boxStates)}
                      defaultOpen={false}>
                      <PickerRow
                        label="Empty"
                        icon="cube-outline"
                        multi
                        selected={draft.boxStates.includes('empty')}
                        onPress={() => toggleDraftBoxState('empty')}
                      />
                      <PickerRow
                        label="Packing"
                        icon="time-outline"
                        multi
                        selected={draft.boxStates.includes('packing')}
                        onPress={() => toggleDraftBoxState('packing')}
                      />
                      <PickerRow
                        label="Packed"
                        icon="checkmark-circle-outline"
                        multi
                        selected={draft.boxStates.includes('packed')}
                        onPress={() => toggleDraftBoxState('packed')}
                      />
                    </CollapsibleSection>

                    {moveId ? (
                      <>
                        <View style={styles.filterDivider} />

                        <CollapsibleSection
                          icon="people-outline"
                          title="Packed by"
                          meta={draft.packedBy === 'any' ? undefined : memberLabel(draft.packedBy)}
                          defaultOpen={false}>
                          <PickerRow
                            label="Anyone"
                            icon="people-outline"
                            selected={draft.packedBy === 'any'}
                            onPress={() => setDraft((d) => ({ ...d, packedBy: 'any' }))}
                          />
                          {me ? (
                            <PickerRow
                              label="You"
                              icon="person-outline"
                              selected={draft.packedBy === me}
                              onPress={() =>
                                setDraft((d) => ({
                                  ...d,
                                  packedBy: d.packedBy === me ? 'any' : me,
                                }))
                              }
                            />
                          ) : null}
                          {filterMembers
                            ?.filter((m) => m.user_id !== me)
                            .map((m) => (
                              <PickerRow
                                key={m.user_id}
                                label={m.name}
                                icon="person-outline"
                                selected={draft.packedBy === m.user_id}
                                onPress={() =>
                                  setDraft((d) => ({
                                    ...d,
                                    packedBy: d.packedBy === m.user_id ? 'any' : m.user_id,
                                  }))
                                }
                              />
                            ))}
                        </CollapsibleSection>
                      </>
                    ) : null}
                  </View>
                </>
              ) : (
                <>
                  {/* ── What's in a box? ─────────── */}
                  <Text style={styles.filterSectionTitle}>The box</Text>
                  <View style={styles.filterSectionCard}>
                    <CollapsibleSection
                      icon="archive-outline"
                      title="Box number"
                      meta={draft.boxNumber.trim() || undefined}
                      defaultOpen={false}>
                      <FieldInput
                        placeholder="e.g. 3"
                        value={draft.boxNumber}
                        onChangeText={(t) => setDraft((d) => ({ ...d, boxNumber: t }))}
                        onClear={() => setDraft((d) => ({ ...d, boxNumber: '' }))}
                      />
                    </CollapsibleSection>

                    <View style={styles.filterDivider} />

                    <CollapsibleSection
                      icon="location-outline"
                      title="Location"
                      meta={draft.boxLocation.trim() || undefined}
                      defaultOpen={false}>
                      <FieldInput
                        placeholder="Type a room name"
                        value={draft.boxLocation}
                        onChangeText={(t) => setDraft((d) => ({ ...d, boxLocation: t }))}
                        onClear={() => setDraft((d) => ({ ...d, boxLocation: '' }))}
                      />
                      <Text style={styles.fieldHint}>
                        Number unreadable? Leave Box number empty and pick a room to
                        list its boxes.
                      </Text>
                    </CollapsibleSection>
                  </View>
                </>
              )}
            </ScrollView>

            <View style={styles.filtersFooter}>
              <Pressable
                onPress={clearDraft}
                style={({ pressed }) => [
                  styles.filtersBtn,
                  styles.filtersBtnGhost,
                  pressed && { opacity: 0.7 },
                ]}>
                <Text style={styles.filtersBtnGhostText}>Clear all</Text>
              </Pressable>
              <Pressable
                onPress={applyFilters}
                style={({ pressed }) => [
                  styles.filtersBtn,
                  styles.filtersBtnPrimary,
                  pressed && { opacity: 0.85 },
                ]}>
                <Text style={styles.filtersBtnPrimaryText}>Show results</Text>
              </Pressable>
            </View>

            {/* ── Toast — floats above the footer without moving it ── */}
            {toast ? (
              <View
                style={[
                  styles.toast,
                  // Footer height + one gap, measured from the safe-area inset so
                  // the message clears the buttons on every device.
                  { bottom: insets.bottom + FILTERS_FOOTER_HEIGHT + spacing.md },
                ]}
                pointerEvents="none"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite">
                <Ionicons name="information-circle" size={16} color={colors.textInverse} />
                <Text style={styles.toastText}>{toast}</Text>
              </View>
            ) : null}
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Result Preview Bottom Sheet ─────── */}
      <BottomSheet
        visible={!!previewResult}
        onClose={closePreview}
        handleOnly
        sheetStyle={{ backgroundColor: colors.surface }}>
        {previewResult && (
              <>
                {/* ── What was found ─────────────── */}
                <BottomSheetDraggableArea>
                  <View style={styles.previewItemHeader}>
                    {previewResult.kind === 'box' && previewResult.photo_url ? (
                      <Image
                        source={{ uri: previewResult.photo_url }}
                        style={styles.previewItemPhoto}
                      />
                    ) : (
                      <View style={styles.previewItemIcon}>
                        <Ionicons
                          name={KIND_META[previewResult.kind].icon}
                          size={26}
                          color={colors.primary}
                        />
                      </View>
                    )}
                    <Text style={[font.title, { flex: 1 }]} numberOfLines={2}>
                      {previewResult.title}
                    </Text>
                  </View>
                </BottomSheetDraggableArea>

                {/* ── Found In ───────────────────── */}
                <Text style={styles.previewEyebrow}>FOUND IN</Text>

                <View style={[styles.previewRow, { backgroundColor: colors.surfaceMuted }]}>
                  <View style={[styles.previewRowIcon, { backgroundColor: colors.moveSoft }]}>
                    <Ionicons name="home-outline" size={18} color={colors.move} />
                  </View>
                  <View style={styles.previewRowInfo}>
                    <Text style={styles.previewRowLabel}>Move</Text>
                    <Text style={styles.previewRowValue} numberOfLines={1}>
                      {previewResult.move_name}
                    </Text>
                  </View>
                </View>

                {previewResult.room_name && (
                  <View style={[styles.previewRow, { backgroundColor: colors.surfaceMuted }]}>
                    <View style={[styles.previewRowIcon, { backgroundColor: colors.roomSoft }]}>
                      <Ionicons name="bed-outline" size={18} color={colors.room} />
                    </View>
                    <View style={styles.previewRowInfo}>
                      <Text style={styles.previewRowLabel}>Room</Text>
                      <Text style={styles.previewRowValue} numberOfLines={1}>
                        {previewResult.room_name}
                      </Text>
                    </View>
                  </View>
                )}

                {previewResult.box_number && (
                  <View style={[styles.previewRow, { backgroundColor: colors.surfaceMuted }]}>
                    <View style={[styles.previewRowIcon, { backgroundColor: colors.boxSoft }]}>
                      <Ionicons name="archive-outline" size={18} color={colors.box} />
                    </View>
                    <View style={styles.previewRowInfo}>
                      <Text style={styles.previewRowLabel}>Box</Text>
                      <Text style={styles.previewRowValue} numberOfLines={1}>
                        {previewResult.box_number}
                      </Text>
                    </View>
                  </View>
                )}

                {/* ── Actions (only what this result actually has) ── */}
                <View style={styles.previewActions}>
                  {previewResult.box_id && (
                    <Pressable
                      onPress={() => navigateFromPreview('/box/[id]', previewResult.box_id!)}
                      style={({ pressed }) => [
                        styles.previewActionBtn,
                        { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
                      ]}>
                      <Ionicons name="archive-outline" size={18} color="#FFFFFF" />
                      <Text style={styles.previewActionText}>Open Box</Text>
                    </Pressable>
                  )}
                  {previewResult.room_id && (
                    <Pressable
                      onPress={() => navigateFromPreview('/room/[id]', previewResult.room_id!)}
                      style={({ pressed }) => [
                        styles.previewActionBtn,
                        styles.previewActionBtnSecondary,
                        pressed && { opacity: 0.7 },
                      ]}>
                      <Ionicons name="bed-outline" size={18} color={colors.primary} />
                      <Text style={[styles.previewActionText, { color: colors.primary }]}>
                        Open Room
                      </Text>
                    </Pressable>
                  )}
                </View>

                {/* ── Cancel ─────────────────────── */}
                <View style={[styles.previewCancelSection, { backgroundColor: colors.surfaceMuted }]}>
                  <Pressable
                    style={({ pressed }) => [styles.previewCancelRow, pressed && { opacity: 0.7 }]}
                    onPress={closePreview}>
                    <Text style={styles.previewCancelText}>Cancel</Text>
                  </Pressable>
                </View>
              </>
            )}
      </BottomSheet>
    </View>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  // ── Screen header row (above the bar) ──
  headerSlot: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },

  // ── Search Bar ─────────────────────────
  searchBarWrapper: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    height: 48,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 22,
    // No vertical padding (the pill's height does the centering) and Android
    // gravity pinned to centre so the query never rides high in the field.
    paddingVertical: 0,
    textAlignVertical: 'center',
    color: colors.textPrimary,
  },
  clearButton: {
    padding: spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Applied filter pills ───────────────
  appliedWrap: {
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  appliedRow: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
    alignItems: 'center',
  },
  appliedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primarySoft,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderCurve: 'continuous',
  },
  appliedPillText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 13,
    color: colors.primary,
    maxWidth: 160,
  },
  clearAllPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  clearAllPillText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 13,
    color: colors.textSecondary,
  },

  // ── Filters button (in the search bar) ──
  filterButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadge: {
    position: 'absolute',
    top: -3,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },

  // ── Filters page ───────────────────────
  filtersPage: {
    flex: 1,
    backgroundColor: colors.background,
  },
  filtersHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  filtersTitle: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 26,
    color: colors.textPrimary,
  },
  filtersBody: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  filterSectionTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  filterSectionCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    borderCurve: 'continuous',
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  filterDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    // Indents the hairline to the row label (icon 20 + header gap 12).
    marginLeft: 32,
  },
  filtersFooter: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.divider,
    backgroundColor: colors.background,
  },

  // ── Page toast ─────────────────────────
  // Floats one gap above the footer (the offset is set inline, because it
  // depends on the device's safe-area inset). It never covers and never moves
  // the buttons.
  toast: {
    position: 'absolute',
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.navy,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderCurve: 'continuous',
    ...shadow.card,
  },
  toastText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 14,
    color: colors.textInverse,
  },
  filtersBtn: {
    flex: 1,
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  filtersBtnGhost: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  filtersBtnGhostText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 15,
    color: colors.textPrimary,
  },
  filtersBtnPrimary: {
    backgroundColor: colors.primary,
  },
  filtersBtnPrimaryText: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 15,
    color: '#FFFFFF',
  },

  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  pickerRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  pickerRowLabel: {
    flex: 1,
  },

  // ── Question selector row ("What do you want to know?") ──
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  modeRowText: {
    flex: 1,
    gap: 2,
  },
  modeRowTitle: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 15,
    color: colors.textPrimary,
  },
  modeRowHelper: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },

  /** Hint under a dropdown field (e.g. browsing a room's boxes). */
  fieldHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textTertiary,
    marginTop: -spacing.xs,
    marginBottom: spacing.md,
  },

  // ── Text field inside a Filters-page dropdown ──
  fieldInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // White field with hairline border — same language as TextField.
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    height: 48,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    borderCurve: 'continuous',
  },
  fieldInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    paddingVertical: 0,
    textAlignVertical: 'center',
    color: colors.textPrimary,
  },
  // ── Recent Strip ───────────────────────
  recentStrip: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  recentStripHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  recentStripLabel: {
    fontSize: 12,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textTertiary,
    textTransform: 'uppercase',
  },
  recentClearBtn: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  recentClearText: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  recentChipWrap: {
    marginRight: spacing.sm,
    paddingBottom: 2,
  },
  recentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderCurve: 'continuous',
  },
  recentChipText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textPrimary,
    maxWidth: 160,
  },

  // ── Content Area ───────────────────────
  contentArea: {
    flex: 1,
  },
  contentFade: {
    flex: 1,
  },
  // Dark wash over the page while the search bar holds focus. Sits above the
  // content (last child of contentArea) but below the search bar/chips/recent
  // strip (they are outside this view), so only the page dims.
  focusScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#171A2E',
  },

  // ── Centered Content ───────────────────
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  clearFiltersBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.primarySoft,
    borderCurve: 'continuous',
  },
  clearFiltersText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 14,
    color: colors.primary,
  },

  // ── Results ────────────────────────────
  listContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  resultsHeader: {
    marginBottom: spacing.xs,
  },
  skeletonList: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
    gap: spacing.sm,
  },

  // ── Result Card ────────────────────────
  resultCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
    borderCurve: 'continuous',
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  resultIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resultThumb: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
  },
  resultInfo: {
    flex: 1,
    gap: 2,
  },
  resultTitle: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  resultTitleMatch: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  resultSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  resultBadge: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    maxWidth: 120,
  },
  resultBadgeText: {
    fontSize: 11,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
  },

  // ── Skeleton ───────────────────────────
  skeletonLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.surfaceMuted,
    marginVertical: 4,
  },

  // ── Misc ───────────────────────────────
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  previewItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  previewItemIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  previewItemPhoto: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.surfaceMuted,
  },
  previewEyebrow: {
    fontSize: 12,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textTertiary,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderCurve: 'continuous',
  },
  previewRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  previewRowInfo: {
    flex: 1,
    gap: 1,
  },
  previewRowLabel: {
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  previewRowValue: {
    fontSize: 16,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  previewActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  previewActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 52,
    borderRadius: 14,
    borderCurve: 'continuous',
  },
  previewActionBtnSecondary: {
    backgroundColor: colors.primarySoft,
  },
  previewActionText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
  previewCancelSection: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.lg,
    borderRadius: 14,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  previewCancelRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  previewCancelText: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
  },
});
