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
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import ScreenHeader from '../../../packly-ui/components/ScreenHeader';
import ListRow from '../../../packly-ui/components/ListRow';
import { Ionicons } from '@expo/vector-icons';
import SearchWidget from '@/components/search-widget';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
import { colors, spacing, font, radius, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { toFriendlyError } from '@/lib/errors';
import { fetchBoxPhotosByBox } from '@/services/photos';
import BoxPhotoGallery from '@/components/box-photo-gallery';


import type { Box } from '@/types/database';

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function fetchRoom(id: string): Promise<import('@/types/database').Room> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/** Box with a live item count for the list subtitle. */
type BoxWithCount = Box & { item_count: number };

async function fetchBoxes(roomId: string): Promise<BoxWithCount[]> {
  const { data, error } = await supabase
    .from('boxes')
    .select('*')
    .eq('room_id', roomId)
    .order('box_number', { ascending: true });

  if (error) throw new Error(error.message);
  const boxes = data ?? [];
  if (boxes.length === 0) return [];

  // Tally items per box so the subtitle under each box name stays current.
  const boxIds = boxes.map((b) => b.id);
  const { data: itemRows, error: itemError } = await supabase
    .from('items')
    .select('box_id')
    .in('box_id', boxIds);
  if (itemError) throw new Error(itemError.message);

  const counts = new Map<string, number>();
  for (const row of itemRows ?? []) {
    counts.set(row.box_id, (counts.get(row.box_id) ?? 0) + 1);
  }
  return boxes.map((b) => ({ ...b, item_count: counts.get(b.id) ?? 0 }));
}

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
  });

  const {
    data: boxes,
    isLoading: boxesLoading,
  } = useQuery({
    queryKey: ['boxes', id],
    queryFn: () => fetchBoxes(id!),
    enabled: !!id,
  });

  const boxIds = boxes?.map((b) => b.id) ?? [];

  // Photos for every box in this room (first photo becomes the box icon).
  // staleTime: 5 min — serve from cache on navigation, only refetch when stale.
  const { data: photosByBox } = useQuery({
    queryKey: ['room-photos', id],
    queryFn: () => fetchBoxPhotosByBox(boxIds),
    enabled: boxIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const inputRef = useRef<TextInput>(null);
  const editRef = useRef<TextInput>(null);
  const [showAddBox, setShowAddBox] = useState(false);
  const [boxName, setBoxName] = useState('');
  const [addBoxError, setAddBoxError] = useState<string | null>(null);
  const [isAddingBox, setIsAddingBox] = useState(false);
  const [editingBox, setEditingBox] = useState<Box | null>(null);
  const [editBoxName, setEditBoxName] = useState('');
  const [editBoxError, setEditBoxError] = useState<string | null>(null);
  const [isEditingBox, setIsEditingBox] = useState(false);
  const [actionBox, setActionBox] = useState<Box | null>(null);
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



  useEffect(() => {
    if (editingBox) {
      const timer = setTimeout(() => {
        editRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingBox]);

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
    } catch (err) {
      setAddBoxError(toFriendlyError(err, 'Failed to add box.'));
    } finally {
      setIsAddingBox(false);
    }
  };

  const handleBoxLongPress = (box: Box) => {
    setActionBox(box);
  };

  const openBoxGallery = (box: Box) => {
    const photos = photosByBox?.[box.id];
    if (!photos || photos.length === 0) return;
    setGalleryBoxId(box.id);
  };

  const invalidateRoomPhotos = (boxId: string) => {
    queryClient.invalidateQueries({ queryKey: ['room-photos', id] });
    queryClient.invalidateQueries({ queryKey: ['box-photos', boxId] });
  };

  // ── Custom confirm/error modal state ──
  const [deleteConfirmBox, setDeleteConfirmBox] = useState<Box | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteBox = async (box: Box) => {
    setActionBox(null);
    setDeleteConfirmBox(box);
  };

  const performDeleteBox = useCallback(async () => {
    if (!deleteConfirmBox || !id) return;
    setIsDeleting(true);

    try {
      const { error } = await supabase
        .from('boxes')
        .delete()
        .eq('id', deleteConfirmBox.id);

      if (error) throw new Error(error.message);

      setDeleteConfirmBox(null);
      queryClient.invalidateQueries({ queryKey: ['boxes', id] });
    } catch {
      setDeleteConfirmBox(null);
      setDeleteErrorVisible(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirmBox, id, queryClient]);

  const handleRenameBox = async () => {
    if (!editingBox || !id) return;

    const trimmed = editBoxName.trim();
    if (!trimmed) {
      setEditBoxError('Box label is required.');
      return;
    }

    setEditBoxError(null);
    setIsEditingBox(true);

    try {
      const { error } = await supabase
        .from('boxes')
        .update({ box_number: trimmed })
        .eq('id', editingBox.id);

      if (error) {
        if (error.message?.includes('duplicate key')) {
          throw new Error(`A box with label "${trimmed}" already exists in this room.`);
        }
        throw new Error(error.message);
      }

      setEditingBox(null);
      setEditBoxName('');
      queryClient.invalidateQueries({ queryKey: ['boxes', id] });
    } catch (err) {
      setEditBoxError(toFriendlyError(err, 'Failed to rename box.'));
    } finally {
      setIsEditingBox(false);
    }
  };

  // ── Loading ─────────────────────────────
  if (roomLoading) {
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
            <SectionHeader title="Boxes" meta={`${boxes?.length ?? 0} boxes`} />

            {boxesLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : boxes && boxes.length > 0 ? (
              <View style={styles.boxesList}>
                {boxes.map((box) => (
                  <ListRow
                    key={box.id}
                    iconType="box"
                    title={box.box_number}
                    subtitle={`Qty: ${box.item_count}`}
                    leadingImage={photosByBox?.[box.id]?.[0]?.url ?? null}
                    leadingFill
                    onLeadingPress={
                      photosByBox?.[box.id]?.length
                        ? () => openBoxGallery(box)
                        : undefined
                    }
                    onPress={() => router.push({ pathname: '/box/[id]', params: { id: box.id } })}
                    onMenuPress={() => handleBoxLongPress(box)}
                  />
                ))}
              </View>
            ) : (
              <Text style={{ textAlign: 'center', marginTop: spacing.lg, color: colors.textSecondary }}>
                No boxes yet. Tap "+ Add Box" to create one.
              </Text>
            )}

            <Pressable
              style={styles.addLink}
              onPress={() => setShowAddBox(true)}>
              <Text style={styles.addLinkText}>+ Add Box</Text>
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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
                <Text style={font.headline}>Add Box</Text>
              </View>

              {addBoxError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{addBoxError}</Text>
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
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && styles.pressed]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleAddBox}
                  disabled={isAddingBox}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isAddingBox || pressed ? 0.7 : 1 },
                  ]}>
                  {isAddingBox ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalSaveText}>Add</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Edit Box Modal ─────────────────── */}
      <Modal
        visible={!!editingBox}
        transparent
        animationType="none"
        onRequestClose={() => {
          setEditingBox(null);
          setEditBoxName('');
          setEditBoxError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalBackdrop
            visible={!!editingBox}
            onBackdropPress={() => {
              setEditingBox(null);
              setEditBoxName('');
              setEditBoxError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.headline, { marginBottom: spacing.sm }]}>Rename Box</Text>

              {editBoxError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{editBoxError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={editRef}
                style={styles.boxInput}
                placeholder="Box label"
                placeholderTextColor={colors.textTertiary}
                value={editBoxName}
                onChangeText={(text) => {
                  setEditBoxName(text);
                  if (editBoxError) setEditBoxError(null);
                }}
                editable={!isEditingBox}
                returnKeyType="done"
                onSubmitEditing={handleRenameBox}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setEditingBox(null);
                    setEditBoxName('');
                    setEditBoxError(null);
                  }}
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && styles.pressed]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameBox}
                  disabled={isEditingBox}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isEditingBox || pressed ? 0.7 : 1 },
                  ]}>
                  {isEditingBox ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalSaveText}>Save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Box Action Sheet ──────────────── */}
      <BottomSheet
        visible={!!actionBox}
        onClose={() => setActionBox(null)}
        sheetStyle={{ backgroundColor: colors.surfaceMuted }}>
        {/* Title doubles as a full-width drag surface (same as Manage Rooms) */}
        <BottomSheetDraggableArea style={styles.actionTitleContainer}>
          <Text style={styles.actionTitle}>{actionBox?.box_number}</Text>
        </BottomSheetDraggableArea>
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.surfaceMuted }]}
              onPress={() => {
                const box = actionBox;
                setActionBox(null);
                if (box) {
                  setEditBoxName(box.box_number);
                  setEditBoxError(null);
                  setEditingBox(box);
                }
              }}>
              <Text style={styles.actionRenameText}>Rename</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.surfaceMuted }]}
              onPress={() => {
                const box = actionBox;
                if (box) handleDeleteBox(box);
              }}>
              <Text style={styles.actionDeleteText}>Delete</Text>
            </Pressable>
            <View style={[styles.actionCancelSeparator, { backgroundColor: colors.surface }]}>
              <Pressable
                style={({ pressed }) => [styles.actionCancelRow, pressed && { opacity: 0.7 }]}
                onPress={() => setActionBox(null)}>
                <Text style={styles.actionCancelText}>Cancel</Text>
              </Pressable>
            </View>
      </BottomSheet>

      {/* ── Box Photo Gallery (opens from the photo icon) ── */}
      <BoxPhotoGallery
        boxId={galleryBoxId}
        photos={galleryPhotos}
        onClose={() => setGalleryBoxId(null)}
        onPhotosChanged={invalidateRoomPhotos}
      />

      {/* ── Delete Box Confirmation ──────── */}
      <ConfirmModal
        visible={!!deleteConfirmBox}
        title="Delete Box?"
        message={deleteConfirmBox ? `Are you sure you want to delete "${deleteConfirmBox.box_number}"? All items in this box will also be deleted.` : ''}
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        onConfirm={performDeleteBox}
        onCancel={() => setDeleteConfirmBox(null)}
        isLoading={isDeleting}
      />

      {/* ── Delete Error ────────────────── */}
      <ConfirmModal
        visible={deleteErrorVisible}
        title="Error"
        message="Failed to delete box. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setDeleteErrorVisible(false)}
        onCancel={() => setDeleteErrorVisible(false)}
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
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  addLinkText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 15,
  },

  // ── Box Input ────────────────────────
  boxInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,22,0.45)',
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
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  modalCancelBtn: {
    paddingHorizontal: spacing.lg,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSaveBtn: {
    paddingHorizontal: spacing.xxl,
    height: 52,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  modalSaveText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
  errorBox: {
    padding: spacing.sm,
    borderRadius: radius.sm,
  },

  actionTitleContainer: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    alignItems: 'center',
  },
  actionTitle: {
    fontSize: 13,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textTertiary,
  },
  actionRow: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
  },
  actionRenameText: {
    fontSize: 20,
    fontFamily: fonts.regular,
    fontWeight: '400',
    color: colors.primary,
  },
  actionDeleteText: {
    fontSize: 20,
    fontFamily: fonts.regular,
    fontWeight: '400',
    color: colors.danger,
  },
  actionCancelSeparator: {
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderRadius: 16,
    overflow: 'hidden',
  },
  actionCancelRow: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
  },
  actionCancelText: {
    fontSize: 20,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
  },
});
