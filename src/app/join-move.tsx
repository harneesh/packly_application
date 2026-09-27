import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
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

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function JoinMoveScreen() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();

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

    try {
      const inviteCode = code.trim().toUpperCase();

      // ── Look up move by invite code (bypasses RLS via SECURITY DEFINER) ──
      const { data: moveData, error: lookupError } = await supabase
        .rpc('find_move_by_invite_code', { code: inviteCode });

      if (lookupError) throw new Error(lookupError.message);

      if (!moveData) {
        setError('Invite code not found.');
        setIsJoining(false);
        return;
      }

      const move = moveData as { id: string; name: string };

      // ── Check if already a member ──
      const { data: existingMember } = await supabase
        .from('move_members')
        .select('user_id')
        .eq('move_id', move.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (existingMember) {
        setError('You are already a member of this move.');
        setIsJoining(false);
        return;
      }

      // ── Add user as move member ──
      const { error: joinError } = await supabase
        .from('move_members')
        .insert({ move_id: move.id, user_id: user.id });

      if (joinError) {
        // 23505 = unique_violation (already a member — race condition guard)
        if (joinError.code === '23505') {
          setError('You are already a member of this move.');
          setIsJoining(false);
          return;
        }
        throw new Error(joinError.message);
      }

      // ── Invalidate moves list so Home screen refetches ──
      queryClient.invalidateQueries({ queryKey: ['moves', user.id] });
      queryClient.invalidateQueries({ queryKey: ['userMoves', user.id] });

      // ── Set as active move and navigate to Home ──
      useActiveMoveStore.getState().setActiveMove(move.id);
      router.replace('/');
    } catch (err) {
      setError(toFriendlyError(err, 'Failed to join move.'));
      setIsJoining(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}>
        <ScreenHeader onBack={() => router.back()} />

        <View style={styles.body}>
          <Text style={font.largeTitle}>Join a Move</Text>
          <Text style={styles.subtitle}>Enter the invite code shared by the move owner.</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 14 }}>{error}</Text>
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
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    fontFamily: fonts.regular,
    marginTop: spacing.sm,
    marginBottom: spacing.xxl,
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
