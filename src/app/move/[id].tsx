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
import * as Clipboard from 'expo-clipboard';
import ScreenHeader from '../../../packly-ui/components/ScreenHeader';
import ListRow from '../../../packly-ui/components/ListRow';
import Button from '../../../packly-ui/components/Button';
import AddRoomModal from '../../../packly-ui/components/AddRoomModal';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
import SearchWidget from '@/components/search-widget';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { deleteStorageForBoxIds } from '@/services/photos';
import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { toFriendlyError } from '@/lib/errors';


import type { Move, Room } from '@/types/database';

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

interface MemberInfo {
  user_id: string;
  name: string;
  email: string;
}

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function fetchMove(id: string): Promise<Move> {
  const { data, error } = await supabase
    .from('moves')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data;
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

async function fetchMembers(moveId: string): Promise<MemberInfo[]> {
  const { data, error } = await supabase.rpc('get_move_members', {
    move_id: moveId,
  });

  if (error) throw new Error(error.message);

  return (data ?? []) as MemberInfo[];
}

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

// Module-level channel counter for the rooms realtime subscription.
// Must be module scope (NOT a useRef): useRef resets when this screen remounts,
// which could reuse a channel name whose previous channel's async removeChannel()
// has not yet completed — supabase.channel() then returns the already-subscribed
// channel and .on() throws "cannot add postgres_changes callbacks ... after subscribe()".
// Do not move this into the component or remove the counter.
let moveRoomChannelSeq = 0;

export default function MoveDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const {
    data: move,
    isLoading: moveLoading,
    error: moveError,
  } = useQuery({
    queryKey: ['move', id],
    queryFn: () => fetchMove(id!),
    enabled: !!id,
  });

  const {
    data: rooms,
    isLoading: roomsLoading,
  } = useQuery({
    queryKey: ['rooms', id],
    queryFn: () => fetchRooms(id!),
    enabled: !!id,
  });

  const {
    data: members,
  } = useQuery({
    queryKey: ['members', id],
    queryFn: () => fetchMembers(id!),
    enabled: !!id,
  });

  const inputRef = useRef<TextInput>(null);
  const editRef = useRef<TextInput>(null);
  const [copied, setCopied] = useState(false);
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [addRoomError, setAddRoomError] = useState<string | null>(null);
  const [isAddingRoom, setIsAddingRoom] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [editRoomName, setEditRoomName] = useState('');
  const [editRoomError, setEditRoomError] = useState<string | null>(null);
  const [isEditingRoom, setIsEditingRoom] = useState(false);
  const [actionRoom, setActionRoom] = useState<Room | null>(null);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  // ── Realtime subscription — auto-refresh rooms when another member makes a change ──
  // Channel name includes a module-level counter so each effect run gets a fresh name.
  useEffect(() => {
    if (!id) return;

    const seq = ++moveRoomChannelSeq;
    const channel = supabase
      .channel(`move-${id}-rooms-${seq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `move_id=eq.${id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['rooms', id] });
          queryClient.invalidateQueries({ queryKey: ['move', id] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  // ── Focus input when modal opens ──
  useEffect(() => {
    if (showAddRoom) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showAddRoom]);

  useEffect(() => {
    if (editingRoom) {
      const timer = setTimeout(() => {
        editRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingRoom]);

  const handleCopyCode = async () => {
    if (!move) return;
    try {
      await Clipboard.setStringAsync(move.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available on this device
    }
  };

  const handleAddRoom = async (name: string) => {
    if (!id) return;

    setIsAddingRoom(true);
    setAddRoomError(null);

    try {
      const { error } = await supabase
        .from('rooms')
        .insert({ move_id: id!, name });

      if (error) {
        if (error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
          throw new Error(`A room named "${name}" already exists.`);
        }
        throw new Error(error.message);
      }

      setNewRoomName('');
      setShowAddRoom(false);
      queryClient.invalidateQueries({ queryKey: ['rooms', id] });
    } catch (err) {
      setAddRoomError(toFriendlyError(err, 'Failed to add room.'));
    } finally {
      setIsAddingRoom(false);
    }
  };

  const handleRoomLongPress = (room: Room) => {
    setActionRoom(room);
  };

  // ── Custom confirm/error modal state ──
  const [deleteConfirmRoom, setDeleteConfirmRoom] = useState<Room | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteRoom = async (room: Room) => {
    setActionRoom(null);
    setDeleteConfirmRoom(room);
  };

  const performDeleteRoom = useCallback(async () => {
    if (!deleteConfirmRoom || !id) return;
    setIsDeleting(true);

    try {
      // Get all box IDs in this room BEFORE deleting the room
      // (storage DELETE RLS requires boxes to exist)
      const { data: boxesInRoom } = await supabase
        .from('boxes')
        .select('id')
        .eq('room_id', deleteConfirmRoom.id);
      const boxIds = (boxesInRoom ?? []).map((b) => b.id);

      // Remove storage files for all boxes in this room
      await deleteStorageForBoxIds(boxIds);

      const { error } = await supabase
        .from('rooms')
        .delete()
        .eq('id', deleteConfirmRoom.id);

      if (error) throw new Error(error.message);

      setDeleteConfirmRoom(null);
      queryClient.invalidateQueries({ queryKey: ['rooms', id] });
    } catch {
      setDeleteConfirmRoom(null);
      setDeleteErrorVisible(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirmRoom, id, queryClient]);

  const handleRenameRoom = async () => {
    if (!editingRoom || !id) return;

    const trimmed = editRoomName.trim();
    if (!trimmed) {
      setEditRoomError('Room name is required.');
      return;
    }

    setEditRoomError(null);
    setIsEditingRoom(true);

    try {
      const { error } = await supabase
        .from('rooms')
        .update({ name: trimmed })
        .eq('id', editingRoom.id);

      if (error) {
        if (error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
          throw new Error(`A room named "${trimmed}" already exists.`);
        }
        throw new Error(error.message);
      }

      setEditingRoom(null);
      setEditRoomName('');
      queryClient.invalidateQueries({ queryKey: ['rooms', id] });
    } catch (err) {
      setEditRoomError(toFriendlyError(err, 'Failed to rename room.'));
    } finally {
      setIsEditingRoom(false);
    }
  };

  // ── Loading ─────────────────────────────
  if (moveLoading) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <ActivityIndicator size="large" color={colors.primary} />
        </SafeAreaView>
      </View>
    );
  }

  // ── Error ──────────────────────────────
  if (moveError || !move) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
            Could not load move details.
          </Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: colors.primary }}>Go Back</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  const isOwner = currentUser && move.owner_id === currentUser.id;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        {/* ── Header ─────────────────────────── */}
        <ScreenHeader
          title={move.name}
          large
          onBack={() => router.back()}
          right={
            <Pressable
              onPress={() => setShowMembersModal(true)}
              style={({ pressed }) => [styles.ownerBadge, pressed && styles.pressed]}>
              <Ionicons name="people-outline" size={14} color={colors.owner} />
              <Text style={styles.ownerBadgeText}>
                {isOwner ? 'Owner' : 'Member'}
              </Text>
              <View style={styles.countPill}>
                <Text style={styles.countPillText}>{members?.length ?? 0}</Text>
              </View>
            </Pressable>
          }
        />

        <SearchWidget moveId={id ?? null}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {/* ── Invite Code ────────────────────── */}
          <View style={styles.moveInfo}>
            <View style={[styles.inviteCodeCard, { backgroundColor: colors.surface }]}>
              <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginBottom: 4 }}>
                Invite Code
              </Text>
              <View style={styles.inviteCodeRow}>
                <Text style={[font.title, { letterSpacing: 2, fontSize: 20 }]} selectable>
                  {move.invite_code}
                </Text>
                <Pressable onPress={handleCopyCode} hitSlop={8}>
                  <Text style={{ fontFamily: fonts.bold, color: copied ? colors.success : colors.primary, fontWeight: '700', fontSize: 15 }}>
                    {copied ? '✓ Copied!' : 'Copy'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* ── Rooms ──────────────────────────── */}
          <View style={styles.roomsSection}>
            <SectionHeader title="Rooms" meta={`${rooms?.length ?? 0} rooms`} />

            {roomsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : rooms && rooms.length > 0 ? (
              <View style={styles.roomsList}>
                {rooms.map((room) => (
                  <ListRow
                    key={room.id}
                    iconType="room"
                    title={room.name}
                    onPress={() => router.push({ pathname: '/room/[id]', params: { id: room.id } })}
                    onMenuPress={() => handleRoomLongPress(room)}
                  />
                ))}
              </View>
            ) : (
              <Text style={{ textAlign: 'center', marginTop: spacing.lg, color: colors.textSecondary }}>
                No rooms yet.
              </Text>
            )}

            <Pressable
              style={styles.addLink}
              onPress={() => setShowAddRoom(true)}>
              <Text style={styles.addLinkText}>+ Add Room</Text>
            </Pressable>
          </View>
        </ScrollView>
        </SearchWidget>
      </View>

      {/* ── Add Room Modal ──────────────────── */}
      <AddRoomModal
        visible={showAddRoom}
        onCancel={() => setShowAddRoom(false)}
        onAdd={(name: string) => {
          handleAddRoom(name);
          setShowAddRoom(false);
        }}
      />

      {/* ── Edit Room Modal ─────────────────── */}
      <Modal
        visible={!!editingRoom}
        transparent
        animationType="none"
        onRequestClose={() => {
          setEditingRoom(null);
          setEditRoomName('');
          setEditRoomError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalBackdrop
            visible={!!editingRoom}
            onBackdropPress={() => {
              setEditingRoom(null);
              setEditRoomName('');
              setEditRoomError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.headline, { marginBottom: spacing.sm }]}>Rename Room</Text>

              {editRoomError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{editRoomError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={editRef}
                style={styles.roomInput}
                placeholder="Room name"
                placeholderTextColor={colors.textTertiary}
                value={editRoomName}
                onChangeText={(text) => {
                  setEditRoomName(text);
                  if (editRoomError) setEditRoomError(null);
                }}
                editable={!isEditingRoom}
                returnKeyType="done"
                onSubmitEditing={handleRenameRoom}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setEditingRoom(null);
                    setEditRoomName('');
                    setEditRoomError(null);
                  }}
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && styles.pressed]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameRoom}
                  disabled={isEditingRoom}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isEditingRoom || pressed ? 0.7 : 1 },
                  ]}>
                  {isEditingRoom ? (
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

      {/* ── Members Modal ──────────────────── */}
      <Modal
        visible={showMembersModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowMembersModal(false)}>
        <View style={[styles.membersModalContainer, { backgroundColor: colors.background }]}>
          <SafeAreaView style={styles.membersModalSafe}>
            {/* Header */}
            <View style={styles.membersModalHeader}>
              <Pressable onPress={() => setShowMembersModal(false)} style={({ pressed }) => [pressed && styles.pressed]}>
                <Text style={{ fontFamily: fonts.regular, color: colors.primary, fontSize: 16 }}>Done</Text>
              </Pressable>
              <Text style={[font.headline, { flex: 2, textAlign: 'center' }]}>Members</Text>
              <View style={{ width: 50 }} />
            </View>

            {/* Member list */}
            <ScrollView
              contentContainerStyle={styles.membersModalContent}
              showsVerticalScrollIndicator={false}>
              {members && members.length > 0 ? (
                members.map((member) => (
                  <View
                    key={member.user_id}
                    style={styles.memberCard}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>
                        {member.name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.memberInfo}>
                      <Text style={[font.body, { fontWeight: '500' }]}>{member.name}</Text>
                      <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 13 }} numberOfLines={1}>
                        {member.email}
                      </Text>
                    </View>
                    <View style={[styles.memberRoleBadge, member.user_id === move.owner_id && styles.ownerBadgeRole]}>
                      <Text style={[styles.memberRoleText, member.user_id === move.owner_id && styles.ownerRoleText]}>
                        {member.user_id === move.owner_id ? 'Owner' : 'Member'}
                      </Text>
                    </View>
                  </View>
                ))
              ) : (
                <Text style={{ textAlign: 'center', marginTop: spacing.xxxl * 2, color: colors.textSecondary }}>
                  No members yet.
                </Text>
              )}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── Room Action Sheet ──────────────── */}
      <BottomSheet
        visible={!!actionRoom}
        onClose={() => setActionRoom(null)}
        sheetStyle={{ backgroundColor: colors.surfaceMuted }}>
        {/* Title doubles as a full-width drag surface (same as Manage Rooms) */}
        <BottomSheetDraggableArea style={styles.actionTitleContainer}>
          <Text style={styles.actionTitle}>{actionRoom?.name}</Text>
        </BottomSheetDraggableArea>
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.surfaceMuted }]}
              onPress={() => {
                const room = actionRoom;
                setActionRoom(null);
                if (room) {
                  setEditRoomName(room.name);
                  setEditRoomError(null);
                  setEditingRoom(room);
                }
              }}>
              <Text style={styles.actionRenameText}>Rename</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { backgroundColor: colors.surfaceMuted }]}
              onPress={() => {
                const room = actionRoom;
                if (room) handleDeleteRoom(room);
              }}>
              <Text style={styles.actionDeleteText}>Delete</Text>
            </Pressable>
            <View style={[styles.actionCancelSeparator, { backgroundColor: colors.surface }]}>
              <Pressable
                style={({ pressed }) => [styles.actionCancelRow, pressed && { opacity: 0.7 }]}
                onPress={() => setActionRoom(null)}>
                <Text style={styles.actionCancelText}>Cancel</Text>
              </Pressable>
            </View>
      </BottomSheet>

      {/* ── Delete Room Confirmation ────── */}
      <ConfirmModal
        visible={!!deleteConfirmRoom}
        title="Delete Room?"
        message={deleteConfirmRoom ? `Are you sure you want to delete "${deleteConfirmRoom.name}"? All boxes and items in this room will also be deleted.` : ''}
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        onConfirm={performDeleteRoom}
        onCancel={() => setDeleteConfirmRoom(null)}
        isLoading={isDeleting}
      />

      {/* ── Delete Error ────────────────── */}
      <ConfirmModal
        visible={deleteErrorVisible}
        title="Error"
        message="Failed to delete room. Please try again."
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

  // ── Owner Badge ────────────────────
  ownerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.ownerSoft,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    gap: 6,
  },
  ownerBadgeText: {
    color: colors.owner,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 13,
  },
  countPill: {
    backgroundColor: colors.surface,
    borderRadius: 999,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countPillText: {
    fontSize: 11,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.owner,
    fontVariant: ['tabular-nums'],
  },

  // ── Move Info ──────────────────────
  moveInfo: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    gap: spacing.lg,
  },
  inviteCodeCard: {
    borderRadius: 16,
    padding: spacing.lg,
    borderCurve: 'continuous',
    shadowColor: '#0F1024',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
  },
  inviteCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  // ── Rooms ──────────────────────────
  roomsSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  roomsList: {
    gap: spacing.md,
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

  // ── Room Input ──────────────────────
  roomInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
  },

  // ── Members Modal ──────────────────────
  membersModalContainer: {
    flex: 1,
  },
  membersModalSafe: {
    flex: 1,
  },
  membersModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  membersModalContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.md,
    borderCurve: 'continuous',
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  memberAvatarText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  memberInfo: {
    flex: 1,
    gap: 2,
  },
  memberRoleBadge: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  memberRoleText: {
    fontSize: 12,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  ownerBadgeRole: {
    backgroundColor: colors.ownerSoft,
  },
  ownerRoleText: {
    color: colors.owner,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,22,0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    borderRadius: 20,
    padding: spacing.xl,
    gap: spacing.lg,
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
    borderRadius: 12,
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
    borderRadius: 8,
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
