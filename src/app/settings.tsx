import { useState } from 'react';
import {
  StyleSheet,
  View,
  ScrollView,
  Pressable,
  Text,
  Linking,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';

import { useQuery } from '@tanstack/react-query';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
import ConfirmModal from '@/components/confirm-modal';
import { colors, spacing, font, radius, shadow, fonts } from '../../packly-ui/theme';
import { useAuthStore } from '@/store/auth-store';
import { fetchCreditBalance } from '@/services/credits';
import { useUpgrade } from '@/hooks/use-upgrade';

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const SUPPORT_EMAIL = 'support@packly.app';
const PRIVACY_POLICY_URL = 'https://packly.app/privacy';
// Store listing URLs are added at launch; the Android link already carries
// the real application id from app.json. iOS falls back to the landing page
// until it has a real App Store URL.
const STORE_URL = Platform.select({
  ios: 'https://packly.app',
  android: 'https://play.google.com/store/apps/details?id=com.mymovinginventory.app',
  default: 'https://packly.app',
});

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  // AI voice credits (1 credit = 1 recording). Display-only.
  const { data: credits } = useQuery({
    queryKey: ['credits'],
    queryFn: fetchCreditBalance,
    staleTime: 60 * 1000,
  });
  const insets = useSafeAreaInsets();

  // Free/Pro plan (RevenueCat). Display + purchase actions live in the
  // shared useUpgrade hook (same flow the locked-photo paywall uses).
  // Purchase actions stay hidden until RevenueCat is ready (degraded mode
  // when no API key is present).
  const { isPro, rcEnabled, isPurchasing, isRestoring, upgrade, restore } = useUpgrade();

  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const userName =
    (user?.user_metadata?.name as string | undefined)?.trim() ?? 'User';
  const userEmail = user?.email ?? '';

  // ── Handlers ─────────────────────────────

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await signOut();
      router.replace('/sign-in');
    } catch {
      setIsSigningOut(false);
      setShowSignOutConfirm(false);
    }
  };

  const handleContactSupport = () => {
    const subject = encodeURIComponent('Packly Support');
    const body = encodeURIComponent('');
    Linking.openURL(
      `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`,
    ).catch(() => {
      // Fallback: silently fail if no mail client
    });
  };

  const handleRateApp = () => {
    Linking.openURL(STORE_URL).catch(() => {
      // Fallback: silently fail
    });
  };

  const handlePrivacyPolicy = () => {
    Linking.openURL(PRIVACY_POLICY_URL).catch(() => {
      // Fallback: silently fail
    });
  };

  // ── Render ───────────────────────────────

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        {/* ── Header ─────────────────────────── */}
        <ScreenHeader onBack={() => router.back()} title="Settings" />

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>

          {/* ── Account Section ──────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>ACCOUNT</Text>

            {/* ── Profile Card ──────────────── */}
            <View style={[styles.profileCard, { backgroundColor: colors.surface }]}>
              <View style={[styles.avatar, { backgroundColor: colors.primary + '15' }]}>
                <Text style={styles.avatarText}>
                  {userName.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.profileInfo}>
                <Text style={font.headline} numberOfLines={1}>
                  {userName}
                </Text>
                <Text style={styles.profileEmail} numberOfLines={1}>
                  {userEmail}
                </Text>
              </View>
            </View>
          </View>

          {/* ── Subscription ──────────────────── */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>SUBSCRIPTION</Text>

            {/* ── Plan status ──────────────── */}
            <View style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons
                  name={isPro ? 'diamond' : 'diamond-outline'}
                  size={20}
                  color={colors.primary}
                />
              </View>
              <Text style={[font.body, { flex: 1 }]}>Packly Pro</Text>
              <Text
                style={[
                  font.body,
                  { color: isPro ? colors.primary : colors.textSecondary, fontFamily: fonts.semiBold, fontWeight: '600' },
                ]}>
                {isPro ? 'Active' : 'Free'}
              </Text>
            </View>

            {/* ── Upgrade CTA ───────────────── */}
            {rcEnabled && !isPro && (
              <Pressable
                style={({ pressed }) => [
                  styles.upgradeButton,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={upgrade}
                disabled={isPurchasing}>
                {isPurchasing ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="rocket-outline" size={20} color="#FFFFFF" />
                )}
                <Text style={styles.upgradeText}>
                  {isPurchasing ? 'Upgrading…' : 'Upgrade to Pro — $5/month'}
                </Text>
              </Pressable>
            )}

            {/* ── Restore ───────────────────── */}
            {rcEnabled && (
              <Pressable
                style={({ pressed }) => [styles.restoreButton, pressed && { opacity: 0.6 }]}
                onPress={restore}
                disabled={isRestoring}>
                <Text style={styles.restoreText}>
                  {isRestoring ? 'Restoring…' : 'Restore Purchases'}
                </Text>
              </Pressable>
            )}
          </View>

          {/* ── Actions ──────────────────────── */}
          <View style={styles.section}>
            {/* ── AI Credits ────────────────── */}
            <View style={styles.actionRow}>
              <View style={[styles.actionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="mic-outline" size={20} color={colors.primary} />
              </View>
              <Text style={[font.body, { flex: 1 }]}>
                AI Recordings
              </Text>
              <Text style={[font.body, { color: colors.textSecondary }]}>
                {credits ? `${credits.balance} left` : '…'}
              </Text>
            </View>

            {/* ── Sign Out ──────────────────── */}
            <Pressable
              style={({ pressed }) => [
                styles.actionRow,
                pressed && { opacity: 0.6 },
              ]}
              onPress={() => setShowSignOutConfirm(true)}>
              <View style={[styles.actionIcon, { backgroundColor: colors.dangerSoft }]}>
                <Ionicons name="log-out-outline" size={20} color={colors.danger} />
              </View>
              <Text style={[font.body, { flex: 1, color: colors.danger }]}>
                Sign Out
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            {/* ── Contact Support ────────────── */}
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <Pressable
              style={({ pressed }) => [
                styles.actionRow,
                pressed && { opacity: 0.6 },
              ]}
              onPress={handleContactSupport}>
              <View style={[styles.actionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="mail-outline" size={20} color={colors.primary} />
              </View>
              <Text style={[font.body, { flex: 1 }]}>
                Contact Support
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            {/* ── Rate Packly ────────────────── */}
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <Pressable
              style={({ pressed }) => [
                styles.actionRow,
                pressed && { opacity: 0.6 },
              ]}
              onPress={handleRateApp}>
              <View style={[styles.actionIcon, { backgroundColor: colors.warning + '18' }]}>
                <Ionicons name="star-outline" size={20} color={colors.warning} />
              </View>
              <Text style={[font.body, { flex: 1 }]}>
                Rate Packly
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>

            {/* ── Privacy Policy ──────────────── */}
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <Pressable
              style={({ pressed }) => [
                styles.actionRow,
                pressed && { opacity: 0.6 },
              ]}
              onPress={handlePrivacyPolicy}>
              <View style={[styles.actionIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="shield-checkmark-outline" size={20} color={colors.primary} />
              </View>
              <Text style={[font.body, { flex: 1 }]}>
                Privacy Policy
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          </View>
        </ScrollView>

        {/* ── Version Footer ────────────────── */}
        <View style={[styles.versionFooter, { paddingBottom: insets.bottom + spacing.xl }]}>
          <Text style={styles.versionText}>Packly v{APP_VERSION}</Text>
        </View>
      </View>

      {/* ── Sign Out Confirmation ──────────── */}
      <ConfirmModal
        visible={showSignOutConfirm}
        title="Sign Out?"
        message="Are you sure you want to sign out? You can sign back in anytime."
        confirmLabel="Sign Out"
        confirmDestructive
        icon="log-out-outline"
        onConfirm={handleSignOut}
        onCancel={() => setShowSignOutConfirm(false)}
        isLoading={isSigningOut}
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
  scrollContent: {
    paddingBottom: spacing.xxxl,
  },

  // ── Sections ──────────────────────────
  section: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textTertiary,
    marginBottom: spacing.md,
  },

  // ── Profile Card ──────────────────────
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
    gap: spacing.lg,
    borderCurve: 'continuous',
    ...shadow.card,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  avatarText: {
    fontSize: 20,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  profileEmail: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Action Row ────────────────────────
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  divider: {
    height: 1,
    marginLeft: 68, // icon width + gap + padding
    marginVertical: 0,
  },

  // ── Subscription ──────────────────────
  upgradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    marginTop: spacing.md,
    borderCurve: 'continuous',
  },
  upgradeText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  restoreButton: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.md,
  },
  restoreText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },

  // ── Version Footer ────────────────────
  versionFooter: {
    alignItems: 'center',
    paddingBottom: spacing.xl,
    paddingTop: spacing.lg,
  },
  versionText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textTertiary,
  },
});
