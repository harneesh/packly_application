// app/move-analytics.tsx
// Move Progress — the analytics page behind Home's progress card.
//
//   • Hero — the same navy card as Home (corner fold, white numbers), but the
//     headline is the OVERALL percent of boxes packed.
//   • Overview — a read-only stat grid (rooms, boxes, items, packed): big
//     centred numbers over labels, NO rows or chevrons, so nothing reads as
//     a button.
//   • Rooms — one TAPPABLE row per room: badge on its usual accent tint (the
//     same palette the Home chips use), a mini progress track and a chevron —
//     tapping opens that room on Home (same handoff as search's "Open Room").
//
// Presentation + gesture are lifted verbatim from app/settings.tsx: the page
// is a transparent modal, the whole safe-area surface follows the finger, and
// a drag past ~30% of the screen height (or a fling) closes it. Data shares
// Home's query keys (['homeRooms', id] / ['moveProgress', id]), so opening
// this page paints from cache — no spinners on the common path.

import { useCallback, useMemo, useRef } from 'react';
import {
  Animated,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
// ScrollView comes from gesture-handler (not react-native) so the list and the
// dismiss pan cooperate natively — a core-RN ScrollView fights the pan for
// every vertical touch and the page feels stuck (same reason settings.tsx
// imports its ScrollView from here).
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
import { colors, spacing, font, radius, fonts, shadow } from '../../packly-ui/theme';
import { roomEmoji } from '../../packly-ui/components/roomEmoji';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import { useUiStore } from '@/store/ui-store';

import type { Move, Room } from '@/types/database';

// ──────────────────────────────────────────
// Shared data shapes
// ──────────────────────────────────────────

/** Same shape Home's ['moveProgress', id] query returns — keys must match. */
type MoveProgress = {
  totalItems: number;
  totalBoxes: number;
  packedBoxes: number;
};

/**
 * The soft accent tints each room carries across the app. Mirrors Home's
 * `roomAccentPalette` (app/(tabs)/index.tsx) — same array, same rotation, so
 * a room keeps its colour on the chips, in the Rooms sheet and here.
 */
const ROOM_ACCENT_PALETTE = [
  colors.primary,
  colors.room,
  colors.item,
  colors.packing,
  colors.packed,
  colors.box,
] as const;

// ──────────────────────────────────────────
// Data fetching (same keys/shapes as Home)
// ──────────────────────────────────────────

async function fetchUserMoves(userId: string): Promise<Move[]> {
  // Membership means "row in move_members OR owner" — the same rule the
  // database uses (is_move_member_for). Asking only for member rows hides a
  // move from its own owner whenever that row is missing, so ask for both.
  const [memberships, owned] = await Promise.all([
    supabase.from('move_members').select('move_id').eq('user_id', userId),
    supabase.from('moves').select('id').eq('owner_id', userId),
  ]);

  if (memberships.error) throw new Error(memberships.error.message);
  if (owned.error) throw new Error(owned.error.message);

  const moveIds = [
    ...new Set([
      ...(memberships.data ?? []).map((m) => m.move_id),
      ...(owned.data ?? []).map((m) => m.id),
    ]),
  ];
  if (moveIds.length === 0) return [];

  const { data, error } = await supabase
    .from('moves')
    .select('*')
    .in('id', moveIds)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchRooms(moveId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('move_id', moveId)
    .order('name', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Boxes of the move with just the fields the room breakdown needs. */
async function fetchMoveBoxes(moveId: string) {
  const { data: moveRooms, error: roomsError } = await supabase
    .from('rooms')
    .select('id')
    .eq('move_id', moveId);
  if (roomsError) throw new Error(roomsError.message);
  const roomIds = (moveRooms ?? []).map((r) => r.id);
  if (roomIds.length === 0) return [];

  const { data, error } = await supabase
    .from('boxes')
    .select('id, room_id, is_packed')
    .in('room_id', roomIds);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ──────────────────────────────────────────
// Swipe down to dismiss (from settings.tsx)
// ──────────────────────────────────────────

// The page is what moves: the whole safe-area surface — background included —
// follows the finger, so Home stays visible underneath while this slides away.
const AnimatedSafeAreaView = Animated.createAnimatedComponent(SafeAreaView);

/**
 * Leave the page. Same rule as Settings: a deep link can land here with
 * nothing behind it, in which case go home instead of leaving a page that
 * has slid off-screen with no way back.
 */
function closeAnalytics() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/** Live gesture state, owned by the closure that wires the drag up. */
interface DragState {
  /** Vertical scroll offset of the page's list (0 = at the top). */
  scrollY: number;
  /** Whether this gesture is allowed to move the page (decided on touch-down). */
  canDrag: boolean;
  /** How far the page has been dragged so far (0 at rest). */
  distance: number;
  /** Flips the moment a dismissal starts; the rest of the gesture is ignored. */
  dismissing: boolean;
}

/**
 * One read-only number on the Overview card. Deliberately NOT a Settings-style
 * row (icon tile + full-width row reads as a button): a big centred number
 * over its label is the established "stat" look, so nothing invites a tap.
 */
function Stat({
  icon,
  value,
  label,
  iconColor = colors.primary,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: number;
  label: string;
  iconColor?: string;
}) {
  return (
    <View
      style={styles.statCell}
      accessible
      accessibilityLabel={`${value} ${label.toLowerCase()}`}>
      <View style={styles.statValueRow}>
        <Ionicons name={icon} size={15} color={iconColor} />
        <Text style={styles.statValue}>{value}</Text>
      </View>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function MoveAnalyticsScreen() {
  const user = useAuthStore((s) => s.user);
  const { activeMoveId } = useActiveMoveStore();
  const insets = useSafeAreaInsets();

  // ── Swipe down to dismiss — identical mechanics to Settings ──
  const { height: windowHeight } = useWindowDimensions();
  const listRef = useRef(null);
  const drag = useMemo(() => {
    const state: DragState = { scrollY: 0, canDrag: false, distance: 0, dismissing: false };
    const translateY = new Animated.Value(0);
    const dismissDistance = windowHeight * 0.3;
    // The header sits outside the list, so a touch down there may always drag
    // (page coordinates; ScreenHeader is a fixed 56pt row under the inset).
    const headerBand = insets.top + 56;

    const springBack = () => {
      Animated.spring(translateY, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    };

    const pan = Gesture.Pan()
      .runOnJS(true)
      // Gesture Handler resolves the relation from the ref when the gesture
      // attaches (nothing reads it while rendering), so the refs lint rule is
      // a false positive here — same as settings.tsx.
      // eslint-disable-next-line react-hooks/refs
      .simultaneousWithExternalGesture(listRef)
      .activeOffsetY([-10, 10])
      .failOffsetX([-24, 24])
      .onBegin((e) => {
        state.canDrag = state.scrollY <= 1 || (e.y > 0 && e.y <= headerBand);
        state.distance = 0;
      })
      .onUpdate((e) => {
        if (state.dismissing || !state.canDrag) return;
        const y = Math.max(0, e.translationY);
        state.distance = y;
        translateY.setValue(y);
      })
      .onFinalize((e) => {
        if (state.dismissing || !state.canDrag) return;
        state.canDrag = false;
        const distance = state.distance;
        state.distance = 0;
        if (distance === 0) return;
        // Past ~30% of the screen height, or flung down — same thresholds and
        // spring as the shared bottom sheet and the Settings page.
        if (distance > dismissDistance || e.velocityY > 800) {
          state.dismissing = true;
          Animated.timing(translateY, {
            toValue: windowHeight,
            duration: 180,
            useNativeDriver: true,
          }).start(() => closeAnalytics());
        } else {
          springBack();
        }
      });

    return {
      pan,
      translateY,
      setScrollY: (offset: number) => {
        state.scrollY = offset;
      },
    };
  }, [windowHeight, insets.top]);

  // ── Resolve the active move — same priority as Home ──
  const {
    data: userMoves,
    isLoading: movesLoading,
  } = useQuery({
    queryKey: ['userMoves', user?.id],
    queryFn: () => fetchUserMoves(user!.id),
    enabled: !!user,
  });

  const resolvedMove: Move | null = (() => {
    if (!userMoves || userMoves.length === 0) return null;
    if (activeMoveId) {
      const match = userMoves.find((m) => m.id === activeMoveId);
      if (match) return match;
    }
    return userMoves[0];
  })();
  const moveId = resolvedMove?.id ?? null;

  // Move name for the header subtitle (cached from Home under ['move', id]).
  const { data: currentMove } = useQuery({
    queryKey: ['move', moveId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('moves')
        .select('*')
        .eq('id', moveId!)
        .single();
      if (error) throw new Error(error.message);
      return data as Move;
    },
    enabled: !!moveId,
  });

  // Rooms — SAME key as Home's ['homeRooms', id], so this paints from cache.
  const { data: rooms } = useQuery({
    queryKey: ['homeRooms', moveId],
    queryFn: () => fetchRooms(moveId!),
    enabled: !!moveId,
  });

  // Move-wide counts — SAME key AND shape as Home's ['moveProgress', id].
  const { data: moveProgress } = useQuery({
    queryKey: ['moveProgress', moveId],
    queryFn: async (): Promise<MoveProgress> => {
      if (!moveId) return { totalItems: 0, totalBoxes: 0, packedBoxes: 0 };
      // Mirrors Home's queryFn: rooms → boxes → item count in one pass.
      const { data: moveRooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id')
        .eq('move_id', moveId);
      if (roomsError) throw new Error(roomsError.message);
      const roomIds = (moveRooms ?? []).map((r) => r.id);
      if (roomIds.length === 0) return { totalItems: 0, totalBoxes: 0, packedBoxes: 0 };

      const { data: moveBoxes, error: boxesError } = await supabase
        .from('boxes')
        .select('id, is_packed')
        .in('room_id', roomIds);
      if (boxesError) throw new Error(boxesError.message);
      const boxes = moveBoxes ?? [];
      if (boxes.length === 0) return { totalItems: 0, totalBoxes: 0, packedBoxes: 0 };

      const boxIds = boxes.map((b) => b.id);
      const { count: totalItems, error: itemsError } = await supabase
        .from('items')
        .select('id', { count: 'exact', head: true })
        .in('box_id', boxIds);
      if (itemsError) throw new Error(itemsError.message);

      return {
        totalItems: totalItems ?? 0,
        totalBoxes: boxes.length,
        packedBoxes: boxes.filter((b) => b.is_packed).length,
      };
    },
    enabled: !!moveId,
  });

  // Per-room box tallies for the breakdown (only this page needs it).
  const { data: moveBoxes } = useQuery({
    queryKey: ['moveBoxes', moveId],
    queryFn: () => fetchMoveBoxes(moveId!),
    enabled: !!moveId,
  });

  // Room rows open the room: request Home to select it, then dismiss this
  // page — the same handoff the search preview's "Open Room" uses.
  const openRoom = useCallback((roomId: string) => {
    useUiStore.getState().setPendingRoomSelect(roomId);
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, []);

  const overallPct =
    moveProgress && moveProgress.totalBoxes > 0
      ? Math.round((moveProgress.packedBoxes / moveProgress.totalBoxes) * 100)
      : 0;

  // One row per room: its boxes/packed counts and its accent colour (same
  // palette rotation as the Home chips — index in the shared room list).
  const roomStats = useMemo(() => {
    return (rooms ?? []).map((room, index) => {
      const accent = ROOM_ACCENT_PALETTE[index % ROOM_ACCENT_PALETTE.length];
      const tally = { boxes: 0, packed: 0 };
      for (const box of moveBoxes ?? []) {
        if (box.room_id !== room.id) continue;
        tally.boxes += 1;
        if (box.is_packed) tally.packed += 1;
      }
      return {
        room,
        boxes: tally.boxes,
        packed: tally.packed,
        pct: tally.boxes > 0 ? Math.round((tally.packed / tally.boxes) * 100) : 0,
        accentSoft: accent + '22',
        accent,
      };
    });
  }, [rooms, moveBoxes]);

  const loading = movesLoading || rooms === undefined || moveProgress === undefined;

  // ── Render ───────────────────────────────

  return (
    <GestureDetector gesture={drag.pan}>
      <AnimatedSafeAreaView
        style={[
          styles.safeArea,
          {
            backgroundColor: colors.background,
            transform: [{ translateY: drag.translateY }],
          },
        ]}>
        <ScreenHeader onBack={closeAnalytics} title="Move Progress" subtitle={currentMove?.name} />

        <ScrollView
          ref={listRef}
          // Same deal as Settings: a downward drag at the top IS the dismiss
          // gesture, so the list must not rubber-band (or glow) underneath it.
          bounces={false}
          overScrollMode="never"
          onScroll={(e) => {
            drag.setScrollY(e.nativeEvent.contentOffset.y);
          }}
          scrollEventThrottle={16}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + spacing.xxxl },
          ]}
          showsVerticalScrollIndicator={false}>

          {loading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : (
            <>
              {/* ── Hero — navy card, same language as Home's progress card ── */}
              <View style={styles.heroCard}>
                <View style={styles.heroFold} />
                <View style={styles.heroRow}>
                  <Text style={styles.heroBig}>{overallPct}%</Text>
                  <Text style={styles.heroLabel}>packed</Text>
                </View>
                <View style={styles.heroTrack}>
                  <View style={[styles.heroFill, { width: `${overallPct}%` }]} />
                </View>
                <Text style={styles.heroCaption}>
                  {moveProgress && moveProgress.totalBoxes > 0
                    ? `${moveProgress.packedBoxes} of ${moveProgress.totalBoxes} ${
                        moveProgress.totalBoxes === 1 ? 'box' : 'boxes'
                      } packed · ${moveProgress.totalItems} ${
                        moveProgress.totalItems === 1 ? 'item' : 'items'
                      }`
                    : 'Add your first box to start'}
                </Text>
              </View>

              {/* ── Overview — read-only stat grid (deliberately not rows) ── */}
              <Text style={[font.eyebrow, styles.sectionTitle]}>Overview</Text>
              <View style={styles.card}>
                <View style={styles.statGridRow}>
                  <Stat icon="home-outline" value={rooms?.length ?? 0} label="Rooms" />
                  <View style={styles.statDivider} />
                  <Stat icon="archive-outline" value={moveProgress?.totalBoxes ?? 0} label="Boxes" />
                </View>
                <View style={[styles.statGridRow, styles.statGridRowBordered]}>
                  <Stat icon="cube-outline" value={moveProgress?.totalItems ?? 0} label="Items" />
                  <View style={styles.statDivider} />
                  <Stat
                    icon="checkmark-done-outline"
                    value={moveProgress?.packedBoxes ?? 0}
                    label="Packed"
                    iconColor={colors.packed}
                  />
                </View>
              </View>

              {/* ── Rooms — per-room progress ── */}
              <Text style={[font.eyebrow, styles.sectionTitle]}>Rooms</Text>
              <View style={styles.card}>
                {roomStats.length === 0 ? (
                  <Text style={styles.emptyText}>No rooms yet.</Text>
                ) : (
                  roomStats.map((stat, index) => (
                    <View key={stat.room.id}>
                      {index > 0 && <View style={styles.divider} />}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${stat.room.name}`}
                        style={({ pressed }) => [styles.roomRow, pressed && { opacity: 0.6 }]}
                        onPress={() => openRoom(stat.room.id)}>
                        <View style={[styles.roomTile, { backgroundColor: stat.accentSoft }]}>
                          <Text style={styles.roomTileEmoji}>
                            {roomEmoji(stat.room.name, stat.room.emoji)}
                          </Text>
                        </View>
                        <View style={styles.roomInfo}>
                          <View style={styles.roomNameRow}>
                            <Text style={styles.roomName} numberOfLines={1}>
                              {stat.room.name}
                            </Text>
                            <Text style={[styles.roomPct, stat.pct === 100 && { color: colors.packed }]}>
                              {stat.pct}%
                            </Text>
                          </View>
                          <View style={styles.roomTrack}>
                            <View
                              style={[
                                styles.roomFill,
                                { width: `${stat.pct}%`, backgroundColor: stat.accent },
                              ]}
                            />
                          </View>
                          <Text style={styles.roomMeta}>
                            {stat.packed} of {stat.boxes}{' '}
                            {stat.boxes === 1 ? 'box' : 'boxes'} packed
                          </Text>
                        </View>
                        {/* Right-chevron = navigates (app-wide convention). */}
                        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                      </Pressable>
                    </View>
                  ))
                )}
                {moveBoxes === undefined && (rooms?.length ?? 0) > 0 && (
                  <Text style={styles.emptyText}>Updating…</Text>
                )}
              </View>
            </>
          )}
        </ScrollView>
      </AnimatedSafeAreaView>
    </GestureDetector>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    gap: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  loadingWrap: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  sectionTitle: {
    // Cancels the scroll gap so the card sits right under its eyebrow label.
    marginBottom: -spacing.xl,
  },

  // ── Hero — same navy language as Home's progress card ──
  heroCard: {
    backgroundColor: colors.navy,
    borderRadius: radius.xl,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  heroFold: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 46,
    height: 46,
    backgroundColor: colors.accent,
    borderBottomLeftRadius: radius.xl,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  heroBig: {
    fontSize: 34,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  heroLabel: {
    fontSize: 15,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textOnNavy,
  },
  heroTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  heroFill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  heroCaption: {
    marginTop: spacing.sm,
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textOnNavy,
  },

  // ── Cards — white grouped containers (same language as Settings) ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    overflow: 'hidden',
    ...shadow.card,
  },  // ── Overview stat grid — read-only by design ──
  statGridRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  // Horizontal rule between the two grid rows, inset from the card edges.
  statGridRowBordered: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.lg,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statValue: {
    fontSize: 22,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    fontSize: 12,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  statDivider: {
    width: 1,
    backgroundColor: colors.divider,
  },
  divider: {
    height: 1,
    backgroundColor: colors.divider,
  },

  // ── Room breakdown rows ──
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  roomTile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  roomTileEmoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  roomInfo: {
    flex: 1,
    gap: spacing.xs,
  },
  roomNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  roomName: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  roomPct: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
    fontVariant: ['tabular-nums'],
  },
  roomTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.divider,
    overflow: 'hidden',
  },
  roomFill: {
    height: 6,
    borderRadius: 3,
  },
  roomMeta: {
    fontSize: 12,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
  },
  emptyText: {
    padding: spacing.lg,
    fontSize: 14,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});
