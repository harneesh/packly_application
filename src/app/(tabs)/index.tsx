import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutAnimation,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import ListRow from '../../../packly-ui/components/ListRow';
import Button from '../../../packly-ui/components/Button';
import EmptyState from '../../../packly-ui/components/EmptyState';
import AddRoomModal from '../../../packly-ui/components/AddRoomModal';
import SearchWidget from '@/components/search-widget';
import { useUiStore } from '@/store/ui-store';
import BoxPhotoGallery from '@/components/box-photo-gallery';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import MoveSwitcher from '@/components/move-switcher';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import { colors, spacing, font, radius, shadow, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { fetchBoxPhotosByBox, deleteStorageForBoxIds } from '@/services/photos';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import { toFriendlyError } from '@/lib/errors';

import type { Move, Room, Box } from '@/types/database';

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function fetchUserMoves(userId: string): Promise<Move[]> {
  // Get all move IDs the user is a member of
  const { data: memberships, error: memberError } = await supabase
    .from('move_members')
    .select('move_id')
    .eq('user_id', userId);

  if (memberError) throw new Error(memberError.message);

  const moveIds = (memberships ?? []).map((m) => m.move_id);
  if (moveIds.length === 0) return [];

  const { data, error } = await supabase
    .from('moves')
    .select('*')
    .in('id', moveIds)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

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

/** Generate the next box number for a room (e.g. "Box 1", "Box 2") */
function generateNextBoxNumber(boxes: Box[]): string {
  if (boxes.length === 0) return 'Box 1';

  let maxNum = 0;
  for (const box of boxes) {
    const match = box.box_number.match(/^Box\s+(\d+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNum = maxNum > 0 ? maxNum + 1 : boxes.length + 1;
  return `Box ${nextNum}`;
}

// ──────────────────────────────────────────
// Main Screen
// ──────────────────────────────────────────

// Module-level channel counter for the rooms realtime subscription.
// IMPORTANT: This MUST live at module scope, NOT in a useRef inside the component.
// A useRef resets to 0 whenever this screen remounts (e.g. after creating a move,
// create-move.tsx calls router.replace('/') which remounts Home). If the counter
// reset, a remount could reuse a channel name whose previous channel's async
// removeChannel() has not yet completed — supabase.channel() then returns that
// existing subscribed channel and .on() throws
// "cannot add postgres_changes callbacks ... after subscribe()".
// A module-level counter never resets, so names stay unique for the app's lifetime.
// Do not move this back into the component or remove the counter.
let homeRoomChannelSeq = 0;
let homeItemsChannelSeq = 0;

export default function HomeScreen() {
  const user = useAuthStore((s) => s.user);
  const {
    activeMoveId,
    isLoaded: storeLoaded,
    setActiveMove,
    loadActiveMove,
  } = useActiveMoveStore();
  const queryClient = useQueryClient();

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [showManageRooms, setShowManageRooms] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [editRoomName, setEditRoomName] = useState('');
  const [editRoomError, setEditRoomError] = useState<string | null>(null);
  const [isEditingRoom, setIsEditingRoom] = useState(false);
  const [actionRoom, setActionRoom] = useState<Room | null>(null);

  // ── Add Box state ──
  const [showAddBox, setShowAddBox] = useState(false);
  const [boxName, setBoxName] = useState('');
  const [addBoxError, setAddBoxError] = useState<string | null>(null);
  const [isAddingBox, setIsAddingBox] = useState(false);
  const boxInputRef = useRef<TextInput>(null);

  const editRef = useRef<TextInput>(null);

  // ── Box action sheet state ──
  const [actionBox, setActionBox] = useState<Box | null>(null);
  const [editingBox, setEditingBox] = useState<Box | null>(null);
  const [editBoxName, setEditBoxName] = useState('');
  const [editBoxError, setEditBoxError] = useState<string | null>(null);
  const [isEditingBox, setIsEditingBox] = useState(false);
  const [deleteConfirmBox, setDeleteConfirmBox] = useState<Box | null>(null);
  const [deleteBoxErrorVisible, setDeleteBoxErrorVisible] = useState(false);
  const [isDeletingBox, setIsDeletingBox] = useState(false);
  const editBoxRef = useRef<TextInput>(null);
  const [galleryBoxId, setGalleryBoxId] = useState<string | null>(null);

  // ── Load active move from storage on mount ──
  useEffect(() => {
    loadActiveMove();
  }, [loadActiveMove]);

  // ── Fetch all moves the user is a member of ──
  const {
    data: userMoves,
    isLoading: movesLoading,
    error: movesError,
  } = useQuery({
    queryKey: ['userMoves', user?.id],
    queryFn: () => fetchUserMoves(user!.id),
    enabled: !!user,
  });

  // ── Determine the effective active move ──
  // Priority: stored activeMoveId → most recent move → null
  const resolvedMove: Move | null = (() => {
    if (!userMoves || userMoves.length === 0) return null;

    // If stored active move exists and user is still a member, use it
    if (activeMoveId) {
      const match = userMoves.find((m) => m.id === activeMoveId);
      if (match) return match;
    }

    // Fall back to most recent move
    return userMoves[0];
  })();

  // ── Fetch the resolved move's details ──
  const {
    data: currentMove,
    isLoading: moveLoading,
  } = useQuery({
    queryKey: ['move', resolvedMove?.id],
    queryFn: () => fetchMove(resolvedMove!.id),
    enabled: !!resolvedMove,
  });

  // ── Fetch rooms for the active move ──
  const {
    data: rooms,
    isLoading: roomsLoading,
    isRefetching: roomsRefetching,
    refetch: refetchRooms,
    error: roomsError,
  } = useQuery({
    queryKey: ['homeRooms', resolvedMove?.id],
    queryFn: () => fetchRooms(resolvedMove!.id),
    enabled: !!resolvedMove,
  });

  // ── Sync resolved move to store (auto-select on first load) ──
  useEffect(() => {
    if (resolvedMove && resolvedMove.id !== activeMoveId && storeLoaded) {
      setActiveMove(resolvedMove.id);
    }
  }, [resolvedMove?.id, activeMoveId, storeLoaded, setActiveMove]);

  // ── Realtime subscription — auto-refresh rooms when another member makes a change ──
  // Channel name uses a module-level counter (homeRoomChannelSeq) so every effect run
  // creates a fresh, unique channel even if this screen remounts while the previous
  // channel's async removeChannel() is still in progress. Do not remove the counter.
  useEffect(() => {
    const moveId = resolvedMove?.id;
    if (!moveId) return;

    const id = ++homeRoomChannelSeq;
    const channelName = `home-${moveId}-rooms-${id}`;

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `move_id=eq.${moveId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['homeRooms', moveId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [resolvedMove?.id, queryClient]);



  // ── Auto-select first room when rooms load ──
  useEffect(() => {
    if (rooms && rooms.length > 0) {
      setSelectedRoomId((prev) => {
        if (prev && rooms.find((r) => r.id === prev)) return prev;
        return rooms[0].id;
      });
    } else {
      setSelectedRoomId(null);
    }
  }, [rooms]);

  // ── Realtime subscription — item counts stay live ──
  // Any item change (add/rename/delete, from any member) refetches the
  // selected room's boxes, which re-tallies the per-box item counts.
  useEffect(() => {
    const moveId = resolvedMove?.id;
    if (!moveId) return;

    // Module-level counter (same pattern as homeRoomChannelSeq) so remounts
    // can never collide with a channel whose removal is still in flight.
    const id = ++homeItemsChannelSeq;
    const channel = supabase
      .channel(`home-${moveId}-items-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'items' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['roomBoxes', selectedRoomId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [resolvedMove?.id, selectedRoomId, queryClient]);

  // ── Pending room selection from search "Open Room" ──
  // The search widget doesn't navigate to rooms — it requests that Home
  // select the room (rooms are browsed here). Subscribing to the store value
  // (not just on-focus) matters because Home stays mounted under stacked
  // screens — the selection applies the moment search sets it, so the view is
  // already correct when the user lands back on Home. If the room belongs to
  // a different move, the active move is switched first; rooms for that move
  // load right after and the selection applies once they arrive.
  const pendingRoomSelect = useUiStore((s) => s.pendingRoomSelect);
  useEffect(() => {
    if (!pendingRoomSelect) return;

    useUiStore.getState().setPendingRoomSelect(null);

    const belongsToCurrentMove = rooms?.some((r) => r.id === pendingRoomSelect) ?? false;
    if (belongsToCurrentMove) {
      setSelectedRoomId(pendingRoomSelect);
    } else {
      (async () => {
        const { data } = await supabase
          .from('rooms')
          .select('move_id')
          .eq('id', pendingRoomSelect)
          .single();
        if (data?.move_id) {
          await setActiveMove(data.move_id);
          setSelectedRoomId(pendingRoomSelect);
        }
      })();
    }
  }, [pendingRoomSelect, rooms, setActiveMove]);

  // ── Fetch boxes for the selected room (with live item counts) ──
  // Counts are tallied in the same query so the subtitle under each box name
  // updates whenever the list refetches (realtime invalidation below).
  const { data: roomBoxes, isLoading: boxesLoading } = useQuery({
    queryKey: ['roomBoxes', selectedRoomId],
    queryFn: async () => {
      if (!selectedRoomId) return [];
      const { data, error } = await supabase
        .from('boxes')
        .select('*')
        .eq('room_id', selectedRoomId)
        .order('box_number', { ascending: true });
      if (error) throw new Error(error.message);
      const boxes = data ?? [];
      if (boxes.length === 0) return [];

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
    },
    enabled: !!selectedRoomId,
  });

  const boxIds = roomBoxes?.map((b) => b.id) ?? [];

  // ── Photos for the selected room's boxes (first photo becomes the box icon) ──
  // staleTime: 5 min — serve from cache on navigation, only refetch when stale.
  const { data: photosByBox } = useQuery({
    queryKey: ['room-photos', selectedRoomId],
    queryFn: () => fetchBoxPhotosByBox(boxIds),
    enabled: boxIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const galleryPhotos = galleryBoxId ? (photosByBox?.[galleryBoxId] ?? []) : [];

  const invalidateHomePhotos = (boxId: string) => {
    queryClient.invalidateQueries({ queryKey: ['room-photos', selectedRoomId] });
    queryClient.invalidateQueries({ queryKey: ['box-photos', boxId] });
  };



  // ── Pre-fill box name when add box modal opens ──
  useEffect(() => {
    if (showAddBox && roomBoxes) {
      setBoxName(generateNextBoxNumber(roomBoxes));
    }
  }, [showAddBox, roomBoxes]);

  // ── Focus add box input when modal opens ──
  useEffect(() => {
    if (showAddBox) {
      const timer = setTimeout(() => {
        boxInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showAddBox]);

  // ── Focus edit input when modal opens ──
  useEffect(() => {
    if (editingRoom) {
      const timer = setTimeout(() => {
        editRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingRoom]);

  // ── Handlers ─────────────────────────────

  const handleSwitchMove = useCallback(
    (moveId: string) => {
      setActiveMove(moveId);
      // Invalidate home queries to refresh with new move's data
      queryClient.invalidateQueries({ queryKey: ['move', moveId] });
      queryClient.invalidateQueries({ queryKey: ['homeRooms', moveId] });
    },
    [setActiveMove, queryClient],
  );

  const handleAddRoom = useCallback(
    async (name: string) => {
      const moveId = resolvedMove?.id;
      if (!moveId) return;

      try {
        const { error } = await supabase
          .from('rooms')
          .insert({ move_id: moveId, name });

        if (error) {
          if (error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
            throw new Error(`A room named "${name}" already exists.`);
          }
          throw new Error(error.message);
        }

        queryClient.invalidateQueries({ queryKey: ['homeRooms', moveId] });
      } catch (err) {
        setAddRoomAlertVisible(true);
        setAddRoomAlertMessage(toFriendlyError(err, 'Failed to add room.'));
      }
    },
    [resolvedMove?.id, queryClient],
  );

  const handleAddBox = useCallback(async () => {
    if (!selectedRoomId || !user) return;

    const trimmed = boxName.trim();
    if (!trimmed) {
      setAddBoxError('Box label is required.');
      return;
    }

    setAddBoxError(null);
    setIsAddingBox(true);

    try {
      const { data: newBox, error } = await supabase
        .from('boxes')
        .insert({
          room_id: selectedRoomId,
          box_number: trimmed,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) {
        if (error.message?.includes('duplicate key')) {
          throw new Error(`A box with label "${trimmed}" already exists in this room.`);
        }
        throw new Error(error.message);
      }

      setBoxName('');
      setShowAddBox(false);
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', selectedRoomId] });

      // Navigate to the new box to show the label prompt
      if (newBox) {
        setTimeout(() => router.push({ pathname: '/box/[id]', params: { id: newBox.id } }), 200);
      }
    } catch (err) {
      setAddBoxError(toFriendlyError(err, 'Failed to add box.'));
    } finally {
      setIsAddingBox(false);
    }
  }, [selectedRoomId, user, boxName, queryClient]);

  const handleBoxMenuPress = useCallback((box: Box) => {
    setActionBox(box);
  }, []);

  const handleDeleteBox = useCallback(
    (box: Box) => {
      setActionBox(null);
      setDeleteConfirmBox(box);
    },
    [],
  );

  const performDeleteBox = useCallback(async () => {
    if (!deleteConfirmBox || !resolvedMove?.id) return;
    setIsDeletingBox(true);

    try {
      // Remove storage files BEFORE the DB cascade deletes the box row
      // (storage DELETE RLS requires the box to exist)
      await deleteStorageForBoxIds([deleteConfirmBox.id]);

      const { error } = await supabase
        .from('boxes')
        .delete()
        .eq('id', deleteConfirmBox.id);

      if (error) throw new Error(error.message);

      setDeleteConfirmBox(null);
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', deleteConfirmBox.room_id] });
    } catch {
      setDeleteConfirmBox(null);
      setDeleteBoxErrorVisible(true);
    } finally {
      setIsDeletingBox(false);
    }
  }, [deleteConfirmBox, resolvedMove?.id, queryClient]);

  const handleRenameBox = useCallback(async () => {
    if (!editingBox) return;

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
        if (error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
          throw new Error(`A box with label "${trimmed}" already exists in this room.`);
        }
        throw new Error(error.message);
      }

      setEditingBox(null);
      setEditBoxName('');
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', editingBox.room_id] });
    } catch (err) {
      setEditBoxError(toFriendlyError(err, 'Failed to rename box.'));
    } finally {
      setIsEditingBox(false);
    }
  }, [editingBox, editBoxName, queryClient]);

  // ── Focus edit box input when modal opens ──
  useEffect(() => {
    if (editingBox) {
      const timer = setTimeout(() => {
        editBoxRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingBox]);

  const handleRoomLongPress = useCallback((room: Room) => {
    setActionRoom(room);
  }, []);

  // ── Custom confirm/error modal state ──
  const [deleteConfirmRoom, setDeleteConfirmRoom] = useState<Room | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [addRoomAlertVisible, setAddRoomAlertVisible] = useState(false);
  const [addRoomAlertMessage, setAddRoomAlertMessage] = useState('');

  const handleDeleteRoom = useCallback(
    (room: Room) => {
      setActionRoom(null);
      setDeleteConfirmRoom(room);
    },
    [],
  );

  const performDeleteRoom = useCallback(async () => {
    if (!deleteConfirmRoom || !resolvedMove?.id) return;
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
      queryClient.invalidateQueries({ queryKey: ['homeRooms', resolvedMove.id] });
    } catch {
      setDeleteConfirmRoom(null);
      setDeleteErrorVisible(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirmRoom, resolvedMove?.id, queryClient]);

  const handleRenameRoom = useCallback(async () => {
    if (!editingRoom || !resolvedMove?.id) return;

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
      queryClient.invalidateQueries({ queryKey: ['homeRooms', resolvedMove.id] });
    } catch (err) {
      setEditRoomError(toFriendlyError(err, 'Failed to rename room.'));
    } finally {
      setIsEditingRoom(false);
    }
  }, [editingRoom, resolvedMove?.id, editRoomName, queryClient]);

  // ── Animate inline action buttons when expanded ──
  const manageActionAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (expandedRoomId) {
      manageActionAnim.setValue(0);
      Animated.spring(manageActionAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
      }).start();
    }
  }, [expandedRoomId, manageActionAnim]);

  // Auto-expand the selected room when the manage sheet opens.
  // Delay by 300ms so the sheet's slide-in animation completes first,
  // preventing a visible flicker of the expand animation on first open.
  useEffect(() => {
    if (showManageRooms && selectedRoomId) {
      const timer = setTimeout(() => {
        setExpandedRoomId(selectedRoomId);
      }, 300);
      return () => clearTimeout(timer);
    } else if (!showManageRooms) {
      setExpandedRoomId(null);
    }
  }, [showManageRooms, selectedRoomId]);

  // ── Loading (store not yet loaded, or initial data) ──
  if (!storeLoaded || movesLoading) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <ActivityIndicator size="large" color={colors.primary} />
        </SafeAreaView>
      </View>
    );
  }

  // ── Error fetching user moves ──
  if (movesError) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
            Could not load your moves.
          </Text>
          <Pressable
            onPress={() => queryClient.invalidateQueries({ queryKey: ['userMoves', user?.id] })}
            style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: colors.primary }}>Tap to retry</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  // ── Empty State — No moves at all ──
  if (!userMoves || userMoves.length === 0) {
    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <View style={{ flex: 1 }}>
            <EmptyState
              icon="home-outline"
              title="Welcome to Packly"
              subtitle="Create your first move or join an existing one to start packing."
            />
          </View>
          <View style={styles.emptyActions}>
            <Button
              label="Create Move"
              onPress={() => router.push('/create-move')}
              style={styles.emptyActionBtn}
            />
            <Button
              label="Join a Move"
              variant="secondary"
              onPress={() => router.push('/join-move')}
              style={styles.emptyActionBtn}
            />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── Find the selected room object ──
  const selectedRoom = rooms?.find((r) => r.id === selectedRoomId);

  // ── Main Content — Rooms for active move ──
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        <SearchWidget
          moveId={resolvedMove?.id ?? null}
          trailing={
            <Pressable
              style={({ pressed }) => [styles.settingsBtn, pressed && { opacity: 0.7 }]}
              onPress={() => router.push('/settings' as any)}>
              <Ionicons name="settings-outline" size={22} color={colors.textSecondary} />
            </Pressable>
          }>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={roomsRefetching}
                onRefresh={refetchRooms}
                tintColor={colors.primary}
              />
            }>
            {/* ── Move Selector Header ──────────── */}
            <View style={styles.moveSelector}>
              <Pressable
                style={({ pressed }) => [styles.moveSelectorButton, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  setActionRoom(null);
                  setShowSwitcher(true);
                }}>
                <View style={styles.moveSelectorIcon}>
                  <Ionicons name="home-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title} numberOfLines={1}>
                  {currentMove?.name ?? 'Select a Move'}
                </Text>
                <Ionicons name="chevron-down" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>

            {/* ── Room Tiles ────────────────────── */}
            <View style={styles.roomsSection}>
              {roomsLoading || moveLoading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : roomsError ? (
                <Text style={{ textAlign: 'center', color: colors.textSecondary, paddingVertical: spacing.xl }}>
                  Could not load rooms.
                </Text>
              ) : rooms && rooms.length > 0 ? (
                <>
                  <View style={styles.roomTilesRow}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.roomTilesScroll}>
                      {rooms.map((room) => {
                        const isSelected = room.id === selectedRoomId;
                        return (
                          <Pressable
                            key={room.id}
                            onPress={() => {
                              setSelectedRoomId(room.id);
                            }}
                            style={({ pressed }) => [
                              styles.roomTile,
                              isSelected && styles.roomTileSelected,
                              pressed && !isSelected && { opacity: 0.7 },
                            ]}>
                            <View style={[styles.roomTileIcon, isSelected && styles.roomTileIconSelected]}>
                              <Ionicons
                                name="home-outline"
                                size={22}
                                color={isSelected ? colors.primary : colors.textSecondary}
                              />
                            </View>
                            <Text style={[styles.roomTileName, isSelected && styles.roomTileNameSelected]} numberOfLines={1}>
                              {room.name}
                            </Text>

                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <Pressable
                      style={({ pressed }) => [styles.editRoomsBtn, pressed && { opacity: 0.6 }]}
                      onPress={() => setShowManageRooms(true)}>
                      <Ionicons name="ellipsis-vertical" size={20} color={colors.primary} />
                    </Pressable>
                  </View>

                  {/* ── Selected Room Boxes ────────── */}
                  <View style={styles.selectedRoomSection}>
                    <View style={styles.selectedRoomHeader}>
                      <Text style={font.headline}>{selectedRoom?.name ?? 'Select a room'}</Text>
                    </View>
                    {boxesLoading ? (
                      <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={colors.primary} />
                      </View>
                    ) : roomBoxes && roomBoxes.length > 0 ? (
                      <View style={styles.boxesList}>
                        {roomBoxes.map((box) => (
                          <ListRow
                            key={box.id}
                            iconType="box"
                            title={box.box_number}
                            subtitle={`Qty: ${box.item_count}`}
                            leadingImage={photosByBox?.[box.id]?.[0]?.url ?? null}
                            leadingFill
                            onLeadingPress={
                              photosByBox?.[box.id]?.length
                                ? () => setGalleryBoxId(box.id)
                                : undefined
                            }
                            onPress={() => router.push({ pathname: '/box/[id]', params: { id: box.id } })}
                            onMenuPress={() => handleBoxMenuPress(box)}
                          />
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.emptyBoxesText}>
                        No boxes yet in this room.
                      </Text>
                    )}
                  </View>
                </>
              ) : (
                <Text style={styles.emptyRoomsText}>
                  No rooms yet. Tap + to create your first room.
                </Text>
              )}
            </View>
          </ScrollView>
        </SearchWidget>

        {/* ── Floating Action Button ──────────── */}
        <Pressable
          style={({ pressed }) => [              styles.fab,
              pressed && { transform: [{ scale: 0.92 }] },
          ]}
          onPress={() => {
            if (rooms && rooms.length > 0) {
              // Room exists — add a box to the selected room
              if (!selectedRoomId && rooms.length > 0) {
                setSelectedRoomId(rooms[0].id);
              }
              setShowAddBox(true);
            } else {
              // No rooms yet — add a room
              setShowAddRoom(true);
            }
          }}>
          <Ionicons name="add" size={28} color="#FFFFFF" />
        </Pressable>
      </View>

      {/* ── Move Switcher Bottom Sheet ──────── */}
      <MoveSwitcher
        visible={showSwitcher}
        currentMoveId={resolvedMove?.id ?? null}
        onClose={() => setShowSwitcher(false)}
        onSwitchMove={handleSwitchMove}
      />

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
                ref={boxInputRef}
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

      {/* ── Rename Box Modal ───────────────── */}
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
                ref={editBoxRef}
                style={styles.boxInput}
                placeholder="Box label (e.g. Box 1)"
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

      {/* ── Manage Rooms Bottom Sheet ───────── */}
      <BottomSheet
        visible={showManageRooms}
        onClose={() => setShowManageRooms(false)}
        handleOnly
        sheetStyle={{ backgroundColor: colors.surface, maxHeight: '70%' }}>
        <BottomSheetDraggableArea>
          <Text style={[font.headline, styles.manageTitle]}>Manage Rooms</Text>
        </BottomSheetDraggableArea>

            {/* ── Room List ─────────────────────── */}
            {rooms && rooms.length > 0 ? (
              <ScrollView
                style={styles.manageRoomList}
                showsVerticalScrollIndicator={false}>
                {rooms.map((room) => {
                  const isExpanded = room.id === expandedRoomId;
                  const isSelected = room.id === selectedRoomId;
                  return (
                    <View key={room.id}>
                      <Pressable
                        style={({ pressed }) => [
                          styles.manageRoomRow,
                          isSelected && { backgroundColor: colors.primarySoft },
                          pressed && { opacity: 0.7 },
                        ]}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setSelectedRoomId(room.id);
                          setExpandedRoomId(isExpanded ? null : room.id);
                        }}>
                        <View style={styles.manageRoomLeft}>
                          <View style={[styles.manageRoomIcon, { backgroundColor: isSelected ? colors.primarySoft : colors.roomSoft }]}>
                            <Ionicons name="home-outline" size={18} color={isSelected ? colors.primary : colors.room} />
                          </View>
                          <Text style={[styles.manageRoomName, isSelected && { color: colors.primary }]} numberOfLines={1}>
                            {room.name}
                          </Text>
                          {isSelected && (
                            <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                          )}
                        </View>
                      </Pressable>
                      {isExpanded && (
                        <Animated.View style={[styles.expandActions, {
                          opacity: manageActionAnim,
                          transform: [{ translateY: manageActionAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [-10, 0],
                          })}],
                        }]}>
                          <Pressable
                            style={({ pressed }) => [styles.expandActionBtn, pressed && { opacity: 0.6 }]}
                            onPress={() => {
                              setExpandedRoomId(null);
                              setShowManageRooms(false);
                              setEditRoomName(room.name);
                              setEditRoomError(null);
                              setEditingRoom(room);
                            }}>
                            <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                            <Text style={styles.expandActionText}>Rename</Text>
                          </Pressable>
                          <View style={styles.expandDivider} />
                          <Pressable
                            style={({ pressed }) => [styles.expandActionBtn, pressed && { opacity: 0.6 }]}
                            onPress={() => {
                              setExpandedRoomId(null);
                              setShowManageRooms(false);
                              setDeleteConfirmRoom(room);
                            }}>
                            <Ionicons name="trash-outline" size={18} color={colors.danger} />
                            <Text style={[styles.expandActionText, { color: colors.danger }]}>Delete</Text>
                          </Pressable>
                        </Animated.View>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={styles.manageEmptyText}>No rooms yet.</Text>
            )}

            {/* ── Add Room ──────────────────────── */}
            <View style={[styles.manageAddRow, { borderTopColor: colors.border }]}>
              <Pressable
                style={({ pressed }) => [styles.manageAddBtn, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  setShowManageRooms(false);
                  setShowAddRoom(true);
                }}>
                <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                <Text style={styles.manageAddText}>Add Room</Text>
              </Pressable>
            </View>

            {/* ── Cancel ────────────────────────── */}
            <View style={[styles.manageCancelSection, { backgroundColor: colors.surfaceMuted }]}>
              <Pressable
                style={({ pressed }) => [styles.manageCancelRow, pressed && { opacity: 0.7 }]}
                onPress={() => setShowManageRooms(false)}>
                <Text style={styles.manageCancelText}>Cancel</Text>
              </Pressable>
            </View>
      </BottomSheet>

      {/* ── Box Action Sheet ──────────────────── */}
      <BottomSheet
        visible={!!actionBox}
        onClose={() => setActionBox(null)}
        sheetStyle={{ backgroundColor: colors.surface }}>
        {/* Title doubles as a full-width drag surface (same as Manage Rooms) */}
        <BottomSheetDraggableArea>
          <Text style={[font.headline, styles.manageTitle]}>{actionBox?.box_number}</Text>
        </BottomSheetDraggableArea>

            {/* ── Rename ────────────────────────── */}
            <View style={styles.boxSheetContent}>
              <Pressable
                style={({ pressed }) => [
                  styles.boxSheetActionRow,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => {
                  const box = actionBox;
                  setActionBox(null);
                  if (box) {
                    setEditBoxName(box.box_number);
                    setEditBoxError(null);
                    setEditingBox(box);
                  }
                }}>
                <View style={[styles.boxSheetActionIcon, { backgroundColor: colors.primarySoft }]}>
                  <Ionicons name="pencil-outline" size={20} color={colors.primary} />
                </View>
                <Text style={styles.boxSheetActionText}>Rename</Text>
              </Pressable>

              {/* ── Delete ──────────────────────────── */}
              <View style={[styles.boxSheetDivider, { backgroundColor: colors.divider }]} />
              <Pressable
                style={({ pressed }) => [
                  styles.boxSheetActionRow,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => {
                  const box = actionBox;
                  if (box) handleDeleteBox(box);
                }}>
                <View style={[styles.boxSheetActionIcon, { backgroundColor: colors.dangerSoft }]}>
                  <Ionicons name="trash-outline" size={20} color={colors.danger} />
                </View>
                <Text style={[styles.boxSheetActionText, { color: colors.danger }]}>Delete</Text>
              </Pressable>
            </View>

            {/* ── Cancel ────────────────────────── */}
            <View style={[styles.manageCancelSection, { backgroundColor: colors.surfaceMuted }]}>
              <Pressable
                style={({ pressed }) => [styles.manageCancelRow, pressed && { opacity: 0.7 }]}
                onPress={() => setActionBox(null)}>
                <Text style={styles.manageCancelText}>Cancel</Text>
              </Pressable>
            </View>
      </BottomSheet>

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

      {/* ── Add Room Error ───────────────── */}
      <ConfirmModal
        visible={addRoomAlertVisible}
        title="Error"
        message={addRoomAlertMessage}
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setAddRoomAlertVisible(false)}
        onCancel={() => setAddRoomAlertVisible(false)}
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
        isLoading={isDeletingBox}
      />

      {/* ── Delete Box Error ─────────────── */}
      <ConfirmModal
        visible={deleteBoxErrorVisible}
        title="Error"
        message="Failed to delete box. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setDeleteBoxErrorVisible(false)}
        onCancel={() => setDeleteBoxErrorVisible(false)}
      />

      {/* ── Delete Room Confirmation ─────── */}
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

      {/* ── Box Photo Gallery (opens from the box icon) ── */}
      <BoxPhotoGallery
        boxId={galleryBoxId}
        photos={galleryPhotos}
        onClose={() => setGalleryBoxId(null)}
        onPhotosChanged={invalidateHomePhotos}
      />
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centeredContainer: {
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
  },
  centeredSafeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },
  scrollContent: {
    paddingBottom: 120, // space for FAB
  },

  // ── Move Selector ────────────────────
  moveSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  moveSelectorButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  settingsBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  moveSelectorIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },

  // ── Rooms ──────────────────────────
  roomsSection: {
    paddingTop: spacing.md,
  },
  loadingContainer: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  roomsList: {
    gap: spacing.md,
  },
  emptyRoomsText: {
    textAlign: 'center',
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
    color: colors.textSecondary,
    fontFamily: fonts.regular,
    fontSize: 15,
  },

  // ── Room Tiles ───────────────────────
  roomTilesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.xl,
  },
  roomTilesScroll: {
    gap: spacing.md,
    paddingRight: spacing.sm,
  },
  roomTile: {
    width: 88,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  roomTileSelected: {
    backgroundColor: colors.primarySoft,
  },
  roomTileIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  roomTileIconSelected: {
    backgroundColor: colors.primary + '18',
  },
  roomTileName: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
    textAlign: 'center',
  },
  roomTileNameSelected: {
    color: colors.primary,
  },
  editRoomsBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
    marginRight: spacing.xl,
    borderCurve: 'continuous',
  },

  // ── Selected Room Boxes ──────────────
  selectedRoomSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  selectedRoomHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  boxesList: {
    gap: spacing.sm,
  },
  emptyBoxesText: {
    textAlign: 'center',
    marginTop: spacing.lg,
    color: colors.textSecondary,
    fontFamily: fonts.regular,
    fontSize: 15,
  },

  // ── Empty State Actions ─────────────
  emptyActions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  emptyActionBtn: {
    flex: 1,
  },

  // ── Floating Action Button ──────────
  fab: {
    position: 'absolute',
    bottom: spacing.xxl,
    right: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
    elevation: 4,
  },

  // ── Box Input ───────────────────────
  boxInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
  },

  // ── Room Input ──────────────────────
  roomInput: {
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
    borderRadius: radius.md,
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
  pressed: {
    opacity: 0.7,
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  manageTitle: {
    textAlign: 'center',
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
  },
  manageRoomList: {
    maxHeight: 280,
    paddingHorizontal: spacing.xl,
  },
  manageRoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginBottom: 4,
    borderCurve: 'continuous',
  },
  manageRoomLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  manageRoomIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  manageRoomName: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1,
  },
  manageRoomAction: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Box Action Sheet Content ────────────
  boxSheetContent: {
    paddingHorizontal: spacing.xl,
  },
  boxSheetActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  boxSheetActionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  boxSheetActionText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  boxSheetDivider: {
    height: 1,
    marginLeft: 68,
    marginVertical: 0,
  },

  // ── Expandable Action Buttons ────────────
  expandActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
    paddingLeft: 60, // Aligns with room name text (scroll padding 20 + row padding 12 + icon 36 + gap 12 = 80, so 80 - 20 = 60)
  },
  expandActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    borderCurve: 'continuous',
  },
  expandActionText: {
    fontSize: 14,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.primary,
  },
  expandDivider: {
    width: 1,
    height: 20,
    backgroundColor: colors.border,
  },
  manageEmptyText: {
    textAlign: 'center',
    color: colors.textSecondary,
    paddingVertical: spacing.xl,
    fontFamily: fonts.regular,
    fontSize: 15,
  },
  manageAddRow: {
    borderTopWidth: 0.5,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  manageAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  manageAddText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.primary,
  },
  manageCancelSection: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    borderRadius: 14,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  manageCancelRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  manageCancelText: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
  },
});
