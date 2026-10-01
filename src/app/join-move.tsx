import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import TextField from '../../packly-ui/components/TextField';
import Button from '../../packly-ui/components/Button';
import { colors, spacing, font, radius, fonts } from '../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/store/auth-store';
import { useActiveMoveStore } from '@/store/active-move-store';
import { toFriendlyError } from '@/lib/errors';

// ──────────────────────────────────────────
// Validation
// ──────────────────────────────────────────

function validateCode(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return 'Please enter an invite code.';
  if (trimmed.length !== 6) return 'Invite code must be 6 characters.';
  return null;
}

/** How often the waiting screen re-checks whether the owner approved us. */
const JOIN_POLL_MS = 5000;

// Realtime channel names must be unique per subscription attempt (the app does
// this on every screen that subscribes): removing a channel is async, so a
// remount can otherwise try to reuse a name that is still being torn down.
let joinChannelSeq = 0;

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function JoinMoveScreen() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  // Set once the request is in: the move we are waiting on.
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();

  /**
   * Enter a move we now have access to: refresh the lists and land on Home.
   * Used both when the code matched a move we already belong to and when the
   * owner approves us while the waiting screen is open.
   */
  const completeJoin = useCallback(
    (moveId: string) => {
      queryClient.invalidateQueries({ queryKey: ['moves', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['userMoves', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['members', moveId] });
      queryClient.invalidateQueries({ queryKey: ['move-plan', moveId] });

      useActiveMoveStore.getState().setActiveMove(moveId);
      router.replace('/');
    },
    [queryClient, user?.id],
  );

  // ── Waiting for approval ──
  //
  // Approval is owner-driven and can land at any moment, so while the request
  // is pending we poll two things we are allowed to read: our own membership
  // row (appears on approval) and our own join request (deleted on approval
  // OR denial). A member row means we are in; a vanished request without a
  // member row means the owner declined.
  const { data: joinStatus, refetch: recheckJoin } = useQuery({
    queryKey: ['join-status', pending?.id, user?.id],
    enabled: !!pending && !!user,
    // A declined request is gone for good server-side, so there is nothing left
    // to ask: keep polling while the answer can still change (member / pending),
    // stop once it cannot. A failed check keeps polling — it is not an answer.
    refetchInterval: (query) => {
      const state = query.state.data;
      return state && state.status === 'none' && !state.readError
        ? false
        : JOIN_POLL_MS;
    },
    queryFn: async () => {
      // my_join_status answers member / pending / none in ONE statement, so the
      // three cases cannot disagree. Reading the membership row and the request
      // row as two queries meant an approval landing between them looked
      // exactly like a decline: no membership, and the request already deleted.
      //
      // A failure here is still not an answer — Postgres checks EXECUTE on
      // functions used inside RLS policies against the QUERYING role, so a
      // policy calling a helper this role cannot run used to arrive as an empty
      // result and be read as "the owner said no".
      const { data, error } = await supabase.rpc('my_join_status', {
        p_move_id: pending!.id,
      });

      if (error) {
        console.warn('[join] status check failed:', error.message);
        return { status: 'none' as const, readError: error.message };
      }

      return {
        status: (data ?? 'none') as 'member' | 'pending' | 'none',
        readError: null,
      };
    },
  });

  // Both outcomes are DERIVED from the server's answer, not pushed into state
  // by an effect: 'member' means we are in, 'none' (after filing) means the
  // owner said no. Nothing to keep in sync.
  const joinApproved = !!pending && joinStatus?.status === 'member';
  const joinDeclined =
    !!pending && joinStatus?.status === 'none' && !joinStatus.readError;

  useEffect(() => {
    // Land in the move the moment the owner approves. No state is set here —
    // navigation unmounts this screen, so `pending` needs no clearing.
    if (joinApproved) completeJoin(pending!.id);
  }, [joinApproved, pending, completeJoin]);

  // ── Live approval ──
  //
  // Approval inserts our own move_members row (021 publishes that table for
  // exactly this), so subscribe instead of only waiting for the next poll:
  // intervals are throttled while the app sits in the background, and the owner
  // approving is the one event the person on this screen cares about.
  useEffect(() => {
    if (!pending || !user) return;

    const id = ++joinChannelSeq;
    const channel = supabase
      .channel(`join-${pending.id}-${user.id}-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'move_members',
          // Only our own row can mean "you are in".
          filter: `user_id=eq.${user.id}`,
        },
        () => recheckJoin(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [pending, user, recheckJoin]);

  const handleJoin = async () => {
    const validationError = validateCode(code);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!user) {
      setError('You must be signed in to join a move.');
      return;
    }

    setError(null);
    setIsJoining(true);
    // A declined request is gone server-side; drop the local trace AND the
    // cached answer, so a retry cannot flash the old verdict (the cache keeps
    // data for a minute, which is longer than it takes to tap Join again).
    queryClient.removeQueries({ queryKey: ['join-status'] });
    setPending(null);

    try {
      const inviteCode = code.trim().toUpperCase();

      // One call does it all server-side: validate the code, tell us whether
      // we are already in, and otherwise file a join request for the owner.
      const { data, error: requestError } = await supabase.rpc(
        'request_to_join_move',
        { p_invite_code: inviteCode },
      );

      if (requestError) {
        throw new Error(requestError.message);
      }

      // An unknown code comes back as status 'invalid' (not an error) so the
      // server's attempt counter is not rolled back with it — see 024.
      const result = data as
        | { id: string; name: string; status: 'active' | 'pending' }
        | { status: 'invalid' }
        | null;

      if (!result || result.status === 'invalid') {
        setError('Invite code not found.');
        setIsJoining(false);
        return;
      }

      setIsJoining(false);

      if (result.status === 'active') {
        completeJoin(result.id);
      } else {
        setPending({ id: result.id, name: result.name });
      }
    } catch (err) {
      setError(toFriendlyError(err, 'Failed to join move.'));
      setIsJoining(false);
    }
  };

  // ────────────────────────────────────────
  // Waiting for the owner
  // ────────────────────────────────────────

  // A declined request shows the form again, with the reason in the error box.
  if (pending && !joinDeclined) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.container}>
          <ScreenHeader onBack={() => router.back()} />

          <View style={styles.body}>
            <View style={styles.heroRow}>
              <View style={styles.heroTile}>
                <Ionicons name="time-outline" size={22} color={colors.primary} />
              </View>
              <Text style={font.largeTitle}>Almost in</Text>
            </View>
            <Text style={styles.subtitle}>
              Your request to join is with the move owner.
            </Text>

            <View style={styles.pendingCard}>
              <Text style={styles.pendingMoveName}>{pending.name}</Text>
              <View style={styles.pendingStatusRow}>
                <ActivityIndicator color={colors.primary} size="small" />
                <Text style={styles.pendingStatusText}>Waiting for approval</Text>
              </View>
              <Text style={styles.pendingHint}>
                This screen checks on its own — you will land in the move the
                moment the owner approves you. You can also leave and come back
                with the same code.
              </Text>

              {/* A check that failed is shown, never silently misread as a
                  decision by the owner. */}
              {joinStatus?.readError ? (
                <Text style={styles.pendingWarn}>
                  Couldn&apos;t check just now — still trying. ({joinStatus.readError})
                </Text>
              ) : null}
            </View>

            <View style={styles.actions}>
              <Button
                label="Check now"
                variant="secondary"
                onPress={() => recheckJoin()}
              />
              <Button
                label="Back to Home"
                variant="secondary"
                onPress={() => router.replace('/')}
              />
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ────────────────────────────────────────
  // Entering a code
  // ────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.container}>
        <ScreenHeader onBack={() => router.back()} />

        <View style={styles.body}>
          <View style={styles.heroRow}>
            <View style={styles.heroTile}>
              <Ionicons name="key-outline" size={22} color={colors.primary} />
            </View>
            <Text style={font.largeTitle}>Join a Move</Text>
          </View>
          <Text style={styles.subtitle}>Enter the invite code shared by the move owner.</Text>

          {error ?? joinDeclined ? (
            <View style={styles.errorBox}>
              <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 14 }}>
                {error ?? 'The owner declined your request.'}
              </Text>
            </View>
          ) : null}

          <View style={styles.form}>
            <TextField
              label="Invite Code"
              value={code}
              onChangeText={(text) => {
                setCode(text.toUpperCase());
                if (error) setError(null);
              }}
              placeholder="e.g. A4F9KD"
              autoCapitalize="characters"
              maxLength={6}
              autoFocus
            />
            <Text style={styles.hint}>Ask the move owner for the 6-character invite code.</Text>
          </View>

          <Button
            label="Join"
            onPress={handleJoin}
            disabled={code.trim().length !== 6 || isJoining}
            loading={isJoining}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  body: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  heroTile: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    fontFamily: fonts.regular,
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
  },
  pendingCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    borderCurve: 'continuous',
  },
  pendingMoveName: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 17,
    color: colors.textPrimary,
  },
  pendingStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pendingStatusText: {
    fontFamily: fonts.semiBold,
    fontSize: 14,
    color: colors.primary,
  },
  pendingHint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  pendingWarn: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.danger,
    marginTop: spacing.md,
  },
  actions: {
    gap: spacing.md,
  },
  form: {
    marginBottom: spacing.xl,
  },
  hint: {
    color: colors.textTertiary,
    fontSize: 13,
    fontFamily: fonts.regular,
    marginTop: spacing.sm,
  },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.lg,
  },
});
