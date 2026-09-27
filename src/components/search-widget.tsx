// components/search-widget.tsx
// Reusable search widget that wraps screen content.
// The search bar is always visible at the top.
// When search is active (user has typed), search results replace the wrapped children.
// When search is idle, the original children content is visible.
// Nothing scrolls behind the search bar — it stays fixed at the top.
//
// Improvements (migration 008):
//   - Typo-tolerant matching handled server-side (pg_trgm)
//   - Search is scoped to the active move when `moveId` is provided
//   - 200ms debounce + skeleton rows while loading
//   - Matched text is highlighted inside result titles
//   - Recent searches (chips) stored locally
//   - Tapping a result opens a preview "report" bottom sheet (Move → Room → Box)
//     with Open Box / Open Room actions instead of jumping straight into a box.

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, fonts } from '../../packly-ui/theme';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/auth-store';
import { useUiStore } from '@/store/ui-store';
import {
  loadRecentSearches,
  addRecentSearch,
  clearRecentSearches,
} from '@/services/recent-searches';

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

interface SearchResult {
  item_id: string;
  item_name: string;
  box_id: string;
  box_number: string;
  room_id: string;
  room_name: string;
  move_id: string;
  move_name: string;
}

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function searchItems(
  searchTerm: string,
  moveId: string | null | undefined,
): Promise<SearchResult[]> {
  if (!searchTerm.trim()) return [];

  const params: Record<string, unknown> = { search_term: searchTerm.trim() };
  // Scope to the active move when on a move/room/home screen.
  // NULL (omitted) falls back to "all moves the user is a member of".
  // The RPC parameter is move_scope_id (see migration 008).
  if (moveId) params.move_scope_id = moveId;

  const { data, error } = await supabase.rpc('search_user_items', params);

  if (error) {
    console.error('[SEARCH ERROR]', error.message, error.code, error.details);
    throw new Error(error.message);
  }

  return (data ?? []) as SearchResult[];
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
// Result Card
// ──────────────────────────────────────────

function SearchResultCard({
  result,
  query,
  onPress,
}: {
  result: SearchResult;
  query: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.resultCard, pressed && { opacity: 0.7 }]}>
      <View style={styles.resultIcon}>
        <Ionicons name="cube-outline" size={18} color={colors.primary} />
      </View>
      <View style={styles.resultInfo}>
        <HighlightedText text={result.item_name} query={query} />
        <Text style={styles.resultSubtitle} numberOfLines={1}>
          {result.room_name} · Box {result.box_number}
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
}

export default function SearchWidget({ children, moveId, trailing }: SearchWidgetProps) {
  const user = useAuthStore((state) => state.user);
  const setPendingRoomSelect = useUiStore((s) => s.setPendingRoomSelect);
  const inputRef = useRef<TextInput>(null);

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [previewResult, setPreviewResult] = useState<SearchResult | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
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
    queryKey: ['search-items-inline', debouncedSearch, moveId ?? 'all', user?.id],
    queryFn: () => searchItems(debouncedSearch, moveId),
    enabled: debouncedSearch.length > 0 && !!user,
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
  const handleClear = useCallback(() => {
    setSearchText('');
    setDebouncedSearch('');
    setIsFocused(false);
    inputRef.current?.blur();
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

  const keyExtractor = useCallback((item: SearchResult) => item.item_id, []);

  const hasSearchTerm = debouncedSearch.length > 0;
  const hasResults = results && results.length > 0;
  const showRecentStrip = isFocused && searchText.length === 0 && recentSearches.length > 0;

  // ── Background dim on focus ───────────────
  // A dark scrim fades in OVER the page when the search bar is focused — an
  // opacity fade on the content itself is invisible here because the UI is
  // white cards on a near-white background. The scrim lives inside the
  // content area only, so the search bar and recent chips stay bright, and
  // it clears as soon as the user types (results become the active layer).
  const dimmed = isFocused && !hasSearchTerm;
  const contentFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(contentFade, {
      toValue: dimmed ? 0.45 : 0,
      duration: 250,
      useNativeDriver: true,
    }).start();
  }, [dimmed, contentFade]);

  // ── Hardware back dismisses search first ──
  // While the search UI is active (focused or has text), the Android back
  // button clears/exits the search instead of leaving the app. Only when the
  // search is fully idle does back behave normally (navigate/exit).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isFocused || searchText.length > 0) {
        handleClear();
        return true; // consumed — don't exit the app
      }
      return false;
    });
    return () => sub.remove();
  }, [isFocused, searchText, handleClear]);

  return (
    <View style={styles.container}>
      {/* ── Search Bar ──────────────────────── */}
      <View style={styles.searchBarWrapper}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
          <TextInput
            ref={inputRef}
            style={styles.searchInput}
            placeholder="Search items..."
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
          {trailing}
        </View>
      </View>

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
        {hasSearchTerm && isLoading && (
          <View style={styles.skeletonList}>
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
            <SkeletonRow opacity={skeletonOpacity} />
          </View>
        )}

        {/* Search is active and errored */}
        {hasSearchTerm && error && (
          <View style={styles.centeredContent}>
            <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              Could not search your items.
            </Text>
            <Pressable
              onPress={() => refetch()}
              style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.7 }]}>
              <Text style={{ color: colors.primary }}>Tap to retry</Text>
            </Pressable>
          </View>
        )}

        {/* Search is active and has results */}
        {hasSearchTerm && !isLoading && !error && hasResults && (
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
                  {results.length} {results.length === 1 ? 'item' : 'items'} found
                </Text>
              </View>
            }
          />
        )}

        {/* Search is active but no results matched */}
        {hasSearchTerm && !isLoading && !error && !hasResults && (
          <View style={styles.centeredContent}>
            <Ionicons name="search-outline" size={48} color={colors.textTertiary} />
            <Text style={[font.headline, { color: colors.textSecondary, marginTop: spacing.md }]}>
              No Items Found
            </Text>
            <Text style={[font.body, { color: colors.textTertiary, textAlign: 'center' }]}>
              Try checking the spelling, or use{'\n'}fewer words.
            </Text>

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
        {!hasSearchTerm && (
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

      {/* ── Result Preview Bottom Sheet ─────── */}
      <BottomSheet
        visible={!!previewResult}
        onClose={closePreview}
        handleOnly
        sheetStyle={{ backgroundColor: colors.surface }}>
        {previewResult && (
              <>
                {/* ── Item ───────────────────────── */}
                <BottomSheetDraggableArea>
                  <View style={styles.previewItemHeader}>
                    <View style={styles.previewItemIcon}>
                      <Ionicons name="cube-outline" size={26} color={colors.item} />
                    </View>
                    <Text style={[font.title, { flex: 1 }]} numberOfLines={2}>
                      {previewResult.item_name}
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

                <View style={[styles.previewRow, { backgroundColor: colors.surfaceMuted }]}>
                  <View style={[styles.previewRowIcon, { backgroundColor: colors.boxSoft }]}>
                    <Ionicons name="cube-outline" size={18} color={colors.box} />
                  </View>
                  <View style={styles.previewRowInfo}>
                    <Text style={styles.previewRowLabel}>Box</Text>
                    <Text style={styles.previewRowValue} numberOfLines={1}>
                      {previewResult.box_number}
                    </Text>
                  </View>
                </View>

                {/* ── Actions ────────────────────── */}
                <View style={styles.previewActions}>
                  <Pressable
                    onPress={() => navigateFromPreview('/box/[id]', previewResult.box_id)}
                    style={({ pressed }) => [
                      styles.previewActionBtn,
                      { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
                    ]}>
                    <Ionicons name="cube-outline" size={18} color="#FFFFFF" />
                    <Text style={styles.previewActionText}>Open Box</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => navigateFromPreview('/room/[id]', previewResult.room_id)}
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

  // ── Search Bar ─────────────────────────
  searchBarWrapper: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    height: 48,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 22,
    paddingVertical: 0,
    color: colors.textPrimary,
  },
  clearButton: {
    padding: spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
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
  // content (last child of contentArea) but below the search bar/recent chips
  // (they are outside this view), so only the page dims.
  focusScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0F1024',
  },

  // ── Centered Content ───────────────────
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
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
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
    borderCurve: 'continuous',
    shadowColor: '#0F1024',
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
    backgroundColor: colors.itemSoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
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
    borderRadius: 12,
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
