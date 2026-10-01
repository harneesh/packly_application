import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  StyleSheet,
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Text,
  TextInput,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import ScreenHeader from '../../../packly-ui/components/ScreenHeader';
import ListRow from '../../../packly-ui/components/ListRow';
import type { BoxStatus } from '../../../packly-ui/components/StatusPill';
import { Ionicons } from '@expo/vector-icons';
import SearchWidget from '@/components/search-widget';
import ModalBackdrop from '@/components/modal-backdrop';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
import { colors, spacing, font, radius, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { toFriendlyError } from '@/lib/errors';
import { fetchBoxPhotosByBox } from '@/services/photos';
import { fetchBoxes, fetchRoom, ROOM_STALE_MS, type BoxWithCount } from '@/services/rooms';
import BoxPhotoGallery from '@/components/box-photo-gallery';


import type { Box } from '@/types/database';

/**
 * The kraft tile prints the box's NUMBER (mockup §1: Box 1 → "1").
 * Extracts the digits from the label; null when there is none.
 */
function boxNumberLabel(boxNumber: string): string | null {
  const match = boxNumber.match(/\d+/);
  return match ? match[0] : null;
}

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

// fetchRoom / fetchBoxes live in @/services/rooms so the Move screen's
// prefetch and this screen share the exact same query keys (one request,
// one cache entry).

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/** Generate the next box number for a room (e.g. "Box 1", "Box 2") */
function generateNextBoxNumber(boxes: Box[]): string {
  if (boxes.length === 0) return 'Box 1';

  // Try parsing existing "Box N" numbers to find the max
  let maxNum = 0;
  for (const box of boxes) {
    const match = box.box_number.match(/^Box\s+(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  // If any boxes don't follow the "Box N" pattern, fall back to count + 1
  const nextNum = maxNum > 0 ? maxNum + 1 : boxes.length + 1;
  return `Box ${nextNum}`;
}

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

// Module-level channel counter for the boxes realtime subscription.
// Must be module scope (NOT a useRef): useRef resets when this screen remounts,
// which could reuse a channel name whose previous channel's async removeChannel()
// has not yet completed — supabase.channel() then returns the already-subscribed
// channel and .on() throws "cannot add postgres_changes callbacks ... after subscribe()".
// Do not move this into the component or remove the counter.
let roomBoxChannelSeq = 0;
let roomItemsChannelSeq = 0;

export default function RoomDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const {
    data: room,
    isLoading: roomLoading,
    error: roomError,
  } = useQuery({
    queryKey: ['room', id],
    queryFn: () => fetchRoom(id!),
    enabled: !!id,
    // Cache-first: a prefetched/cached room paints instantly; realtime and
    // explicit invalidations keep it fresh rather than per-mount refetches.
    staleTime: ROOM_STALE_MS,
  });

  const {
    data: boxes,
    isLoading: boxesLoading,
  } = useQuery({
    queryKey: ['boxes', id],
    queryFn: () => fetchBoxes(id!),
    enabled: !!id,
    // Live via the boxes/items realtime channels below — no need to refetch
    // the whole list on every mount.
    staleTime: ROOM_STALE_MS,
  });

  const boxIds = boxes?.map((b) => b.id) ?? [];

  // Photos for every box in this room (first photo becomes the box icon).
  // Serve from cache on navigation — the Move screen prefetches these right
  // after the boxes land, so box thumbnails appear with no extra wait.
  const { data: photosByBox } = useQuery({
    queryKey: ['room-photos', id],
    queryFn: () => fetchBoxPhotosByBox(boxIds),
    enabled: boxIds.length > 0,
    staleTime: ROOM_STALE_MS,
  });

  const inputRef = useRef<TextInput>(null);
  const [showAddBox, setShowAddBox] = useState(false);
  const [boxName, setBoxName] = useState('');
  const [addBoxError, setAddBoxError] = useState<string | null>(null);
  const [isAddingBox, setIsAddingBox] = useState(false);
  const [galleryBoxId, setGalleryBoxId] = useState<string | null>(null);

  const galleryPhotos = galleryBoxId ? (photosByBox?.[galleryBoxId] ?? []) : [];

  // ── Realtime subscription — auto-refresh boxes when another member makes a change ──
  // Channel names include a module-level counter so each effect run gets a
  // fresh name. The items channel keeps the per-box item counts live.
  useEffect(() => {
    if (!id) return;

    const seq = ++roomBoxChannelSeq;
    const channel = supabase
      .channel(`room-${id}-boxes-${seq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'boxes', filter: `room_id=eq.${id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boxes', id] });
        },
      )
      .subscribe();

    const itemsSeq = ++roomItemsChannelSeq;
    const itemsChannel = supabase
      .channel(`room-${id}-items-${itemsSeq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'items' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['boxes', id] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(itemsChannel);
    };
  }, [id, queryClient]);

  // ── Pre-fill box name when modal opens ──
  useEffect(() => {
    if (showAddBox && boxes) {
      setBoxName(generateNextBoxNumber(boxes));
    }
  }, [showAddBox, boxes]);

  // ── Focus input when modal opens ──
  useEffect(() => {
    if (showAddBox) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showAddBox]);

  const handleAddBox = async () => {
    if (!id || !user) return;

    const trimmed = boxName.trim();
    if (!trimmed) {
      setAddBoxError('Box label is required.');
      return;
    }

    setAddBoxError(null);
    setIsAddingBox(true);

    try {
      const { error } = await supabase
        .from('boxes')
        .insert({
          room_id: id,
          box_number: trimmed,
          created_by: user.id,
        });

      if (error) {
        // Handle duplicate box number gracefully
        if (error.message?.includes('duplicate key')) {
          throw new Error(`A box with label "${trimmed}" already exists in this room.`);
        }
        throw new Error(error.message);
      }

      setBoxName('');
      setShowAddBox(false);
      queryClient.invalidateQueries({ queryKey: ['boxes', id] });
      // Home's progress card counts boxes across the whole move.
      queryClient.invalidateQueries({ queryKey: ['moveProgress'] });
    } catch (err) {
      setAddBoxError(toFriendlyError(err, 'Failed to add box.'));
    } finally {
      setIsAddingBox(false);
    }
  };

  // ── Toggle packed on a box (same pill behavior as Home) ──
  // Tap the pill: Empty/Packing → Packed, Packed → Packing. Boxes with no
  // items can't be marked packed — the pill is disabled ("Empty").
  const handleTogglePacked = useCallback(
    async (box: BoxWithCount) => {
      const nextPacked = !box.is_packed;
      // Optimistic update — the pill flips instantly.
      queryClient.setQueryData<BoxWithCount[]>(['boxes', id], (prev) =>
        prev?.map((b) => (b.id === box.id ? { ...b, is_packed: nextPacked } : b)) ?? prev,
      );
      try {
        const { error } = await supabase
          .from('boxes')
          .update({ is_packed: nextPacked })
          .eq('id', box.id);
        if (error) throw new Error(error.message);
      } catch {
        // Roll back on failure.
        queryClient.invalidateQueries({ queryKey: ['boxes', id] });
      }
      // Home's "x of y boxes packed" caption reads a separate move-wide query
      // — refresh it so the card is right when this screen is popped.
      queryClient.invalidateQueries({ queryKey: ['moveProgress'] });
    },
    [id, queryClient],
  );

  const openBoxGallery = (box: Box) => {
    const photos = photosByBox?.[box.id];
    if (!photos || photos.length === 0) return;
    setGalleryBoxId(box.id);
  };

  const invalidateRoomPhotos = (boxId: string) => {
    queryClient.invalidateQueries({ queryKey: ['room-photos', id] });
    queryClient.invalidateQueries({ queryKey: ['box-photos', boxId] });
  };

  // Box rename/delete moved to the box screen (header ⋯ sheet) — same as Home.

  // ── Loading ─────────────────────────────
  // Only block the whole screen when there is genuinely nothing to show.
  // A prefetched room (tap on the Move screen) renders immediately and the
  // rest of the content fills in as it arrives.
  if (!room && roomLoading) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <ActivityIndicator size="large" color={colors.primary} />
        </SafeAreaView>
      </View>
    );
  }

  // ── Error ──────────────────────────────
  if (roomError || !room) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
            Could not load room details.
          </Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: colors.primary }}>Go Back</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        <ScreenHeader onBack={() => router.back()} title={room.name} large />

        <SearchWidget moveId={room?.move_id ?? null}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {/* ── Room Info ──────────────────────── */}
          {/* ── Boxes ──────────────────────────── */}
          <View style={styles.boxesSection}>
            {/* Meta is a bare count — the title already says "Boxes". */}
            <SectionHeader title="Boxes" meta={`${boxes?.length ?? 0}`} />

            {boxesLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : boxes && boxes.length > 0 ? (
              <View style={styles.boxesList}>
                {boxes.map((box) => {
                  const status: BoxStatus =
                    box.is_packed && box.item_count > 0
                      ? 'packed'
                      : box.item_count === 0
                        ? 'empty'
                        : 'packing';
                  return (
                    <ListRow
                      key={box.id}
                      iconType="box"
                      iconLabel={boxNumberLabel(box.box_number)}
                      title={box.box_number}
                      subtitle={`${box.item_count} item${box.item_count === 1 ? '' : 's'}`}
                      status={status}
                      onStatusPress={
                        box.item_count === 0 ? undefined : () => handleTogglePacked(box)
                      }
                      leadingImage={photosByBox?.[box.id]?.[0]?.url ?? null}
                      leadingFill
                      onLeadingPress={
                        photosByBox?.[box.id]?.length
                          ? () => openBoxGallery(box)
                          : undefined
                      }
                      onPress={() => router.push({ pathname: '/box/[id]', params: { id: box.id } })}
                    />
                  );
                })}
              </View>
            ) : (
              <View style={styles.emptyBoxesCard}>
                <Text style={styles.emptyBoxesEmoji}>📦</Text>
                <Text style={styles.emptyBoxesText}>
                  No boxes yet. Add your first box to start packing.
                </Text>
              </View>
            )}

            {/* Ghost pill — same "Add" affordance as the Move screen */}
            <Pressable
              style={({ pressed }) => [styles.addLink, pressed && { opacity: 0.6 }]}
              onPress={() => setShowAddBox(true)}>
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={styles.addLinkText}>Add box</Text>
            </Pressable>
          </View>
        </ScrollView>
        </SearchWidget>
      </View>

      {/* ── Add Box Modal ──────────────────── */}
      <Modal
        visible={showAddBox}
        transparent
        animationType="none"
        onRequestClose={() => {
          setShowAddBox(false);
          setBoxName('');
          setAddBoxError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding">
          <ModalBackdrop
            visible={showAddBox}
            onBackdropPress={() => {
              setShowAddBox(false);
              setBoxName('');
              setAddBoxError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                <Ionicons name="cube-outline" size={20} color={colors.primary} />
                <Text style={font.title}>New box</Text>
              </View>

              {addBoxError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{addBoxError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={inputRef}
                style={styles.boxInput}
                placeholder="Box label (e.g. Box 1)"
                placeholderTextColor={colors.textTertiary}
                value={boxName}
                onChangeText={(text) => {
                  setBoxName(text);
                  if (addBoxError) setAddBoxError(null);
                }}
                editable={!isAddingBox}
                returnKeyType="done"
                onSubmitEditing={handleAddBox}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setShowAddBox(false);
                    setBoxName('');
                    setAddBoxError(null);
                  }}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnGhost,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleAddBox}
                  disabled={isAddingBox}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isAddingBox ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalPillPrimaryText}>Add box</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Box Photo Gallery (opens from the photo icon) ── */}
      <BoxPhotoGallery
        boxId={galleryBoxId}
        moveId={room?.move_id}
        photos={galleryPhotos}
        onClose={() => setGalleryBoxId(null)}
        onPhotosChanged={invalidateRoomPhotos}
      />
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  centeredSafeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },
  scrollContent: {
    paddingBottom: spacing.xxxl * 2,
  },

  // ── Header ─────────────────────────
  backButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },

  // ── Boxes ──────────────────────────
  boxesSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  boxesList: {
    gap: spacing.sm,
  },
  addLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  addLinkText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 15,
  },

  // ── Empty boxes (dashed card, same language as Home) ──
  emptyBoxesCard: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.dividerStrong,
    backgroundColor: colors.surfaceMuted,
    borderCurve: 'continuous',
  },
  emptyBoxesEmoji: {
    fontSize: 26,
    lineHeight: 32,
  },
  emptyBoxesText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
  },

  // ── Box Input ────────────────────────
  boxInput: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    // Height owns the vertical rhythm; zero padding + Android centering keeps
    // the typed text dead-centre on both platforms.
    paddingVertical: 0,
    textAlignVertical: 'center',
    height: 56,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 17,
    color: colors.textPrimary,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(23,26,46,0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  modalPillBtn: {
    flex: 1,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPillBtnGhost: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalPillBtnPrimary: {
    backgroundColor: colors.primary,
  },
  modalPillGhostText: {
    color: colors.primary,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  modalPillPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  errorBox: {
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
});
