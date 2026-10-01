import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  LayoutAnimation,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { colors, spacing, font, fonts, radius } from '../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { deleteStorageForBoxIds } from '@/services/photos';
import { fetchJoinRequests } from '@/services/members';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import ConfirmModal from '@/components/confirm-modal';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { toFriendlyError } from '@/lib/errors';
import ModalBackdrop from '@/components/modal-backdrop';
import type { Move } from '@/types/database';

// ──────────────────────────────────────────
// Props
// ──────────────────────────────────────────

interface MoveSwitcherProps {
  visible: boolean;
  currentMoveId: string | null;
  onClose: () => void;
  onSwitchMove: (moveId: string) => void;
}

// ──────────────────────────────────────────
// Data fetching
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

  // Fetch the actual moves
  const { data, error } = await supabase
    .from('moves')
    .select('*')
    .in('id', moveIds)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function timeAgo(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

// ──────────────────────────────────────────
// Component
// ──────────────────────────────────────────

export default function MoveSwitcher({
  visible,
  currentMoveId,
  onClose,
  onSwitchMove,
}: MoveSwitcherProps) {
  const user = useAuthStore((s) => s.user);

  const { data: moves, isLoading } = useQuery({
    queryKey: ['userMoves', user?.id],
    queryFn: () => fetchUserMoves(user!.id),
    enabled: !!user && visible,
  });

  const handleCreateMove = useCallback(() => {
    onClose();
    // Small delay so the bottom sheet closes before navigation
    setTimeout(() => router.push('/create-move'), 200);
  }, [onClose]);

  const handleJoinMove = useCallback(() => {
    onClose();
    setTimeout(() => router.push('/join-move'), 200);
  }, [onClose]);

  const queryClient = useQueryClient();
  const { setActiveMove } = useActiveMoveStore();

  // ── Waiting join requests, for the moves this user owns ──
  //
  // Only an owner can see requests at all (the RPC returns an empty list to
  // everyone else), and the sheet is opened rarely, so a few small calls are
  // cheaper than a new aggregate RPC. Keyed by the owned ids so the answer is
  // shared across the whole sheet instead of one query per row.
  const ownedMoveIds = (moves ?? [])
    .filter((m) => m.owner_id === user?.id)
    .map((m) => m.id);

  const { data: requestCounts } = useQuery({
    queryKey: ['join-request-counts', ownedMoveIds.join(',')],
    enabled: visible && ownedMoveIds.length > 0,
    // No staleTime: this badge only says "somebody is waiting", so a cached
    // count is worse than a refetch. It runs only while the sheet is open.
    queryFn: async () => {
      const counts = await Promise.all(
        ownedMoveIds.map(async (moveId) => {
          const requests = await fetchJoinRequests(moveId);
          return [moveId, requests.length] as const;
        }),
      );
      return Object.fromEntries(counts) as Record<string, number>;
    },
  });

  // Determine if current user is the owner of the current move
  const currentMove = moves?.find((m) => m.id === currentMoveId);

  // ── Expanded move for inline actions (auto-expand current on open) ──
  const [expandedMoveId, setExpandedMoveId] = useState<string | null>(null);

  // Auto-expand the current move when the sheet opens.
  // Delay by 300ms so the sheet's slide-in animation completes first.
  useEffect(() => {
    if (visible && currentMoveId) {
      const timer = setTimeout(() => {
        setExpandedMoveId(currentMoveId);
      }, 300);
      return () => clearTimeout(timer);
    } else if (!visible) {
      setExpandedMoveId(null);
    }
  }, [visible, currentMoveId]);

  // ── Rename move state ──
  const [renameMove, setRenameMove] = useState<Move | null>(null);
  const [renameMoveName, setRenameMoveName] = useState('');
  const [renameMoveError, setRenameMoveError] = useState<string | null>(null);
  const [isRenamingMove, setIsRenamingMove] = useState(false);

  // ── Invite code copy feedback ──
  const [justCopied, setJustCopied] = useState(false);
  const copyScale = useRef(new Animated.Value(1)).current;

  const handleCopyInvite = useCallback(async () => {
    if (!currentMove?.invite_code) return;
    await Clipboard.setStringAsync(currentMove.invite_code);
    setJustCopied(true);

    // Scale down briefly on press, then spring back
    Animated.sequence([
      Animated.timing(copyScale, { toValue: 0.92, duration: 100, useNativeDriver: true }),
      Animated.spring(copyScale, { toValue: 1, useNativeDriver: true, tension: 120, friction: 6 }),
    ]).start();

    setTimeout(() => setJustCopied(false), 2000);
  }, [currentMove, copyScale]);

  /**
   * Open a move's own screen: members, the waiting-request queue, the invite
   * code ticket, and the Pro sharing switch. Nothing else in the app links to
   * it, so this list is the entry point — and the owner's "N waiting" pill is
   * the shortcut to the approval it is announcing.
   */
  const openMove = useCallback(
    (moveId: string) => {
      onClose();
      router.push({ pathname: '/move/[id]', params: { id: moveId } });
    },
    [onClose],
  );

  // ── Custom confirm/error modal state ──
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Get the move name for the delete confirmation
  const deleteTargetName = moves?.find((m) => m.id === deleteTargetId)?.name ?? '';

  // ── Leave move state (members only — an owner cannot leave their own move) ──
  const canLeaveCurrent = !!currentMove && !!user && currentMove.owner_id !== user.id;
  const [leaveConfirmVisible, setLeaveConfirmVisible] = useState(false);
  const [leaveErrorVisible, setLeaveErrorVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  // ── Rename move handler ──
  const handleRenameMove = useCallback(async () => {
    if (!renameMove) return;
    const trimmed = renameMoveName.trim();
    if (!trimmed) {
      setRenameMoveError('Move name is required.');
      return;
    }
    setRenameMoveError(null);
    setIsRenamingMove(true);

    try {
      const { error } = await supabase
        .from('moves')
        .update({ name: trimmed })
        .eq('id', renameMove.id);

      if (error) throw new Error(error.message);

      setRenameMove(null);
      setRenameMoveName('');
      queryClient.invalidateQueries({ queryKey: ['userMoves', user?.id] });
    } catch (err) {
      setRenameMoveError(toFriendlyError(err, 'Failed to rename move.'));
    } finally {
      setIsRenamingMove(false);
    }
  }, [renameMove, renameMoveName, queryClient, user]);

  const performDelete = useCallback(async () => {
    if (!deleteTargetId) return;
    const targetMoveId = deleteTargetId;
    const isDeletingActive = targetMoveId === currentMoveId;
    setIsDeleting(true);

    try {
      // Get all rooms → boxes for this move BEFORE deleting it
      // (storage DELETE RLS requires boxes to exist)
      const { data: moveRooms } = await supabase
        .from('rooms')
        .select('id')
        .eq('move_id', targetMoveId);
      const roomIds = (moveRooms ?? []).map((r) => r.id);

      if (roomIds.length > 0) {
        const { data: moveBoxes } = await supabase
          .from('boxes')
          .select('id')
          .in('room_id', roomIds);
        const boxIds = (moveBoxes ?? []).map((b) => b.id);

        // Remove all storage files for all boxes in this move
        await deleteStorageForBoxIds(boxIds);
      }

      const { error } = await supabase
        .from('moves')
        .delete()
        .eq('id', targetMoveId);

      if (error) throw new Error(error.message);

      setDeleteConfirmVisible(false);
      setDeleteTargetId(null);
      onClose();

      // If deleting the active move, clear it
      if (isDeletingActive) {
        setActiveMove(null);
      }

      queryClient.invalidateQueries({ queryKey: ['userMoves', user?.id] });
    } catch (err) {
      setDeleteConfirmVisible(false);
      setDeleteTargetId(null);
      setDeleteErrorVisible(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTargetId, currentMoveId, setActiveMove, queryClient, user, onClose]);

  // Same flow as "Leave this move" on the move screen. Leaving removes access,
  // never data — everything the person packed stays in the move.
  const performLeave = useCallback(async () => {
    if (!currentMove || !user || currentMove.owner_id === user.id) return;
    const leftMoveId = currentMove.id;
    setIsLeaving(true);
    const previousActiveMoveId = useActiveMoveStore.getState().activeMoveId;
    try {
      // Cleared BEFORE the delete so Home's realtime removal notice does not
      // mistake a self-service leave for the owner removing this user.
      await setActiveMove(null);

      const { error } = await supabase
        .from('move_members')
        .delete()
        .eq('move_id', leftMoveId)
        .eq('user_id', user.id);
      if (error) throw new Error(error.message);

      setLeaveConfirmVisible(false);
      onClose();

      // Drop it from the persisted list right away, or Home's fallback could
      // land back on the move just left until the refetch arrives.
      queryClient.setQueryData<Move[]>(['userMoves', user.id], (prev) =>
        prev ? prev.filter((m) => m.id !== leftMoveId) : prev,
      );
      queryClient.invalidateQueries({ queryKey: ['userMoves', user.id] });
      queryClient.invalidateQueries({ queryKey: ['moves', user.id] });
      queryClient.invalidateQueries({ queryKey: ['members', leftMoveId] });
      queryClient.invalidateQueries({ queryKey: ['homeRooms'] });
      queryClient.invalidateQueries({ queryKey: ['join-request-counts'] });
    } catch {
      await setActiveMove(previousActiveMoveId);
      setLeaveConfirmVisible(false);
      setLeaveErrorVisible(true);
    } finally {
      setIsLeaving(false);
    }
  }, [currentMove, user, setActiveMove, queryClient, onClose]);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      handleOnly
      sheetStyle={{ backgroundColor: colors.surface, maxHeight: '80%' }}>
      <BottomSheetDraggableArea>
        <Text style={[font.title, styles.sheetTitle]}>Your moves</Text>
      </BottomSheetDraggableArea>

          {/* ── Move List ─────────────────── */}
          {isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : moves && moves.length > 0 ? (
            <ScrollView
              style={styles.moveList}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled">
              {moves.map((move) => {
                const isActive = move.id === currentMoveId;
                const isExpanded = move.id === expandedMoveId;
                const isMoveOwner = move.owner_id === user?.id;
                return (
                  <View key={move.id}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.moveRow,
                        isActive && styles.moveRowActive,
                        pressed && styles.moveRowPressed,
                      ]}
                      onPress={() => {
                        if (!isActive) {
                          // Switch to this move
                          onSwitchMove(move.id);
                          onClose();
                        } else {
                          // Toggle inline Rename/Delete for the active move
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setExpandedMoveId(isExpanded ? null : move.id);
                        }
                      }}>
                      <View style={styles.moveRowLeft}>
                        <View style={styles.moveIcon}>
                          <Ionicons
                            name="home"
                            size={18}
                            color={colors.accentDeep}
                          />
                        </View>
                        <View style={styles.moveRowInfo}>
                          <Text
                            style={[
                              font.bodyMedium,
                              styles.moveRowName,
                              !isActive && { fontFamily: fonts.regular, fontWeight: '400' as const },
                            ]}
                            numberOfLines={1}>
                            {move.name}
                          </Text>
                          <View style={styles.moveRowMetaRow}>
                            <Text style={styles.moveRowMeta}>
                              Created {timeAgo(move.created_at)}
                            </Text>
                            {isMoveOwner && (requestCounts?.[move.id] ?? 0) > 0 ? (
                              <Pressable
                                hitSlop={6}
                                onPress={() => openMove(move.id)}
                                style={({ pressed }) => [styles.waitingPill, pressed && { opacity: 0.7 }]}>
                                <Ionicons
                                  name="person-add-outline"
                                  size={11}
                                  color={colors.navyDeep}
                                />
                                <Text style={styles.waitingPillText}>
                                  {requestCounts?.[move.id]} waiting
                                </Text>
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      </View>
                      {isActive && (
                        <Ionicons
                          name="checkmark-circle"
                          size={22}
                          color={colors.primary}
                        />
                      )}
                      <Pressable
                        hitSlop={6}
                        onPress={() => openMove(move.id)}
                        style={({ pressed }) => [
                          styles.openMoveBtn,
                          pressed && { opacity: 0.6 },
                        ]}>
                        <Ionicons
                          name="chevron-forward"
                          size={16}
                          color={colors.textSecondary}
                        />
                      </Pressable>
                    </Pressable>
                    {isExpanded && isMoveOwner && (
                      <Animated.View style={[styles.expandActions, {
                        opacity: expandedMoveId === move.id ? 1 : 0,
                      }]}>
                        <Pressable
                          style={({ pressed }) => [styles.expandActionBtn, pressed && { opacity: 0.6 }]}
                          onPress={() => {
                            setExpandedMoveId(null);
                            setRenameMoveName(move.name);
                            setRenameMoveError(null);
                            setRenameMove(move);
                          }}>
                          <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                          <Text style={styles.expandActionText}>Rename</Text>
                        </Pressable>
                        <View style={styles.expandDivider} />
                        <Pressable
                          style={({ pressed }) => [styles.expandActionBtn, pressed && { opacity: 0.6 }]}
                          onPress={() => {
                            setExpandedMoveId(null);
                            setDeleteTargetId(move.id);
                            setDeleteConfirmVisible(true);
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
            <Text style={styles.noMovesText}>
              You don't have any moves yet.
            </Text>
          )}

          {/* ── Invite Code (mockup §2 dashed ticket) ── */}
          {currentMove && currentMove.invite_code ? (
            <View style={styles.inviteSection}>
              <Text style={styles.inviteLabel}>Invite code</Text>
              <View style={styles.inviteCodeRow}>
                <Text style={styles.inviteCode} selectable>
                  {currentMove.invite_code}
                </Text>
                <Animated.View style={{ transform: [{ scale: copyScale }] }}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.inviteCopyBtn,
                      {
                        backgroundColor: justCopied ? colors.success : colors.primary,
                      },
                      pressed && !justCopied && { opacity: 0.8 },
                    ]}
                    onPress={handleCopyInvite}>
                    <Ionicons
                      name={justCopied ? 'checkmark' : 'copy-outline'}
                      size={16}
                      color="#FFFFFF"
                    />
                    <Text style={styles.inviteCopyText}>
                      {justCopied ? 'Copied!' : 'Copy'}
                    </Text>
                  </Pressable>
                </Animated.View>
              </View>
            </View>
          ) : null}

          {/* ── Actions (mockup §2 side-by-side pills) ── */}
          <View style={styles.actionsSection}>
            {/* Create Move */}
            <Pressable
              style={({ pressed }) => [styles.actionPill, pressed && styles.actionPressed]}
              onPress={handleCreateMove}>
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={styles.actionPillText}>New move</Text>
            </Pressable>

            {/* Join Move */}
            <Pressable
              style={({ pressed }) => [styles.actionPill, pressed && styles.actionPressed]}
              onPress={handleJoinMove}>
              <Text style={styles.actionPillText}>Join a move</Text>
            </Pressable>

            {/* Delete Move moved inline inside each move row */}
          </View>

          {canLeaveCurrent ? (
            <Pressable
              style={({ pressed }) => [styles.leaveMoveBtn, pressed && styles.actionPressed]}
              onPress={() => setLeaveConfirmVisible(true)}>
              <Ionicons name="log-out-outline" size={18} color={colors.danger} />
              <Text style={styles.leaveMoveText}>Leave this move</Text>
            </Pressable>
          ) : null}

      {/* ── Rename Move Modal ──────────── */}
      <Modal
        visible={!!renameMove}
        transparent
        animationType="none"
        onRequestClose={() => {
          setRenameMove(null);
          setRenameMoveName('');
          setRenameMoveError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding">
          <ModalBackdrop
            visible={!!renameMove}
            onBackdropPress={() => {
              setRenameMove(null);
              setRenameMoveName('');
              setRenameMoveError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIcon}>
                  <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title}>Rename Move</Text>
              </View>

              {renameMoveError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{renameMoveError}</Text>
                </View>
              ) : null}

              <TextInput
                style={styles.moveNameInput}
                placeholder="Move name"
                placeholderTextColor={colors.textTertiary}
                value={renameMoveName}
                onChangeText={(text) => {
                  setRenameMoveName(text);
                  if (renameMoveError) setRenameMoveError(null);
                }}
                editable={!isRenamingMove}
                returnKeyType="done"
                onSubmitEditing={handleRenameMove}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setRenameMove(null);
                    setRenameMoveName('');
                    setRenameMoveError(null);
                  }}
                  style={({ pressed }) => [styles.modalPillBtn, styles.modalPillBtnGhost, pressed && { opacity: 0.7 }]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameMove}
                  disabled={isRenamingMove}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && { opacity: 0.85 },
                  ]}>
                  {isRenamingMove ? (
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

      {/* ── Delete Confirmation ─────────── */}
      <ConfirmModal
        visible={deleteConfirmVisible}
        title="Delete Move?"
        message={deleteTargetName ? `Are you sure you want to delete "${deleteTargetName}"? All rooms, boxes, and items will be permanently removed. This cannot be undone.` : ''}
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        onConfirm={performDelete}
        onCancel={() => {
          setDeleteConfirmVisible(false);
          setDeleteTargetId(null);
        }}
        isLoading={isDeleting}
      />

      {/* ── Delete Error ────────────────── */}
      <ConfirmModal
        visible={deleteErrorVisible}
        title="Error"
        message="Failed to delete move. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setDeleteErrorVisible(false)}
        onCancel={() => setDeleteErrorVisible(false)}
      />

      {/* ── Leave Confirmation ──────────── */}
      <ConfirmModal
        visible={leaveConfirmVisible}
        title="Leave this move?"
        message={`You lose access to "${currentMove?.name ?? 'this move'}" right away. Everything you packed stays in the move, and you can join again later with the invite code.`}
        confirmLabel="Leave"
        confirmDestructive
        icon="log-out-outline"
        isLoading={isLeaving}
        onConfirm={performLeave}
        onCancel={() => setLeaveConfirmVisible(false)}
      />

      {/* ── Leave Error ─────────────────── */}
      <ConfirmModal
        visible={leaveErrorVisible}
        title="Error"
        message="Failed to leave the move. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setLeaveErrorVisible(false)}
        onCancel={() => setLeaveErrorVisible(false)}
      />
    </BottomSheet>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  sheetTitle: {
    textAlign: 'left',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },

  // ── List ──────────────────────────
  moveList: {
    maxHeight: 280,
    paddingHorizontal: spacing.xl,
  },
  loadingRow: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    marginBottom: 4,
    borderCurve: 'continuous',
  },
  moveRowActive: {
    backgroundColor: colors.primarySoft,
  },
  moveRowPressed: {
    opacity: 0.7,
  },
  moveRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  moveIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.moveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveRowName: {
    fontSize: 16,
  },
  moveRowInfo: {
    flex: 1,
    gap: 1,
  },
  moveRowMeta: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textTertiary,
  },
  moveRowMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  waitingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  waitingPillText: {
    color: colors.navyDeep,
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 11,
  },
  // Opens the move's own screen — the only entry point that exists for it.
  openMoveBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginLeft: spacing.sm,
  },
  noMovesText: {
    textAlign: 'center',
    color: colors.textSecondary,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    fontFamily: fonts.regular,
    fontSize: 15,
  },

  // ── Expandable Actions ────────────
  expandActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  // Ghost pills (mockup §2) — Rename/Delete under the expanded move row.
  expandActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderCurve: 'continuous',
  },
  expandActionText: {
    fontSize: 14,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
  },
  expandDivider: {
    width: 1,
    height: 20,
    backgroundColor: colors.border,
  },

  // ── Rename Modal ──────────────────
  modalCard: {
    borderRadius: 20,
    padding: spacing.xl,
    gap: spacing.lg,
    borderCurve: 'continuous',
  },
  errorBox: {
    padding: spacing.sm,
    borderRadius: 8,
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
  moveNameInput: {
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

  // ── Invite Code ──────────────────
  inviteSection: {
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
  },
  inviteLabel: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  inviteCodeRow: {
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
  },
  inviteCopyText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // ── Actions ───────────────────────
  actionsSection: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.lg,
  },
  actionPill: {
    flex: 1,
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
  actionPressed: {
    opacity: 0.6,
  },
  actionPillText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
  },

  // ── Leave ──────────────────────────
  leaveMoveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    marginHorizontal: spacing.xl,
    paddingVertical: 14,
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

  // ── Delete ─────────────────────────
  deleteDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.md,
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    borderCurve: 'continuous',
  },
  deleteText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.danger,
  },
});
