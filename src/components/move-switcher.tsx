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
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { colors, spacing, font, fonts } from '../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { deleteStorageForBoxIds } from '@/services/photos';
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
  // Get all move IDs the user is a member of
  const { data: memberships, error: memberError } = await supabase
    .from('move_members')
    .select('move_id')
    .eq('user_id', userId);

  if (memberError) throw new Error(memberError.message);

  const moveIds = (memberships ?? []).map((m) => m.move_id);
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

  // ── Custom confirm/error modal state ──
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Get the move name for the delete confirmation
  const deleteTargetName = moves?.find((m) => m.id === deleteTargetId)?.name ?? '';

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

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      handleOnly
      sheetStyle={{ backgroundColor: colors.surface, maxHeight: '80%' }}>
      <BottomSheetDraggableArea>
        <Text style={[font.headline, styles.sheetTitle]}>Switch Move</Text>
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
                        <View style={[styles.moveIcon, { backgroundColor: isActive ? colors.primary + '15' : colors.surfaceMuted }]}>
                          <Ionicons
                            name="home-outline"
                            size={18}
                            color={isActive ? colors.primary : colors.textSecondary}
                          />
                        </View>
                        <View style={styles.moveRowInfo}>
                          <Text
                            style={[
                              font.body,
                              { fontWeight: isActive ? '600' : '400' },
                            ]}
                            numberOfLines={1}>
                            {move.name}
                          </Text>
                          <Text style={styles.moveRowMeta}>
                            {timeAgo(move.created_at)}
                          </Text>
                        </View>
                      </View>
                      {isActive && (
                        <Ionicons
                          name="checkmark-circle"
                          size={22}
                          color={colors.primary}
                        />
                      )}
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

          {/* ── Invite Code ────────────────── */}
          {currentMove && currentMove.invite_code ? (
            <View style={[styles.inviteSection, { borderTopColor: colors.border }]}>
              <View style={styles.inviteHeader}>
                <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.inviteLabel}>Invite Code</Text>
              </View>
              <View style={styles.inviteCodeRow}>
                <Text style={styles.inviteCode} selectable>
                  {currentMove.invite_code}
                </Text>
                <Animated.View style={{ transform: [{ scale: copyScale }] }}>
                  <Pressable
                    style={({ pressed }) => [
                      styles.inviteCopyBtn,
                      {
                        backgroundColor: justCopied ? colors.success + '18' : colors.primary,
                        borderColor: justCopied ? colors.success : 'transparent',
                        borderWidth: justCopied ? 1.5 : 0,
                      },
                      pressed && !justCopied && { opacity: 0.8 },
                    ]}
                    onPress={handleCopyInvite}>
                    <Ionicons
                      name={justCopied ? 'checkmark-circle' : 'copy-outline'}
                      size={16}
                      color={justCopied ? colors.success : '#FFFFFF'}
                    />
                    <Text
                      style={[
                        styles.inviteCopyText,
                        { color: justCopied ? colors.success : '#FFFFFF' },
                      ]}>
                      {justCopied ? 'Copied!' : 'Copy'}
                    </Text>
                  </Pressable>
                </Animated.View>
              </View>
            </View>
          ) : null}

          {/* ── Actions ───────────────────── */}
          <View style={[styles.actionsSection, { borderTopColor: colors.border }]}>
            {/* Create Move */}
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
              onPress={handleCreateMove}>
              <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
              <Text style={[styles.actionText, { color: colors.primary }]}>Create Move</Text>
            </Pressable>

            {/* Join Move */}
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
              onPress={handleJoinMove}>
              <Ionicons name="enter-outline" size={20} color={colors.primary} />
              <Text style={[styles.actionText, { color: colors.primary }]}>Join Move</Text>
            </Pressable>

            {/* Delete Move moved inline inside each move row */}
          </View>

          {/* ── Cancel ────────────────────── */}
          <View style={[styles.cancelSection, { backgroundColor: colors.surfaceMuted }]}>
            <Pressable
              style={({ pressed }) => [styles.cancelRow, pressed && { opacity: 0.7 }]}
              onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>

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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalBackdrop
            visible={!!renameMove}
            onBackdropPress={() => {
              setRenameMove(null);
              setRenameMoveName('');
              setRenameMoveError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.headline, { marginBottom: spacing.sm }]}>Rename Move</Text>

              {renameMoveError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{renameMoveError}</Text>
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
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && { opacity: 0.7 }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameMove}
                  disabled={isRenamingMove}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isRenamingMove || pressed ? 0.7 : 1 },
                  ]}>
                  {isRenamingMove ? (
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
    </BottomSheet>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  sheetTitle: {
    textAlign: 'center',
    paddingBottom: spacing.lg,
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
    borderRadius: 12,
    marginBottom: 4,
    borderCurve: 'continuous',
  },
  moveRowActive: {
    backgroundColor: colors.primary + '0A',
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
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
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
  moveNameInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
  },

  // ── Invite Code ──────────────────
  inviteSection: {
    borderTopWidth: 0.5,
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  inviteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  inviteLabel: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.3,
  },
  inviteCodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 12,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    height: 52,
    borderCurve: 'continuous',
  },
  inviteCode: {
    fontSize: 18,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  inviteCopyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    height: 38,
    borderRadius: 10,
    borderCurve: 'continuous',
  },
  inviteCopyText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: '#FFFFFF',
  },

  // ── Actions ───────────────────────
  actionsSection: {
    borderTopWidth: 0.5,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    borderCurve: 'continuous',
  },
  actionPressed: {
    opacity: 0.6,
  },
  actionText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
  },

  // ── Cancel ────────────────────────
  cancelSection: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    borderRadius: 14,
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  cancelRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
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
