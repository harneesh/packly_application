import { useState } from 'react';
import {
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

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
// Helpers
// ──────────────────────────────────────────

const MAX_NAME_LENGTH = 100;
const INVITE_CODE_LENGTH = 6;
const INVITE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Move name is required.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Move name must be ${MAX_NAME_LENGTH} characters or less.`;
  return null;
}

function generateInviteCode(): string {
  let result = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    result += INVITE_CHARS.charAt(Math.floor(Math.random() * INVITE_CHARS.length));
  }
  return result;
}

const DEFAULT_ROOMS = [
  'Kitchen',
  'Bedroom',
  'Bathroom',
  'Living Room',
  'Dining Room',
];

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function CreateMoveScreen() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();

  const handleCreate = async () => {
    const validationError = validateName(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (!user) {
      setError('You must be signed in to create a move.');
      return;
    }

    setError(null);
    setIsSaving(true);

    try {
      // ── Generate invite code with retry on collision ──
      let moveId: string;
      let inviteCode: string;

      while (true) {
        inviteCode = generateInviteCode();

        const { data, error: insertError } = await supabase
          .from('moves')
          .insert({
            name: name.trim(),
            owner_id: user.id,
            invite_code: inviteCode,
          })
          .select('id')
          .single();

        if (insertError) {
          // 23505 = unique_violation (invite_code collision)
          if (insertError.code === '23505') continue;
          throw new Error(insertError.message);
        }

        moveId = data.id;
        break;
      }

      // ── Insert default rooms ──
      const roomInserts = DEFAULT_ROOMS.map((roomName) => ({
        move_id: moveId,
        name: roomName,
      }));

      const { error: roomsError } = await supabase
        .from('rooms')
        .insert(roomInserts);

      if (roomsError) {
        // Non-critical: rooms failed but move was created
        console.error('[ROOMS INSERT ERROR]', roomsError.message);
      }

      // ── Add owner as move member ──
      const { error: memberError } = await supabase
        .from('move_members')
        .insert({ move_id: moveId, user_id: user.id });

      if (memberError) {
        // Non-critical: member insert failed but move was created
        console.error('[MEMBER INSERT ERROR]', memberError.message);
      }

      // ── Invalidate moves list so Home screen refetches ──
      queryClient.invalidateQueries({ queryKey: ['moves', user.id] });
      queryClient.invalidateQueries({ queryKey: ['userMoves', user.id] });

      // ── Set as active move and navigate to Home ──
      useActiveMoveStore.getState().setActiveMove(moveId);
      router.replace('/');
    } catch (err) {
      setError(toFriendlyError(err, 'Failed to create move.'));
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.container}>
        <ScreenHeader onBack={() => router.back()} />

        <View style={styles.body}>
          <View style={styles.heroRow}>
            <View style={styles.heroTile}>
              <Ionicons name="home-outline" size={22} color={colors.primary} />
            </View>
            <Text style={font.largeTitle}>Create Move</Text>
          </View>
          <Text style={styles.subtitle}>Give your move a name so you can find it later.</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 14 }}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.form}>
            <TextField
              label="Move Name"
              value={name}
              onChangeText={(text) => {
                setName(text);
                if (error) setError(null);
              }}
              placeholder="e.g. New Apartment"
              maxLength={MAX_NAME_LENGTH}
              showCount
              autoFocus
            />
          </View>

          <Button
            label="Create"
            onPress={handleCreate}
            disabled={!name.trim() || isSaving}
            loading={isSaving}
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
  form: {
    marginBottom: spacing.lg,
  },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    padding: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.lg,
  },
});
