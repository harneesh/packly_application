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
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import ScreenHeader from '../../../packly-ui/components/ScreenHeader';
import ListRow from '../../../packly-ui/components/ListRow';
import { roomEmoji } from '../../../packly-ui/components/roomEmoji';
import Button from '../../../packly-ui/components/Button';
import AddRoomModal from '../../../packly-ui/components/AddRoomModal';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
import SearchWidget from '@/components/search-widget';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, fonts, radius } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { deleteStorageForBoxIds, fetchBoxPhotosByBox } from '@/services/photos';
import {
  approveJoinRequest,
  denyJoinRequest,
  fetchJoinRequests,
  fetchMembers,
  removeMoveMember,
  rotateInviteCode,
  type MemberInfo,
} from '@/services/members';
import { useMoveCreditPool, useMovePlan } from '@/hooks/use-move-plan';
import {
  fetchBoxes,
  fetchRoom,
  fetchRooms,
  ROOM_STALE_MS,
  type BoxWithCount,
} from '@/services/rooms';
import { useRef, useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import { toFriendlyError } from '@/lib/errors';


import type { Move, Room } from '@/types/database';

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

// fetchRooms lives in @/services/rooms — shared with the search filter so
// the room list comes from one cache entry (query key ['rooms', moveId]).
// fetchMembers likewise lives in @/services/members, shared with the search
// filter's "Packed by" picker (query key ['members', moveId]).

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
  // `members=1` opens straight onto the members sheet — Home's "N people want
  // to join" banner links here so the owner lands on the approval queue.
  const { id, members: openMembers } = useLocalSearchParams<{ id: string; members?: string }>();

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
  const [showMembersModal, setShowMembersModal] = useState(openMembers === '1');
  const [membersError, setMembersError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<MemberInfo | null>(null);
  const [isRemovingMember, setIsRemovingMember] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [confirmProOff, setConfirmProOff] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [isRotatingCode, setIsRotatingCode] = useState(false);
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const setActiveMove = useActiveMoveStore((s) => s.setActiveMove);

  // Owner-only surfaces (join requests, removals, invite-code rotation) all
  // hang off this one flag.
  const isOwner = !!currentUser && !!move && move.owner_id === currentUser.id;

  /** How often the owner's waiting-request badge re-reads the queue. */
  const JOIN_REQUESTS_POLL_MS = 15000;

  // People waiting to be let in. The server answers an empty list for anyone
  // who is not the owner, so this is safe to run unconditionally.
  //
  // Deliberately NO staleTime: this is the owner's "someone wants in" badge, and
  // a cached empty list looks exactly like a real one. Owners poll while the
  // screen is open so a request shows up on its own, with no manual refresh.
  const { data: joinRequests, error: joinRequestsError } = useQuery({
    queryKey: ['join-requests', id],
    queryFn: () => fetchJoinRequests(id!),
    enabled: !!id,
    refetchInterval: isOwner ? JOIN_REQUESTS_POLL_MS : false,
  });

  // Pro belongs to the MOVE: any member's live subscription covers everybody
  // here, and the pool is what those subscriptions contributed.
  const {
    plan: movePlan,
    isMovePro,
    canToggle: canTogglePro,
    sharingOn,
    isToggling: isTogglingPro,
    setShared: setProShared,
  } = useMovePlan(id);
  const { pool: sharedCreditPool } = useMoveCreditPool(id);

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

  // ── Owner tools: join requests, removals, invite code ──
  //
  // Each of these is owner-only and re-checked server-side; the UI just keeps
  // the buttons out of everybody else's way. Membership changes can move Pro
  // around (a payer arriving or leaving), so the plan is refreshed too.

  const refreshMembershipViews = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['join-requests', id] });
    queryClient.invalidateQueries({ queryKey: ['members', id] });
    queryClient.invalidateQueries({ queryKey: ['move-plan', id] });
  }, [queryClient, id]);

  const handleApproveRequest = useCallback(
    async (userId: string) => {
      if (!id) return;
      setMembersError(null);
      try {
        await approveJoinRequest(id, userId);
        refreshMembershipViews();
      } catch (err) {
        setMembersError(toFriendlyError(err, 'Failed to approve the request.'));
      }
    },
    [id, refreshMembershipViews],
  );

  const handleDenyRequest = useCallback(
    async (userId: string) => {
      if (!id) return;
      setMembersError(null);
      try {
        await denyJoinRequest(id, userId);
        refreshMembershipViews();
      } catch (err) {
        setMembersError(toFriendlyError(err, 'Failed to decline the request.'));
      }
    },
    [id, refreshMembershipViews],
  );

  const handleRemoveMember = useCallback(async () => {
    if (!id || !pendingRemoval) return;
    setIsRemovingMember(true);
    setMembersError(null);
    try {
      await removeMoveMember(id, pendingRemoval.user_id);
      setPendingRemoval(null);
      refreshMembershipViews();
    } catch (err) {
      setMembersError(toFriendlyError(err, 'Failed to remove the member.'));
      setPendingRemoval(null);
    } finally {
      setIsRemovingMember(false);
    }
  }, [id, pendingRemoval, refreshMembershipViews]);

  /**
   * Leave this move. Owners cannot — the move is theirs and there would be
   * nobody left in charge. Members can: the RLS policy lets everyone delete
   * their own row. Leaving removes ACCESS, never data — everything the person
   * packed stays in the move.
   */
  const handleLeaveMove = useCallback(async () => {
    if (!id || !currentUser || isOwner) return;
    setIsLeaving(true);
    setMembersError(null);
    // Restored if the delete fails, so a failed leave does not switch moves.
    const previousActiveMoveId = useActiveMoveStore.getState().activeMoveId;
    try {
      // Clear the active move BEFORE the delete: Home listens for deletions
      // on move_members, and its own-removal notice must not mistake a
      // self-service leave for the owner removing this user.
      await setActiveMove(null);

      const { error } = await supabase
        .from('move_members')
        .delete()
        .eq('move_id', id)
        .eq('user_id', currentUser.id);
      if (error) throw new Error(error.message);

      setConfirmLeave(false);
      setShowMembersModal(false);
      // Every list of "my moves" (Home, the switcher) has to stop showing this
      // one, and the owner's count of people in the move just changed.
      queryClient.invalidateQueries({ queryKey: ['members', id] });
      queryClient.invalidateQueries({ queryKey: ['userMoves', currentUser.id] });
      queryClient.invalidateQueries({ queryKey: ['moves', currentUser.id] });
      queryClient.invalidateQueries({ queryKey: ['join-request-counts'] });
      router.replace('/');
    } catch (err) {
      await setActiveMove(previousActiveMoveId);
      setConfirmLeave(false);
      setMembersError(toFriendlyError(err, 'Failed to leave the move.'));
    } finally {
      setIsLeaving(false);
    }
  }, [id, currentUser, isOwner, queryClient, setActiveMove]);

  const handleRotateCode = useCallback(async () => {
    if (!id) return;
    setIsRotatingCode(true);
    setMembersError(null);
    try {
      await rotateInviteCode(id);
      setConfirmRotate(false);
      // The visible code changed — stop showing a stale "Copied!".
      setCopied(false);
      queryClient.invalidateQueries({ queryKey: ['move', id] });
    } catch (err) {
      setMembersError(toFriendlyError(err, 'Failed to create a new code.'));
      setConfirmRotate(false);
    } finally {
      setIsRotatingCode(false);
    }
  }, [id, queryClient]);

  /**
   * Flip this payer's own Pro on or off FOR THIS MOVE. Turning it off asks
   * first: the switch is symmetric — the move goes Free for everyone, the
   * payer included, while their plan keeps covering their other moves.
   */
  const handleProToggle = useCallback(
    async (next: boolean) => {
      if (!next) {
        setConfirmProOff(true);
        return;
      }
      setMembersError(null);
      try {
        await setProShared(true);
      } catch (err) {
        setMembersError(toFriendlyError(err, 'Failed to turn Pro on.'));
      }
    },
    [setProShared],
  );

  const handleConfirmProOff = useCallback(async () => {
    setMembersError(null);
    try {
      await setProShared(false);
      setConfirmProOff(false);
    } catch (err) {
      setMembersError(toFriendlyError(err, 'Failed to turn Pro off.'));
      setConfirmProOff(false);
    }
  }, [setProShared]);

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

  // "Shared by Ada" / "Shared by Ada & Grace" — display names only; the
  // function never reveals who pays what, just who is contributing.
  const proCoveredBy =
    movePlan && movePlan.payerNames.length > 0
      ? movePlan.payerNames.join(' & ')
      : null;

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
              {isOwner && joinRequests && joinRequests.length > 0 ? (
                <View style={styles.requestPill}>
                  <Text style={styles.requestPillText}>{joinRequests.length}</Text>
                </View>
              ) : null}
            </Pressable>
          }
        />

        <SearchWidget moveId={id ?? null}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {/* ── Invite Code (mockup §2 dashed ticket) ── */}
          <View style={styles.moveInfo}>
            <Text style={styles.inviteLabel}>Invite code</Text>
            <View style={styles.inviteTicket}>
              <Text style={styles.inviteCode} selectable>
                {move.invite_code}
              </Text>
              <Pressable
                onPress={handleCopyCode}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.inviteCopyBtn,
                  { backgroundColor: copied ? colors.success : colors.primary },
                  pressed && !copied && { opacity: 0.85 },
                ]}>
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={16}
                  color="#FFFFFF"
                />
                <Text style={styles.inviteCopyText}>{copied ? 'Copied!' : 'Copy'}</Text>
              </Pressable>
            </View>
            {/* Owner-only: replace a code that leaked. Everyone already in
                keeps their access; the old code simply stops working. */}
            {isOwner ? (
              <Pressable
                onPress={() => setConfirmRotate(true)}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.newCodeLink,
                  pressed && { opacity: 0.7 },
                ]}>
                <Ionicons name="refresh-outline" size={14} color={colors.primary} />
                <Text style={styles.newCodeLinkText}>New code</Text>
              </Pressable>
            ) : null}
          </View>

          {/* ── Pro: one plan for the whole move ── */}
          <View style={styles.proCard}>
            <View style={styles.proCardTop}>
              <View style={[styles.proIconTile, isMovePro && styles.proIconTileOn]}>
                <Ionicons
                  name={isMovePro ? 'diamond' : 'diamond-outline'}
                  size={20}
                  color={isMovePro ? colors.primary : colors.textTertiary}
                />
              </View>
              <View style={styles.proHeadText}>
                <Text style={styles.proTitle}>{isMovePro ? 'Pro' : 'Free'}</Text>
                <Text style={styles.proSubtitle}>
                  {isMovePro
                    ? proCoveredBy
                      ? `Shared by ${proCoveredBy}`
                      : 'Shared with this move'
                    : 'One plan covers everyone here — each member does not need their own.'}
                </Text>
              </View>
            </View>

            {isMovePro && sharedCreditPool !== null ? (
              <Text style={styles.proPoolText}>
                {sharedCreditPool} shared AI{' '}
                {sharedCreditPool === 1 ? 'credit' : 'credits'} left in this move
              </Text>
            ) : null}

            {canTogglePro ? (
              <View style={styles.proToggleRow}>
                <View style={styles.proToggleText}>
                  <Text style={styles.proToggleTitle}>
                    Share my Pro with this move
                  </Text>
                  <Text style={styles.proToggleHint}>
                    {sharingOn
                      ? 'On — everyone here gets photos and my AI credits.'
                      : 'Off — this move is Free for everyone, you included. Your plan still covers your other moves.'}
                  </Text>
                </View>
                {isTogglingPro ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Switch
                    value={sharingOn}
                    onValueChange={handleProToggle}
                    trackColor={{ false: colors.dividerStrong, true: colors.primary }}
                    thumbColor="#FFFFFF"
                    ios_backgroundColor={colors.dividerStrong}
                  />
                )}
              </View>
            ) : null}
          </View>

          {/* ── Rooms ──────────────────────────── */}
          <View style={styles.roomsSection}>
            {/* Meta is a bare count — the title already says "Rooms". */}
            <SectionHeader title="Rooms" meta={`${rooms?.length ?? 0}`} />

            {roomsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : rooms && rooms.length > 0 ? (
              <View style={styles.roomsList}>
                {rooms.map((room) => (
                  <ListRow
                    key={room.id}
                    iconType="room"
                    iconLabel={roomEmoji(room.name, room.emoji)}
                    title={room.name}
                    onPress={() => {
                      // Warm this room's cache BEFORE navigating. The Room
                      // screen runs the same keys, so TanStack dedupes these
                      // into its in-flight requests — the room opens on data
                      // instead of a spinner. Photos follow once box ids land.
                      queryClient.prefetchQuery({
                        queryKey: ['room', room.id],
                        queryFn: () => fetchRoom(room.id),
                        staleTime: ROOM_STALE_MS,
                      });
                      queryClient
                        .prefetchQuery({
                          queryKey: ['boxes', room.id],
                          queryFn: () => fetchBoxes(room.id),
                          staleTime: ROOM_STALE_MS,
                        })
                        .then(() => {
                          // Read back through getQueryData (explicit type) so
                          // the box ids for the photo prefetch are typed even
                          // when prefetchQuery's payload type is opaque.
                          const boxes = queryClient.getQueryData<BoxWithCount[]>([
                            'boxes',
                            room.id,
                          ]);
                          if (!boxes || boxes.length === 0) return;
                          queryClient.prefetchQuery({
                            queryKey: ['room-photos', room.id],
                            queryFn: () => fetchBoxPhotosByBox(boxes.map((b) => b.id)),
                            staleTime: ROOM_STALE_MS,
                          });
                        })
                        .catch(() => {
                          // Prefetch is best-effort; the screen will fetch.
                        });
                      router.push({ pathname: '/room/[id]', params: { id: room.id } });
                    }}
                    onMenuPress={() => handleRoomLongPress(room)}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.emptyRoomsCard}>
                <Text style={styles.emptyRoomsEmoji}>🏠</Text>
                <Text style={styles.emptyRoomsText}>No rooms yet.</Text>
              </View>
            )}

            {/* Ghost pill — same "Add" affordance as the Manage Rooms sheet */}
            <Pressable
              style={({ pressed }) => [styles.addLink, pressed && { opacity: 0.6 }]}
              onPress={() => setShowAddRoom(true)}>
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={styles.addLinkText}>Add room</Text>
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
          behavior="padding">
          <ModalBackdrop
            visible={!!editingRoom}
            onBackdropPress={() => {
              setEditingRoom(null);
              setEditRoomName('');
              setEditRoomError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIcon}>
                  <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title}>Rename Room</Text>
              </View>

              {editRoomError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{editRoomError}</Text>
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
                  style={({ pressed }) => [styles.modalPillBtn, styles.modalPillBtnGhost, pressed && styles.pressed]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameRoom}
                  disabled={isEditingRoom}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isEditingRoom ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalPillPrimaryText}>Save</Text>
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
              <Pressable
                onPress={() => setShowMembersModal(false)}
                style={({ pressed }) => [styles.donePill, pressed && styles.pressed]}>
                <Text style={styles.donePillText}>Done</Text>
              </Pressable>
              <Text style={[font.title, { flex: 2, textAlign: 'center' }]}>Members</Text>
              <View style={{ width: 72 }} />
            </View>

            {/* Member list */}
            <ScrollView
              contentContainerStyle={styles.membersModalContent}
              showsVerticalScrollIndicator={false}>
              {membersError ? (
                <View style={styles.membersErrorBox}>
                  <Text style={styles.membersErrorText}>{membersError}</Text>
                </View>
              ) : null}

              {/* A queue that failed to load must say so — silence here reads
                  as "nobody is waiting", which is a different answer. */}
              {joinRequestsError ? (
                <View style={styles.membersErrorBox}>
                  <Text style={styles.membersErrorText}>
                    Couldn&apos;t load join requests: {joinRequestsError.message}
                  </Text>
                </View>
              ) : null}

              {/* Who is asking to join. Owner-only — the server hands back an
                  empty list to anyone else, so no role check is needed here. */}
              {joinRequests && joinRequests.length > 0 ? (
                <View style={styles.requestsBlock}>
                  <Text style={styles.requestsTitle}>
                    {joinRequests.length === 1
                      ? 'Someone wants to join'
                      : `${joinRequests.length} people want to join`}
                  </Text>
                  {joinRequests.map((request) => (
                    <View key={request.user_id} style={styles.memberCard}>
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberAvatarText}>
                          {request.name.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.memberInfo}>
                        <Text style={font.bodyMedium}>{request.name}</Text>
                        <Text style={styles.memberEmail} numberOfLines={1}>
                          {request.email}
                        </Text>
                      </View>
                      <View style={styles.requestActions}>
                        <Pressable
                          onPress={() => handleApproveRequest(request.user_id)}
                          style={({ pressed }) => [
                            styles.approvePill,
                            pressed && { opacity: 0.8 },
                          ]}>
                          <Text style={styles.approvePillText}>Approve</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => handleDenyRequest(request.user_id)}
                          style={({ pressed }) => [
                            styles.denyPill,
                            pressed && { opacity: 0.8 },
                          ]}>
                          <Text style={styles.denyPillText}>Deny</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                  <Text style={styles.requestsHint}>
                    Approving lets them see and pack everything in this move — you
                    can remove them again any time.
                  </Text>
                </View>
              ) : null}

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
                      <Text style={font.bodyMedium}>{member.name}</Text>
                      <Text style={styles.memberEmail} numberOfLines={1}>
                        {member.email}
                      </Text>
                    </View>
                    <View style={[styles.memberRoleBadge, member.user_id === move.owner_id && styles.ownerBadgeRole]}>
                      <Text style={[styles.memberRoleText, member.user_id === move.owner_id && styles.ownerRoleText]}>
                        {member.user_id === move.owner_id ? 'Owner' : 'Member'}
                      </Text>
                    </View>
                    {isOwner && member.user_id !== currentUser?.id ? (
                      <Pressable
                        onPress={() => setPendingRemoval(member)}
                        hitSlop={8}
                        style={({ pressed }) => [
                          styles.removeMemberButton,
                          pressed && { opacity: 0.6 },
                        ]}>
                        <Ionicons
                          name="person-remove-outline"
                          size={18}
                          color={colors.danger}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                ))
              ) : (
                <Text style={{ textAlign: 'center', marginTop: spacing.xxxl * 2, color: colors.textSecondary }}>
                  No members yet.
                </Text>
              )}

              {/* ── Leave the move (members only) ────────
                  The owner cannot leave their own move, so this only shows to
                  everybody else. Low-key danger row — losing access is worth
                  a confirm, not a scare. ── */}
              {!isOwner && currentUser ? (
                <Pressable
                  onPress={() => setConfirmLeave(true)}
                  style={({ pressed }) => [styles.leaveMoveBtn, pressed && { opacity: 0.7 }]}>
                  <Ionicons name="log-out-outline" size={18} color={colors.danger} />
                  <Text style={styles.leaveMoveText}>Leave this move</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── Turn Pro off for this move ──────── */}
      <ConfirmModal
        visible={confirmProOff}
        title="Turn off Pro here?"
        message="This move goes back to Free for EVERYONE in it, including you — photos lock and the shared AI credits stop being used. Your subscription keeps covering your other moves."
        confirmLabel="Turn off"
        confirmDestructive
        isLoading={isTogglingPro}
        icon="diamond-outline"
        onConfirm={handleConfirmProOff}
        onCancel={() => setConfirmProOff(false)}
      />

      {/* ── Remove a member ─────────────────── */}
      <ConfirmModal
        visible={!!pendingRemoval}
        title="Remove member?"
        message={
          pendingRemoval
            ? movePlan?.payerId === pendingRemoval.user_id
              ? `${pendingRemoval.name} is the Pro plan covering this move — removing them ends Pro for everyone here. Everything they packed stays in the move.`
              : `Remove ${pendingRemoval.name} from this move? They lose access to it, but everything they packed stays.`
            : ''
        }
        confirmLabel="Remove"
        confirmDestructive
        isLoading={isRemovingMember}
        icon="person-remove-outline"
        onConfirm={handleRemoveMember}
        onCancel={() => setPendingRemoval(null)}
      />

      {/* ── Leave this move ─────────────────── */}
      <ConfirmModal
        visible={confirmLeave}
        title="Leave this move?"
        message="You lose access to it right away. Everything you packed stays in the move, and you can join again later with the invite code."
        confirmLabel="Leave"
        confirmDestructive
        isLoading={isLeaving}
        icon="log-out-outline"
        onConfirm={handleLeaveMove}
        onCancel={() => setConfirmLeave(false)}
      />

      {/* ── Rotate the invite code ──────── */}
      <ConfirmModal
        visible={confirmRotate}
        title="Get a new invite code?"
        message="The current code stops working right away. Everyone already in the move keeps their access, and anyone still waiting to be approved stays in the queue."
        confirmLabel="New code"
        isLoading={isRotatingCode}
        icon="refresh-outline"
        onConfirm={handleRotateCode}
        onCancel={() => setConfirmRotate(false)}
      />

      {/* ── Room Action Sheet ──────────────── */}
      <BottomSheet
        visible={!!actionRoom}
        onClose={() => setActionRoom(null)}
        sheetStyle={{ backgroundColor: colors.surface }}>
        {/* Title doubles as a full-width drag surface (same as Manage Rooms) */}
        <BottomSheetDraggableArea>
          <Text style={[font.headlineBold, styles.sheetTitle]}>{actionRoom?.name}</Text>
        </BottomSheetDraggableArea>

        <View style={styles.sheetContent}>
          <Pressable
            style={({ pressed }) => [styles.sheetActionRow, pressed && { opacity: 0.6 }]}
            onPress={() => {
              const room = actionRoom;
              setActionRoom(null);
              if (room) {
                setEditRoomName(room.name);
                setEditRoomError(null);
                setEditingRoom(room);
              }
            }}>
            <View style={[styles.sheetActionIcon, { backgroundColor: colors.primarySoft }]}>
              <Ionicons name="pencil-outline" size={20} color={colors.primary} />
            </View>
            <Text style={styles.sheetActionText}>Rename</Text>
          </Pressable>

          <View style={[styles.sheetDivider, { backgroundColor: colors.divider }]} />
          <Pressable
            style={({ pressed }) => [styles.sheetActionRow, pressed && { opacity: 0.6 }]}
            onPress={() => {
              const room = actionRoom;
              if (room) handleDeleteRoom(room);
            }}>
            <View style={[styles.sheetActionIcon, { backgroundColor: colors.dangerSoft }]}>
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
            </View>
            <Text style={[styles.sheetActionText, { color: colors.danger }]}>Delete</Text>
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

  // ── Move Info / invite ticket (mockup §2) ──
  moveInfo: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  inviteLabel: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  inviteTicket: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.md,
  },
  inviteCode: {
    fontSize: 26,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    letterSpacing: 2,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  inviteCopyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    height: 42,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
  },
  inviteCopyText: {
    fontSize: 14,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: '#FFFFFF',
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

  // ── Empty rooms (dashed card, same language as Home) ──
  emptyRoomsCard: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xxl,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.dividerStrong,
    backgroundColor: colors.surfaceMuted,
    borderCurve: 'continuous',
  },
  emptyRoomsEmoji: {
    fontSize: 26,
    lineHeight: 32,
  },
  emptyRoomsText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Room Input (same treatment as Home's New box field) ──
  roomInput: {
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
  donePill: {
    height: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  donePillText: {
    color: colors.primary,
    fontSize: 14,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
    borderCurve: 'continuous',
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
  },
  memberEmail: {
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    fontSize: 13,
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

  // ── Join requests (owner) ──
  requestsBlock: {
    marginBottom: spacing.xl,
    gap: spacing.sm,
  },
  requestsTitle: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textTertiary,
    marginBottom: spacing.xs,
  },
  requestPill: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  requestPillText: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 11,
    color: colors.navyDeep,
  },
  requestActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  approvePill: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  approvePillText: {
    color: colors.textInverse,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 13,
  },
  denyPill: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  denyPillText: {
    color: colors.textSecondary,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 13,
  },
  requestsHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textTertiary,
  },
  membersErrorBox: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  membersErrorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.danger,
  },
  removeMemberButton: {
    padding: spacing.xs,
  },
  leaveMoveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerSoft,
    borderCurve: 'continuous',
  },
  leaveMoveText: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 15,
    color: colors.danger,
  },

  // ── Pro card ──
  proCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.md,
    borderCurve: 'continuous',
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
  },
  proCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  proIconTile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  proIconTileOn: {
    backgroundColor: colors.primarySoft,
  },
  proHeadText: {
    flex: 1,
    gap: 2,
  },
  proTitle: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 16,
    color: colors.textPrimary,
  },
  proSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  proPoolText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 13,
    color: colors.primary,
  },
  proToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.md,
  },
  proToggleText: {
    flex: 1,
    gap: 2,
  },
  proToggleTitle: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 14,
    color: colors.textPrimary,
  },
  proToggleHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textTertiary,
  },
  newCodeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  newCodeLinkText: {
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 13,
    color: colors.primary,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(23,26,46,0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    borderRadius: 20,
    padding: spacing.xl,
    gap: spacing.lg,
    borderCurve: 'continuous',
  },
  modalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  modalTitleIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
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
    borderCurve: 'continuous',
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
    borderRadius: 8,
  },

  // ── Room action sheet (same language as the box ⋯ sheet) ──
  sheetTitle: {
    textAlign: 'center',
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
  },
  sheetContent: {
    paddingHorizontal: spacing.xl,
  },
  sheetActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  sheetActionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetActionText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  sheetDivider: {
    height: 1,
    marginLeft: 68,
  },
});
