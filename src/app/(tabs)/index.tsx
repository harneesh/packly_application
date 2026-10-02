import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  KeyboardAvoidingView,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import ListRow from '../../../packly-ui/components/ListRow';
import Button from '../../../packly-ui/components/Button';
import EmptyState from '../../../packly-ui/components/EmptyState';
import AddRoomModal from '../../../packly-ui/components/AddRoomModal';
import SearchWidget from '@/components/search-widget';
import { ROOM_EMOJI_OPTIONS, roomEmoji } from '../../../packly-ui/components/roomEmoji';
import { useUiStore } from '@/store/ui-store';
import BoxPhotoGallery from '@/components/box-photo-gallery';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import MoveSwitcher from '@/components/move-switcher';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import { colors, spacing, font, radius, shadow, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { fetchBoxPhotosByBox, deleteStorageForBoxIds } from '@/services/photos';
import { sortByBoxNumber } from '@/services/rooms';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import { toFriendlyError } from '@/lib/errors';
import { fetchJoinRequests } from '@/services/members';

import type { Move, Room, Box } from '@/types/database';

/**
 * Counts shown on the Home progress card, tallied across EVERY room of the
 * active move. Lives in its own query (key: ['moveProgress', moveId]) so the
 * card survives room switches — which means every mutation that changes box
 * counts or packed state has to update this cache as well as the room's box
 * list, or the card goes stale.
 */
type MoveProgress = {
  totalItems: number;
  totalBoxes: number;
  packedBoxes: number;
};

/** Box shape returned by the Home box list (box + live item count). */
type HomeBox = Box & { item_count: number };

/** Spring that settles the room section after a swipe (in, or back to rest). */
const ROOM_SPRING = { damping: 22, stiffness: 220, mass: 0.9 };

/**
 * A room's boxes with live item counts. Shared by the selected room's query
 * and the neighbour prefetch (so a swipe lands on cached content).
 */
async function fetchRoomBoxes(roomId: string): Promise<HomeBox[]> {
  const { data, error } = await supabase
    .from('boxes')
    .select('*')
    .eq('room_id', roomId)
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
  // Natural box order ("Box 2" before "Box 10") — the SQL order above is
  // lexicographic because box_number is TEXT.
  return sortByBoxNumber(boxes.map((b) => ({ ...b, item_count: counts.get(b.id) ?? 0 })));
}

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function fetchUserMoves(userId: string): Promise<Move[]> {
  // Membership means "row in move_members OR owner" — the same rule the
  // database uses (is_move_member_for). Asking only for member rows hides a
  // move from its own owner whenever that row is missing (the owner's
  // self-insert can be rejected), so ask for both.
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

/** Quick-name suggestions in the Add Box modal (mockup §4). */
const QUICK_BOX_NAMES = ['Books', 'Fragile', 'Kitchen', 'Bedding', 'Documents'];

/**
 * The kraft tile prints the box's NUMBER (mockup §1: Box 1 → "1").
 * Extracts the digits from the label; null when there is none.
 */
function boxNumberLabel(boxNumber: string): string | null {
  const match = boxNumber.match(/\d+/);
  return match ? match[0] : null;
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
let homeBoxesChannelSeq = 0;
let homeMembershipChannelSeq = 0;

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
  const [roomBoxCounts, setRoomBoxCounts] = useState<Map<string, number>>(new Map());
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

  // ── Box action sheet (long press on a box row) ──
  // The same Rename / Delete sheet the box screen opens from its header ⋯,
  // so the two places share one interaction (and one set of cache updates).
  const [actionBox, setActionBox] = useState<HomeBox | null>(null);
  const [editingBox, setEditingBox] = useState<HomeBox | null>(null);
  const [editBoxName, setEditBoxName] = useState('');
  const [editBoxError, setEditBoxError] = useState<string | null>(null);
  const [isEditingBox, setIsEditingBox] = useState(false);
  const editBoxRef = useRef<TextInput>(null);
  const [deleteConfirmBox, setDeleteConfirmBox] = useState<HomeBox | null>(null);
  const [isDeletingBox, setIsDeletingBox] = useState(false);
  const [deleteBoxErrorVisible, setDeleteBoxErrorVisible] = useState(false);

  const [galleryBoxId, setGalleryBoxId] = useState<string | null>(null);

  // "You were removed from this move" notice, raised by the membership
  // realtime subscription below. null while nothing is showing.
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);

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
    // Safety net for the membership subscription below: Realtime cannot
    // RLS-check DELETE events (and only filters them server-side when the
    // table's replica identity is FULL), so a removal may not reach us live.
    // A gentle poll means Home still corrects itself within a minute.
    refetchInterval: 60000,
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
          // The progress card's "items in N boxes" total moves with items too.
          queryClient.invalidateQueries({ queryKey: ['moveProgress', moveId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [resolvedMove?.id, selectedRoomId, queryClient]);

  // ── Realtime subscription — boxes added/renamed/packed/deleted by others ──
  // boxes has no move_id to filter on, so this listens to every box event the
  // user may see (Realtime applies the boxes SELECT policy per subscriber) and
  // refreshes by prefix: only the mounted room's list actually refetches. A
  // DELETE payload carries only the box id, so the room cannot be targeted.
  const [boxesVersion, setBoxesVersion] = useState(0);
  useEffect(() => {
    const moveId = resolvedMove?.id;
    if (!moveId) return;

    // Module-level counter (same pattern as homeRoomChannelSeq).
    const id = ++homeBoxesChannelSeq;
    const channel = supabase
      .channel(`home-${moveId}-boxes-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'boxes' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['roomBoxes'] });
          queryClient.invalidateQueries({ queryKey: ['moveProgress', moveId] });
          // Re-tally the per-room counts in the Manage Rooms sheet.
          setBoxesVersion((v) => v + 1);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [resolvedMove?.id, queryClient]);

  // ── Realtime subscription — notice the moment a move is taken away ──
  // Owners remove people from the members sheet; move_members is already in
  // the realtime publication, so the client hears about it instead of quietly
  // keeping a move it can no longer read. A DELETE payload carries only the
  // primary key — (move_id, user_id) here — which is exactly what is needed to
  // know WHICH move went away.
  //
  // Realtime cannot RLS-check DELETE events, and it only applies server-side
  // filters to them when the table's replica identity is FULL, so this
  // subscription can also see other people's membership rows being deleted:
  // the user_id check below is what decides the event is ours. Do not remove it.
  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;

    // Module-level counter (same pattern as homeRoomChannelSeq) so remounts
    // can never collide with a channel whose removal is still in flight.
    const id = ++homeMembershipChannelSeq;
    const channel = supabase
      .channel(`home-${userId}-membership-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'move_members',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const old = payload.old as { move_id?: string; user_id?: string } | null;
          if (!old || old.user_id !== userId || !old.move_id) return;

          const removedMoveId = old.move_id;

          // The move's name has to be read BEFORE the list is rewritten —
          // afterwards it is gone from the cache.
          const removedMoveName = queryClient
            .getQueryData<Move[]>(['userMoves', userId])
            ?.find((m) => m.id === removedMoveId)?.name;

          // Drop the move from the cached list right away: that list is
          // persisted for 24h, and until the refetch lands the active-move
          // sync effect would otherwise fall back onto a move the user can no
          // longer open.
          queryClient.setQueryData<Move[]>(['userMoves', userId], (prev) =>
            prev ? prev.filter((m) => m.id !== removedMoveId) : prev,
          );
          queryClient.invalidateQueries({ queryKey: ['userMoves', userId] });
          queryClient.invalidateQueries({ queryKey: ['moves', userId] });
          queryClient.invalidateQueries({ queryKey: ['homeRooms'] });

          const { activeMoveId: currentActiveMoveId } = useActiveMoveStore.getState();
          if (removedMoveId === currentActiveMoveId) {
            setActiveMove(null);
            setRemovalNotice(
              removedMoveName
                ? `You no longer have access to "${removedMoveName}". Anything you packed stays in the move.`
                : 'You no longer have access to that move. Anything you packed stays in the move.',
            );
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient, setActiveMove]);

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
    queryFn: () => (selectedRoomId ? fetchRoomBoxes(selectedRoomId) : Promise.resolve([])),
    enabled: !!selectedRoomId,
  });

  const boxIds = roomBoxes?.map((b) => b.id) ?? [];

  // ── Per-room box counts for the Manage Rooms sheet (mockup §3) ──
  useEffect(() => {
    if (!resolvedMove || rooms?.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('boxes')
        .select('room_id')
        .in(
          'room_id',
          (rooms ?? []).map((r) => r.id),
        );
      if (cancelled || !data) return;
      const counts = new Map<string, number>();
      for (const room of rooms ?? []) counts.set(room.id, 0);
      for (const row of data) {
        counts.set(row.room_id, (counts.get(row.room_id) ?? 0) + 1);
      }
      setRoomBoxCounts(counts);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [resolvedMove?.id, rooms, boxesVersion]);

  // ── Photos for the selected room's boxes (first photo becomes the box icon) ──
  // staleTime: 5 min — serve from cache on navigation, only refetch when stale.
  const { data: photosByBox } = useQuery({
    queryKey: ['room-photos', selectedRoomId],
    queryFn: () => fetchBoxPhotosByBox(boxIds),
    enabled: boxIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const galleryPhotos = galleryBoxId ? (photosByBox?.[galleryBoxId] ?? []) : [];

  const invalidateHomePhotos = useCallback(
    (boxId: string) => {
      queryClient.invalidateQueries({ queryKey: ['room-photos', selectedRoomId] });
      queryClient.invalidateQueries({ queryKey: ['box-photos', boxId] });
    },
    [queryClient, selectedRoomId],
  );



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
      queryClient.invalidateQueries({ queryKey: ['moveProgress', resolvedMove?.id] });

      // Navigate to the new box to show the label prompt
      if (newBox) {
        setTimeout(() => router.push({ pathname: '/box/[id]', params: { id: newBox.id } }), 200);
      }
    } catch (err) {
      setAddBoxError(toFriendlyError(err, 'Failed to add box.'));
    } finally {
      setIsAddingBox(false);
    }
  }, [selectedRoomId, user, boxName, queryClient, resolvedMove]);

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

  // ── Box rename/delete (long press on a box row) ──
  // Mirrors the box screen's header ⋯ sheet: same copy, same storage-first
  // delete order, same cache invalidations.
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
      queryClient.invalidateQueries({ queryKey: ['boxes', editingBox.room_id] });
      // The box screen keeps its own copy of this box.
      queryClient.invalidateQueries({ queryKey: ['box', editingBox.id] });
    } catch (err) {
      setEditBoxError(toFriendlyError(err, 'Failed to rename box.'));
    } finally {
      setIsEditingBox(false);
    }
  }, [editingBox, editBoxName, queryClient]);

  const performDeleteBox = useCallback(async () => {
    if (!deleteConfirmBox) return;
    setIsDeletingBox(true);

    try {
      // Remove storage files BEFORE the DB cascade deletes the box row
      // (storage DELETE RLS requires the box to exist).
      await deleteStorageForBoxIds([deleteConfirmBox.id]);

      const { error } = await supabase
        .from('boxes')
        .delete()
        .eq('id', deleteConfirmBox.id);

      if (error) throw new Error(error.message);

      const roomId = deleteConfirmBox.room_id;
      const boxId = deleteConfirmBox.id;
      setDeleteConfirmBox(null);
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', roomId] });
      queryClient.invalidateQueries({ queryKey: ['boxes', roomId] });
      queryClient.invalidateQueries({ queryKey: ['box', boxId] });
      // The progress card tallies boxes for the whole move, and the photos map
      // still holds this box's shots.
      queryClient.invalidateQueries({ queryKey: ['moveProgress', resolvedMove?.id] });
      invalidateHomePhotos(boxId);
      // The Manage Rooms sheet counts boxes per room — keep it honest now
      // instead of waiting for the next refetch (that effect only watches the
      // room list, which a box deletion does not change).
      setRoomBoxCounts((prev) => {
        const next = new Map(prev);
        next.set(roomId, Math.max(0, (next.get(roomId) ?? 0) - 1));
        return next;
      });
    } catch {
      setDeleteConfirmBox(null);
      setDeleteBoxErrorVisible(true);
    } finally {
      setIsDeletingBox(false);
    }
    // `resolvedMove` (not `.id`) matches what the compiler infers from the body.
  }, [deleteConfirmBox, queryClient, resolvedMove, invalidateHomePhotos]);

  // ── Focus the rename input once the sheet hands over to it ──
  useEffect(() => {
    if (!editingBox) return;
    const timer = setTimeout(() => {
      editBoxRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [editingBox]);

  // ── Toggle packed on a box (mockup §1 status pills) ──
  // Tap the pill: Empty/Packing → Packed, Packed → Packing. Boxes with no
  // items can't be marked packed — the pill is disabled ("Empty").
  //
  // Two caches have to move together: the room's box list (the pill itself)
  // and the move-wide progress card, which reads "x of y boxes packed" from
  // the SEPARATE ['moveProgress'] query. Updating only the room list left that
  // caption frozen until the query happened to refetch.
  const handleTogglePacked = useCallback(
    async (box: Box) => {
      const moveId = resolvedMove?.id;
      // Read the current state from the cache rather than the pressed row's
      // props: a quick second tap would otherwise flip a stale value back.
      const cachedBoxes = queryClient.getQueryData<HomeBox[]>(['roomBoxes', selectedRoomId]);
      const currentlyPacked =
        cachedBoxes?.find((b) => b.id === box.id)?.is_packed ?? box.is_packed;
      const nextPacked = !currentlyPacked;

      // Optimistic update — the pill flips instantly.
      queryClient.setQueryData<HomeBox[]>(['roomBoxes', selectedRoomId], (prev) =>
        prev?.map((b) => (b.id === box.id ? { ...b, is_packed: nextPacked } : b)) ?? prev,
      );
      // …and the progress card's packed tally moves by the same amount.
      if (moveId) {
        const delta = nextPacked ? 1 : -1;
        queryClient.setQueryData<MoveProgress>(['moveProgress', moveId], (prev) =>
          prev ? { ...prev, packedBoxes: Math.max(0, prev.packedBoxes + delta) } : prev,
        );
      }

      try {
        const { error } = await supabase
          .from('boxes')
          .update({ is_packed: nextPacked })
          .eq('id', box.id);
        if (error) throw new Error(error.message);
      } catch {
        // Roll back on failure.
        queryClient.invalidateQueries({ queryKey: ['roomBoxes', selectedRoomId] });
        queryClient.invalidateQueries({ queryKey: ['moveProgress', moveId] });
      }
    },
    [queryClient, selectedRoomId, resolvedMove?.id],
  );

  // ── Swipe between rooms ──────────────────────────────────
  // Home browses ONE room at a time, so swiping the selected room's section
  // sideways pages to the neighbouring room: finger left → the next room
  // slides in from the right, finger right → the previous one. The gesture is
  // scoped to that section on purpose — the search bar, the progress card and
  // the room chips above it never move.
  //
  // Gesture Handler + Reanimated, so the drag and every slide run on the UI
  // thread: this screen re-renders a lot, and a JS-driven pan (PanResponder)
  // stuttered whenever React was busy and could be stolen mid-drag by the
  // page's vertical scroll. Here the pan only activates on a clearly
  // horizontal drag (activeOffsetX) and gives up on a vertical one
  // (failOffsetY), so the page's ScrollView keeps vertical scrolling.
  //
  // A committed swipe slides the section out on the UI thread, swaps the
  // room on JS, and only slides the new room in AFTER it has rendered (see
  // the layout effect below) — so the slide-in never competes with the
  // render or shows the old room a second time.
  const { width: windowWidth } = useWindowDimensions();
  const roomPanX = useSharedValue(0);
  // True while a committed swipe is sliding out + in — blocks re-entry so two
  // selections can never race each other. Read on the UI thread.
  const roomSwitchBusy = useSharedValue(false);
  // The committed swipe whose new room is waiting to slide in. A fresh object
  // per swipe, so the slide-in effect below runs exactly once for each.
  const [roomSlideIn, setRoomSlideIn] = useState<{ direction: 1 | -1 } | null>(null);

  // Position of the selected room in the list, captured by the worklets.
  const roomIndex = (rooms ?? []).findIndex((r) => r.id === selectedRoomId);
  const roomCount = rooms?.length ?? 0;

  const commitRoomSwipe = useCallback(
    (direction: 1 | -1) => {
      const list = rooms ?? [];
      const index = list.findIndex((r) => r.id === selectedRoomId);
      const next = index === -1 ? undefined : list[index + direction];
      if (!next) {
        // The room list changed under the swipe — just bring the section back.
        roomPanX.set(withSpring(0, ROOM_SPRING));
        roomSwitchBusy.set(false);
        return;
      }
      setRoomSlideIn({ direction });
      setSelectedRoomId(next.id);
    },
    [rooms, selectedRoomId, roomPanX, roomSwitchBusy],
  );

  // The new room has rendered (still off-screen) — slide it in from the edge
  // opposite the swipe. Layout effect: runs before the frame is painted.
  useLayoutEffect(() => {
    if (!roomSlideIn) return;
    roomPanX.set(roomSlideIn.direction * windowWidth);
    roomPanX.set(
      withSpring(0, ROOM_SPRING, () => {
        roomSwitchBusy.set(false);
      }),
    );
    // windowWidth is read once per swipe on purpose — a rotation must not
    // replay the last slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomSlideIn]);

  // Warm the neighbouring rooms' boxes so a swipe lands on content instead of
  // a spinner (and a section that changes height mid-slide).
  useEffect(() => {
    if (!rooms || roomIndex === -1) return;
    for (const neighbour of [rooms[roomIndex - 1], rooms[roomIndex + 1]]) {
      if (!neighbour) continue;
      queryClient.prefetchQuery({
        queryKey: ['roomBoxes', neighbour.id],
        queryFn: () => fetchRoomBoxes(neighbour.id),
        staleTime: 30 * 1000,
      });
    }
  }, [rooms, roomIndex, queryClient]);

  const roomPager = useMemo(
    () =>
      Gesture.Pan()
        // Claim only a clearly HORIZONTAL drag, and only while another room is
        // within reach — taps and the page's vertical scroll are untouched.
        .enabled(roomCount > 1)
        .activeOffsetX([-12, 12])
        .failOffsetY([-14, 14])
        .onStart(() => {
          // A spring-back may still be running from the previous swipe — take
          // the value over cleanly instead of fighting it.
          if (!roomSwitchBusy.get()) cancelAnimation(roomPanX);
        })
        .onUpdate((e) => {
          if (roomSwitchBusy.get()) return;
          const atEdge =
            (e.translationX > 0 && roomIndex <= 0) ||
            (e.translationX < 0 && roomIndex === roomCount - 1);
          // At the first/last room only a sliver follows the finger, so the
          // edge is FELT instead of the section sliding off into nothing.
          roomPanX.set(e.translationX * (atEdge ? 0.18 : 1));
        })
        .onEnd((e) => {
          if (roomSwitchBusy.get()) return;
          const direction: 1 | -1 = e.translationX < 0 ? 1 : -1;
          const target = roomIndex + direction;
          const hasTarget = roomIndex !== -1 && target >= 0 && target < roomCount;
          // A quick flick counts too, so a full-width drag is never required —
          // but a flick back against the drag cancels it.
          const farEnough =
            Math.abs(e.translationX) > Math.min(96, windowWidth * 0.3) ||
            Math.abs(e.velocityX) > 500;
          const flickedBack = e.velocityX * e.translationX < 0 && Math.abs(e.velocityX) > 500;
          if (!hasTarget || !farEnough || flickedBack) {
            roomPanX.set(withSpring(0, ROOM_SPRING));
            return;
          }
          roomSwitchBusy.set(true);
          roomPanX.set(
            withTiming(
              -direction * windowWidth,
              { duration: 150, easing: Easing.out(Easing.quad) },
              (finished) => {
                if (finished) {
                  runOnJS(commitRoomSwipe)(direction);
                } else {
                  roomSwitchBusy.set(false);
                }
              },
            ),
          );
        })
        .onFinalize((_e, success) => {
          // Gesture cancelled (e.g. the vertical scroll won) — put it back.
          if (!success && !roomSwitchBusy.get()) {
            roomPanX.set(withSpring(0, ROOM_SPRING));
          }
        }),
    [roomCount, roomIndex, windowWidth, roomPanX, roomSwitchBusy, commitRoomSwipe],
  );

  const roomSectionStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: roomPanX.get() }],
  }));

  // ── Keep the selected room's chip on screen ──────────────
  // A swipe can land on a room whose chip has scrolled out of the row, which
  // would leave the chips pointing at a room you cannot see. Chip offsets come
  // from onLayout and the row is nudged ONLY when the chip is actually out of
  // view, so tapping a visible chip never makes the row jump.
  const chipsScrollRef = useRef<ScrollView>(null);
  const chipsScrollX = useRef(0);
  const chipsViewportWidth = useRef(0);
  const roomChipLayouts = useRef<Map<string, { x: number; width: number }>>(new Map());

  useEffect(() => {
    if (!selectedRoomId) return;
    const chip = roomChipLayouts.current.get(selectedRoomId);
    const viewport = chipsViewportWidth.current;
    if (!chip || viewport === 0) return;

    const edge = spacing.md;
    const offset = chipsScrollX.current;
    if (chip.x - edge < offset) {
      chipsScrollRef.current?.scrollTo({ x: Math.max(0, chip.x - edge), animated: true });
    } else if (chip.x + chip.width + edge > offset + viewport) {
      chipsScrollRef.current?.scrollTo({
        x: chip.x + chip.width + edge - viewport,
        animated: true,
      });
    }
  }, [selectedRoomId]);

  // ── Each room gets a stable soft accent tint, rotated by its position in
  // the room list. Shared by the Home chips and the "Rooms" sheet, so a room
  // keeps the same colour in both places (same order → same index). ──
  const roomAccentPalette = useMemo(
    () => [colors.primary, colors.room, colors.item, colors.packing, colors.packed, colors.box],
    [],
  );

  // ── Move-wide progress (mockup §1 navy card) ──
  // Boxes + item counts across ALL rooms of the move are tallied in one
  // query (per-box counts in SQL), so the card survives room switches.
  const { data: moveProgress } = useQuery({
    queryKey: ['moveProgress', resolvedMove?.id],
    queryFn: async () => {
      if (!resolvedMove) return { totalItems: 0, totalBoxes: 0, packedBoxes: 0 };

      const { data: moveRooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id')
        .eq('move_id', resolvedMove.id);
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
    enabled: !!resolvedMove,
  });

  // ── People waiting to join this move (owner signal) ──
  // Same query key as the Move screen's members sheet, so approving somebody
  // there clears this banner the moment the owner comes back. Owners poll —
  // a new request should show up on Home by itself, with no manual refresh.
  // The server answers an empty list for non-owners, and the query is gated
  // on ownership anyway so nobody else polls for an answer they cannot get.
  const { data: joinRequests } = useQuery({
    queryKey: ['join-requests', resolvedMove?.id],
    queryFn: () => fetchJoinRequests(resolvedMove!.id),
    enabled: !!resolvedMove && resolvedMove.owner_id === user?.id,
    refetchInterval: 15000,
  });

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

  // ── Room icon (rooms.emoji, migration 020) ──
  // The picker lives in the Manage Rooms sheet. Saving is OPTIMISTIC: the
  // chip, the sheet row and every other list holding this room repaint
  // immediately; a failed save refetches the move's rooms so the UI falls
  // back to whatever is actually stored.
  const handleSetRoomEmoji = useCallback(
    async (room: Room, emoji: string) => {
      const moveId = resolvedMove?.id;
      if (!moveId) return;

      queryClient.setQueryData<Room[]>(['homeRooms', moveId], (prev) =>
        prev?.map((r) => (r.id === room.id ? { ...r, emoji } : r)) ?? prev,
      );

      try {
        const { error } = await supabase
          .from('rooms')
          .update({ emoji })
          .eq('id', room.id);
        if (error) {
          // Log the raw details before flattening into the generic alert: a
          // missing column (42703 / PGRST204) or an RLS denial is otherwise
          // indistinguishable from a network blip.
          console.error('[ROOM ICON UPDATE ERROR]', error.message, error.code, error.details);
          throw new Error(error.message);
        }

        // The Move screen and search read the same rows under ['rooms', …].
        queryClient.invalidateQueries({ queryKey: ['rooms', moveId] });
      } catch (err) {
        queryClient.invalidateQueries({ queryKey: ['homeRooms', moveId] });
        setAddRoomAlertMessage(
          toFriendlyError(err, 'Failed to update the room icon.'),
        );
        setAddRoomAlertVisible(true);
      }
    },
    [queryClient, resolvedMove?.id],
  );

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
          header={
            <View style={styles.homeHeaderRow}>
              <Pressable
                style={({ pressed }) => [styles.moveSelectorButton, pressed && { opacity: 0.7 }]}
                onPress={() => {
                  setActionRoom(null);
                  setShowSwitcher(true);
                }}>
                <View style={styles.moveSelectorIcon}>
                  <Ionicons name="home" size={16} color={colors.accentDeep} />
                </View>
                <Text style={[styles.moveSelectorName, font.bodyMedium]} numberOfLines={1}>
                  {currentMove?.name ?? 'Select a Move'}
                </Text>
                <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.settingsBtn, pressed && { opacity: 0.7 }]}
                onPress={() => router.push('/settings' as any)}>
                <Ionicons name="settings-outline" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
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

            {/* ── Progress Card (mockup §1) — tap for full analytics ───────── */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open move progress analytics"
              style={({ pressed }) => [styles.progressCard, pressed && { opacity: 0.85 }]}
              onPress={() => router.push('/move-analytics')}>
              <View style={styles.progressFold} />
              <View style={styles.progressRow}>
                <Text style={styles.progressBig}>
                  {moveProgress?.totalItems ?? 0}
                </Text>
                <Text style={styles.progressLabel}>
                  items in {moveProgress?.totalBoxes ?? 0}{' '}
                  {(moveProgress?.totalBoxes ?? 0) === 1 ? 'box' : 'boxes'}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width:
                        moveProgress && moveProgress.totalBoxes > 0
                          ? `${Math.round((moveProgress.packedBoxes / moveProgress.totalBoxes) * 100)}%`
                          : '0%',
                    },
                  ]}
                />
              </View>
              <Text style={styles.progressCaption}>
                {moveProgress && moveProgress.totalBoxes > 0
                  ? `${moveProgress.packedBoxes} of ${moveProgress.totalBoxes} ${
                      moveProgress.totalBoxes === 1 ? 'box' : 'boxes'
                    } packed`
                  : 'Add your first box to start'}
              </Text>
            </Pressable>

            {/* ── People waiting to join (owner only) ───────────
                Tapping opens the move screen with the members sheet already
                up, where the approval queue lives.
                Hidden entirely while the queue is empty so the owner never
                sees a permanent "0 waiting" row. ── */}
            {joinRequests && joinRequests.length > 0 && resolvedMove ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  joinRequests.length === 1
                    ? '1 person wants to join this move'
                    : `${joinRequests.length} people want to join this move`
                }
                style={({ pressed }) => [styles.joinBanner, pressed && { opacity: 0.85 }]}
                onPress={() =>
                  router.push({
                    pathname: '/move/[id]',
                    params: { id: resolvedMove.id, members: '1' },
                  })
                }>
                <View style={styles.joinBannerIcon}>
                  <Ionicons name="person-add-outline" size={17} color={colors.navyDeep} />
                </View>
                <View style={styles.joinBannerText}>
                  <Text style={styles.joinBannerTitle}>
                    {joinRequests.length === 1
                      ? '1 person wants to join'
                      : `${joinRequests.length} people want to join`}
                  </Text>
                  <Text style={styles.joinBannerHint}>Tap to review and approve</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.navyDeep} />
              </Pressable>
            ) : null}

            {/* ── Room Chips (mockup §1) ─────────── */}
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
                      ref={chipsScrollRef}
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.roomTilesScrollArea}
                      contentContainerStyle={styles.roomTilesScroll}
                      onLayout={(e) => {
                        chipsViewportWidth.current = e.nativeEvent.layout.width;
                      }}
                      onScroll={(e) => {
                        chipsScrollX.current = e.nativeEvent.contentOffset.x;
                      }}
                      scrollEventThrottle={16}>
                      {rooms.map((room, index) => {
                        const isSelected = room.id === selectedRoomId;
                        const chipColor = roomAccentPalette[index % roomAccentPalette.length];
                        return (
                          <Pressable
                            key={room.id}
                            onLayout={(e) => {
                              roomChipLayouts.current.set(room.id, {
                                x: e.nativeEvent.layout.x,
                                width: e.nativeEvent.layout.width,
                              });
                            }}
                            onPress={() => {
                              setSelectedRoomId(room.id);
                            }}
                            style={({ pressed }) => [
                              styles.roomChip,
                              isSelected && styles.roomChipSelected,
                              pressed && !isSelected && { opacity: 0.7 },
                            ]}>
                            {/* The dot keeps the room's own soft accent tint in
                                both states — on the light selected fill a
                                frosted-white disc would vanish. */}
                            <View style={[styles.roomChipDot, { backgroundColor: chipColor + '22' }]}>
                              <Text style={styles.roomChipEmoji}>{roomEmoji(room.name, room.emoji)}</Text>
                            </View>
                            <Text
                              style={[styles.roomChipName, isSelected && styles.roomChipNameSelected]}
                              numberOfLines={1}>
                              {room.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>

                    {/* ── Edit — half-pill tab on the screen's right edge ──
                        Only the LEFT corners are rounded and the right side sits
                        flush against the screen edge, so it reads as half a pill
                        sliding in from the side. Opens the Manage Rooms sheet
                        (rows: rename, delete, room icon + its Add room pill),
                        which the redesign had left without any trigger. ── */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Edit"
                      style={({ pressed }) => [styles.editRoomTab, pressed && { opacity: 0.85 }]}
                      onPress={() => setShowManageRooms(true)}>
                      <Ionicons name="pencil-outline" size={16} color="#FFFFFF" />
                      <Text style={styles.editRoomTabText}>Edit</Text>
                    </Pressable>
                  </View>

                  {/* ── Selected Room Boxes ──────────
                      Swiping this section sideways pages to the neighbouring
                      room. The pan is scoped to the section on purpose — the
                      search bar, the progress card and the room chips above it
                      stay exactly where they are. ── */}
                  <GestureDetector gesture={roomPager}>
                  <Reanimated.View style={[styles.selectedRoomSection, roomSectionStyle]}>
                    <View style={styles.selectedRoomHeader}>
                      <Text style={font.title}>{selectedRoom?.name ?? 'Select a room'}</Text>
                      <Text style={styles.selectedRoomCount}>
                        {roomBoxes && roomBoxes.length > 0
                          ? `${roomBoxes.length} box${roomBoxes.length !== 1 ? 'es' : ''}`
                          : 'No boxes'}
                      </Text>
                    </View>
                    {boxesLoading ? (
                      <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={colors.primary} />
                      </View>
                    ) : roomBoxes && roomBoxes.length > 0 ? (
                      <View style={styles.boxesList}>
                        {roomBoxes.map((box) => {
                          const status: 'packed' | 'packing' | 'empty' =
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
                                  ? () => setGalleryBoxId(box.id)
                                  : undefined
                              }
                              onPress={() => router.push({ pathname: '/box/[id]', params: { id: box.id } })}
                              onLongPress={() => setActionBox(box)}
                            />
                          );
                        })}
                      </View>
                    ) : (
                      <View style={styles.emptyRoomState}>
                        <View style={styles.emptyRoomDash}>
                          <Ionicons name="cube-outline" size={34} color={colors.textTertiary} />
                        </View>
                        <Text style={styles.emptyRoomTitle}>
                          No boxes in {selectedRoom?.name ?? 'this room'} yet
                        </Text>
                        <Text style={styles.emptyRoomSubtitle}>
                          Add a box, then say what goes in it.
                        </Text>
                        <Pressable
                          style={({ pressed }) => [
                            styles.emptyRoomBtn,
                            pressed && { opacity: 0.85 },
                          ]}
                          onPress={() => setShowAddBox(true)}>
                          <Text style={styles.emptyRoomBtnText}>Add first box</Text>
                        </Pressable>
                      </View>
                    )}
                  </Reanimated.View>
                  </GestureDetector>
                </>
              ) : (
                <View style={styles.noRoomsWrap}>
                  <Text style={styles.emptyRoomsText}>
                    No rooms yet. Tap + to create your first room.
                  </Text>
                </View>
              )}
            </View>
          </ScrollView>
        </SearchWidget>

        {/* ── Floating Action Button (mockup §1: labeled "+ Add box") ── */}
        <Pressable
          style={({ pressed }) => [
            styles.fab,
            pressed && { transform: [{ scale: 0.96 }] },
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
          {rooms && rooms.length > 0 ? (
            <>
              <Ionicons name="add" size={18} color="#FFFFFF" />
              <Text style={styles.fabText}>Add box</Text>
            </>
          ) : (
            <Ionicons name="add" size={28} color="#FFFFFF" />
          )}
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
          behavior="padding">
          <ModalBackdrop
            visible={!!editingRoom}
            onBackdropPress={() => {
              setEditingRoom(null);
              setEditRoomName('');
              setEditRoomError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.title, { marginBottom: spacing.sm }]}>Rename Room</Text>

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
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setEditingRoom(null);
                    setEditRoomName('');
                    setEditRoomError(null);
                  }}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnGhost,
                    pressed && styles.pressed,
                  ]}>
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

              {/* ── Quick names (mockup §4) — one tap fills the label ── */}
              <View style={styles.quickNamesWrap}>
                <Text style={styles.quickNamesLabel}>Quick names</Text>
                <View style={styles.quickNamesRow}>
                  {QUICK_BOX_NAMES.map((name) => {
                    const selected = boxName.trim().toLowerCase() === name.toLowerCase();
                    return (
                      <Pressable
                        key={name}
                        onPress={() => {
                          setBoxName(name);
                          if (addBoxError) setAddBoxError(null);
                        }}
                        style={({ pressed }) => [
                          styles.quickNameChip,
                          selected && styles.quickNameChipSelected,
                          pressed && { opacity: 0.7 },
                        ]}>
                        <Text
                          style={[
                            styles.quickNameText,
                            selected && styles.quickNameTextSelected,
                          ]}>
                          {name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

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

      {/* ── Manage Rooms Bottom Sheet (mockup §3) ─ */}
      <BottomSheet
        visible={showManageRooms}
        onClose={() => setShowManageRooms(false)}
        handleOnly
        sheetStyle={{ backgroundColor: colors.surface, maxHeight: '70%' }}>
        <BottomSheetDraggableArea>
          <Text style={[font.title, styles.manageTitle]}>Rooms</Text>
        </BottomSheetDraggableArea>

            {/* ── Room List ─────────────────────── */}
            {rooms && rooms.length > 0 ? (
              <ScrollView
                style={styles.manageRoomList}
                showsVerticalScrollIndicator={false}>
                {rooms.map((room, index) => {
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
                          {/* Same tint as the room's chip on Home. The icon keeps
                              its colour while selected — the row highlight and
                              checkmark carry the state instead. */}
                          <View
                            style={[
                              styles.manageRoomIcon,
                              {
                                backgroundColor:
                                  roomAccentPalette[index % roomAccentPalette.length] + '22',
                              },
                            ]}>
                            <Text style={styles.manageRoomEmoji}>{roomEmoji(room.name, room.emoji)}</Text>
                          </View>
                          <View style={styles.manageRoomTextWrap}>
                            <Text style={[styles.manageRoomName, isSelected && { color: colors.primary }]} numberOfLines={1}>
                              {room.name}
                            </Text>
                            <Text style={styles.manageRoomMeta}>
                              {roomBoxCounts.get(room.id) ?? 0} box{(roomBoxCounts.get(room.id) ?? 0) === 1 ? '' : 'es'}
                            </Text>
                          </View>
                          {isSelected && (
                            <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                          )}
                        </View>
                      </Pressable>
                      {isExpanded && (
                        <Animated.View style={{
                          opacity: manageActionAnim,
                          transform: [{ translateY: manageActionAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [-10, 0],
                          })}],
                        }}>
                          {/* ── Room icon — the room's badge. Picking one saves
                                 it on the room (rooms.emoji); the chips and
                                 every other room list pick it up live. ── */}
                          <View style={styles.iconPickerBlock}>
                            <Text style={styles.iconPickerLabel}>Room icon</Text>
                            <ScrollView
                              horizontal
                              showsHorizontalScrollIndicator={false}
                              contentContainerStyle={styles.iconPickerRow}>
                              {ROOM_EMOJI_OPTIONS.map((option, index) => {
                                const isChosen =
                                  roomEmoji(room.name, room.emoji) === option;
                                return (
                                  <Pressable
                                    key={option}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${option} room icon`}
                                    accessibilityState={{ selected: isChosen }}
                                    onPress={() => handleSetRoomEmoji(room, option)}
                                    style={({ pressed }) => [
                                      styles.iconOption,
                                      // Same palette as the chips/sheet rows, so
                                      // the picker previews the app's tints.
                                      {
                                        backgroundColor:
                                          roomAccentPalette[index % roomAccentPalette.length] + '22',
                                      },
                                      isChosen && styles.iconOptionChosen,
                                      pressed && { opacity: 0.7 },
                                    ]}>
                                    <Text style={styles.iconOptionText}>{option}</Text>
                                  </Pressable>
                                );
                              })}
                            </ScrollView>
                          </View>

                          <View style={styles.expandActions}>
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
                          </View>
                        </Animated.View>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={styles.manageEmptyText}>No rooms yet.</Text>
            )}

            {/* ── Add Room (mockup §3 bordered pill) ── */}
            <View style={styles.manageAddRow}>
              <Pressable
                style={({ pressed }) => [styles.manageAddBtn, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  setShowManageRooms(false);
                  setShowAddRoom(true);
                }}>
                <Ionicons name="add" size={18} color={colors.primary} />
                <Text style={styles.manageAddText}>Add room</Text>
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

      {/* ── Box Action Sheet (long press on a box row) ──
             Same sheet the box screen opens from its header ⋯, wearing the
             app's sheet language: hairline title bar, card rows with tinted
             icon tiles, and a ghost cancel pill (photo-source-sheet). ── */}
      <BottomSheet
        visible={!!actionBox}
        onClose={() => setActionBox(null)}
        sheetStyle={{
          backgroundColor: colors.surface,
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.xs,
          gap: spacing.md,
        }}>
        <BottomSheetDraggableArea style={styles.boxSheetTitleWrap}>
          <Text style={[font.headline, styles.boxSheetTitle]}>{actionBox?.box_number}</Text>
        </BottomSheetDraggableArea>

        <Pressable
          style={({ pressed }) => [styles.boxSheetOption, pressed && { opacity: 0.7 }]}
          onPress={() => {
            const box = actionBox;
            setActionBox(null);
            if (box) {
              setEditBoxName(box.box_number);
              setEditBoxError(null);
              setEditingBox(box);
            }
          }}>
          <View style={[styles.boxSheetOptionIcon, { backgroundColor: colors.primarySoft }]}>
            <Ionicons name="pencil-outline" size={20} color={colors.primary} />
          </View>
          <Text style={[font.bodyMedium, { flex: 1 }]}>Rename</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.boxSheetOption, pressed && { opacity: 0.7 }]}
          onPress={() => {
            const box = actionBox;
            setActionBox(null);
            if (box) setDeleteConfirmBox(box);
          }}>
          <View style={[styles.boxSheetOptionIcon, { backgroundColor: colors.dangerSoft }]}>
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
          </View>
          <Text style={[font.bodyMedium, { flex: 1 }, { color: colors.danger }]}>Delete</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.boxSheetCancel, pressed && { opacity: 0.7 }]}
          onPress={() => setActionBox(null)}>
          <Text style={[font.headline, { color: colors.primary }]}>Cancel</Text>
        </Pressable>
      </BottomSheet>

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
          behavior="padding">
          <ModalBackdrop
            visible={!!editingBox}
            onBackdropPress={() => {
              setEditingBox(null);
              setEditBoxName('');
              setEditBoxError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.title, { marginBottom: spacing.sm }]}>Rename Box</Text>

              {editBoxError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{editBoxError}</Text>
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
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnGhost,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameBox}
                  disabled={isEditingBox}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isEditingBox ? (
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

      {/* ── Delete Box Confirmation ─────── */}
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

      {/* ── Delete Box Error ────────────── */}
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

      {/* ── Removed from a move (realtime) ───
          Raised by the membership subscription when an owner deletes this
          user's row. A single OK button — this is news, not a decision. ── */}
      <ConfirmModal
        visible={removalNotice !== null}
        title="You were removed"
        message={removalNotice ?? ''}
        confirmLabel="OK"
        showCancel={false}
        icon="person-remove-outline"
        onConfirm={() => setRemovalNotice(null)}
        onCancel={() => setRemovalNotice(null)}
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
        moveId={resolvedMove?.id}
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
    // Grow so a short room still fills the page: the selected-room section is
    // the swipe surface, and it should reach the FAB rather than stop early.
    flexGrow: 1,
    paddingBottom: 120, // space for FAB
  },

  // ── Home header row (move pill + gear, above the search bar) ──
  homeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  moveSelectorButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingLeft: spacing.xs,
    paddingRight: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  moveSelectorIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.moveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveSelectorName: {
    maxWidth: 180,
  },

  // ── Progress Card (mockup §1) ─────────
  progressCard: {
    marginTop: spacing.lg,
    marginHorizontal: spacing.xl,
    backgroundColor: colors.navy,
    borderRadius: radius.xl,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  progressFold: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 46,
    height: 46,
    backgroundColor: colors.accent,
    borderBottomLeftRadius: radius.xl,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  progressBig: {
    fontSize: 34,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  progressLabel: {
    fontSize: 15,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textOnNavy,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  progressCaption: {
    marginTop: spacing.sm,
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textOnNavy,
  },

  // ── Waiting join requests (owner signal, above the rooms list) ──
  // Same yellow accent as the switcher's "N waiting" pill, promoted to a
  // full-width banner because it is the one thing needing the owner's action.
  joinBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    marginHorizontal: spacing.xl,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderCurve: 'continuous',
  },
  joinBannerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  joinBannerText: {
    flex: 1,
    gap: 1,
  },
  joinBannerTitle: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 14,
    color: colors.navyDeep,
  },
  joinBannerHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.navyDeep,
    opacity: 0.75,
  },

  // ── Rooms ──────────────────────────
  roomsSection: {
    flexGrow: 1,
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

  // ── Room Chips (mockup §1) ─────────────
  roomTilesRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Chips get whatever width the tab leaves them — they are clipped at the
  // tab's edge instead of scrolling underneath it.
  roomTilesScrollArea: {
    flex: 1,
  },
  roomTilesScroll: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingRight: spacing.sm,
  },
  roomChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingLeft: spacing.xs,
    paddingRight: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // Selected room: the app's established "active" surface — primarySoft
  // fill + primary text (same language as the applied filter pills and the
  // selected row in the Manage Rooms sheet). The border stays solid primary
  // so the chip still reads as selected against the periwinkle page — the
  // soft fill alone is too close to `background`. A solid `primary` fill made
  // the chip read as a tappable BUTTON rather than the current room.
  roomChipSelected: {
    backgroundColor: colors.primarySoft,
    borderColor: colors.primary,
  },
  roomChipDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roomChipName: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  roomChipNameSelected: {
    color: colors.primary,
  },
  roomChipEmoji: {
    fontSize: 13,
    lineHeight: 16,
  },

  // ── Edit Room tab — HALF A PILL: left corners rounded, right side flush ──
  // against the screen edge (a normal borderRadius would round the right
  // corners too and the pill would no longer look cut off by the screen).
  editRoomTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 36,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    backgroundColor: colors.primary,
    borderTopLeftRadius: radius.pill,
    borderBottomLeftRadius: radius.pill,
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  editRoomTabText: {
    fontSize: 13,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // ── Selected Room Boxes ──────────────
  selectedRoomSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    // Fills whatever height the room's boxes leave free, so the swipe surface
    // covers the lower page even for a room with no boxes at all.
    flexGrow: 1,
  },
  selectedRoomHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: spacing.md,
  },
  selectedRoomCount: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  boxesList: {
    gap: spacing.sm,
  },

  // ── Empty Room State (mockup §7) ──────
  emptyRoomState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  emptyRoomDash: {
    width: 96,
    height: 96,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: colors.textTertiary,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyRoomTitle: {
    fontSize: 20,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptyRoomSubtitle: {
    fontSize: 14,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  emptyRoomBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingVertical: 14,
    paddingHorizontal: spacing.xxxl,
  },
  emptyRoomBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  noRoomsWrap: {
    paddingHorizontal: spacing.xl,
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
    height: 52,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    ...shadow.card,
    elevation: 4,
  },
  fabText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },

  // ── Box Input ───────────────────────
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

  // ── Room Input ──────────────────────
  roomInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    // Height owns the vertical rhythm; zero padding + Android centering keeps
    // the typed text dead-centre on both platforms.
    paddingVertical: 0,
    textAlignVertical: 'center',
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
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

  // ── Box action sheet (long press on a box row) ──
  // Same card-row + ghost-cancel language as every other sheet in the app
  // (see components/photo-source-sheet.tsx).
  boxSheetTitleWrap: {
    marginHorizontal: -spacing.xl, // stretch the drag surface over the full sheet width
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  boxSheetTitle: {
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  boxSheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderCurve: 'continuous',
  },
  boxSheetOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  boxSheetCancel: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  pressed: {
    opacity: 0.7,
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  manageTitle: {
    textAlign: 'left',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
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
    borderRadius: radius.lg,
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
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manageRoomTextWrap: {
    flex: 1,
    gap: 1,
  },
  manageRoomName: {
    fontSize: 16,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  manageRoomMeta: {
    fontSize: 12,
    fontFamily: fonts.regular,
    color: colors.textTertiary,
    fontVariant: ['tabular-nums'],
  },
  manageRoomEmoji: {
    fontSize: 18,
    lineHeight: 22,
  },
  manageRoomAction: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Quick names (mockup §4) ──────────
  quickNamesWrap: {
    gap: spacing.sm,
  },
  quickNamesLabel: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
  },
  quickNamesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  quickNameChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
  },
  quickNameChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  quickNameText: {
    fontSize: 14,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  quickNameTextSelected: {
    color: '#FFFFFF',
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },

  // ── Expandable Action Buttons ────────────
  // ── Room icon picker (expanded room, Manage Rooms sheet) ──
  // Tiles start at the room NAME's x (sheet padding 20 + row padding 12 +
  // icon 40 + gap 12 = 84 ⇒ 64 here) so the picker reads as part of that row.
  iconPickerBlock: {
    paddingLeft: 64,
    paddingBottom: spacing.sm,
  },
  iconPickerLabel: {
    fontSize: 12,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textTertiary,
    marginBottom: spacing.sm,
  },
  iconPickerRow: {
    gap: spacing.sm,
    paddingRight: spacing.xl,
  },
  iconOption: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
    borderCurve: 'continuous',
  },
  // Selection ring only: the emoji keeps its palette tint, like a selected
  // room chip keeps its own.
  iconOptionChosen: {
    borderColor: colors.primary,
  },
  iconOptionText: {
    fontSize: 19,
    lineHeight: 24,
  },

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
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
  },
  manageAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  manageAddText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
  },
});
