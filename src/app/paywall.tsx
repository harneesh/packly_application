// app/paywall.tsx
// Paywall — compares the Free tier with Packly Pro and drives the purchase.
//
// Opened from Settings → Subscription and from the box screen's
// "out of recordings" pill. All purchase + restore logic comes from the
// shared useUpgrade hook, so this screen behaves exactly like every other
// upgrade surface. Once the plan flips to Pro the CTA turns into a
// "You're on Pro" confirmation instead of closing on its own, so the user
// sees the purchase land.

import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, font, radius, fonts, shadow } from '../../packly-ui/theme';
import { useUpgrade } from '@/hooks/use-upgrade';
import { MAX_PHOTOS_PER_BOX } from '@/services/photos';

// ──────────────────────────────────────────
// Content
// ──────────────────────────────────────────

const PRO_PRICE = '$5';
const PRO_RECORDINGS = 200;
const FREE_RECORDINGS = 5;

/** A cell is either a check / cross, or a short value like "Unlimited". */
type Cell = boolean | string;

const FEATURES: { label: string; icon: keyof typeof Ionicons.glyphMap; free: Cell; pro: Cell }[] = [
  { label: 'Moves, rooms & boxes', icon: 'cube-outline', free: 'Unlimited', pro: 'Unlimited' },
  { label: 'Invite your household', icon: 'people-outline', free: true, pro: true },
  { label: 'Type items manually', icon: 'create-outline', free: true, pro: true },
  { label: 'Search every box', icon: 'search-outline', free: true, pro: true },
  { label: 'AI voice recordings', icon: 'mic-outline', free: `${FREE_RECORDINGS} total`, pro: `${PRO_RECORDINGS}/mo` },
  { label: `Box photos (${MAX_PHOTOS_PER_BOX} per box)`, icon: 'images-outline', free: false, pro: true },
  { label: 'Pro shared with your move', icon: 'sparkles-outline', free: false, pro: true },
];

const HIGHLIGHTS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'mic',
    title: `${PRO_RECORDINGS} AI recordings a month`,
    body: 'Say what you packed — Packly turns it into box items for you.',
  },
  {
    icon: 'images',
    title: 'Photos of every box',
    body: 'Snap what went inside so you can find it without opening anything.',
  },
  {
    icon: 'people',
    title: 'One plan, whole move',
    body: 'Everyone in your move gets Pro features and shares your recordings.',
  },
];

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

function close() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();
  const { isPro, rcEnabled, isPurchasing, isRestoring, upgrade, restore } = useUpgrade();
  const busy = isPurchasing || isRestoring;

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      {/* ── Close ─────────────────────────── */}
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={10}
          onPress={close}
          style={({ pressed }) => [styles.closeButton, pressed && { opacity: 0.6 }]}>
          <Ionicons name="close" size={22} color={colors.textPrimary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>

        {/* ── Hero ──────────────────────────── */}
        <View style={styles.hero}>
          <View style={styles.logoTile}>
            <Image
              source={require('../../assets/images/splash-icon.png')}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>
          <View style={styles.proBadge}>
            <Ionicons name="diamond" size={12} color={colors.navyDeep} />
            <Text style={styles.proBadgeText}>PACKLY PRO</Text>
          </View>
          <Text style={[font.largeTitle, styles.heroTitle]}>Pack faster.{'\n'}Find anything.</Text>
          <Text style={styles.heroSubtitle}>
            Everything in Free, plus voice-powered packing and box photos for your whole move.
          </Text>
        </View>

        {/* ── Highlights ────────────────────── */}
        <View style={styles.highlights}>
          {HIGHLIGHTS.map((h) => (
            <View key={h.title} style={styles.highlightRow}>
              <View style={styles.highlightIcon}>
                <Ionicons name={h.icon} size={18} color={colors.navyDeep} />
              </View>
              <View style={styles.highlightText}>
                <Text style={styles.highlightTitle}>{h.title}</Text>
                <Text style={styles.highlightBody}>{h.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* ── Free vs Pro ───────────────────── */}
        <Text style={[font.eyebrow, styles.eyebrow]}>COMPARE PLANS</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.headerCell, styles.featureCol]} />
            <View style={styles.valueCol}>
              <Text style={styles.headerCell}>Free</Text>
              <Text style={styles.headerPrice}>$0</Text>
            </View>
            <View style={[styles.valueCol, styles.proCol, styles.proColTop]}>
              <Text style={[styles.headerCell, { color: colors.textInverse }]}>Pro</Text>
              <Text style={[styles.headerPrice, { color: colors.accent }]}>{PRO_PRICE}/mo</Text>
            </View>
          </View>

          {FEATURES.map((f, index) => {
            const last = index === FEATURES.length - 1;
            return (
              <View key={f.label} style={[styles.tableRow, index > 0 && styles.tableRowDivider]}>
                <View style={[styles.featureCol, styles.featureCell]}>
                  <Ionicons name={f.icon} size={16} color={colors.textSecondary} />
                  <Text style={styles.featureLabel}>{f.label}</Text>
                </View>
                <View style={styles.valueCol}>
                  <ValueCell value={f.free} />
                </View>
                <View style={[styles.valueCol, styles.proCol, last && styles.proColBottom]}>
                  <ValueCell value={f.pro} pro />
                </View>
              </View>
            );
          })}
        </View>

        <Text style={styles.finePrint}>
          Pro renews monthly at {PRO_PRICE} until cancelled. Cancel anytime from your app store
          subscriptions. Free recordings never expire; Pro recordings refresh each billing period.
        </Text>
      </ScrollView>

      {/* ── Purchase footer ───────────────── */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        {isPro ? (
          <View style={styles.activeBox}>
            <Ionicons name="checkmark-circle" size={20} color={colors.packed} />
            <Text style={styles.activeText}>You&apos;re on Packly Pro</Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={upgrade}
            disabled={!rcEnabled || busy}
            style={({ pressed }) => [
              styles.ctaButton,
              (!rcEnabled || busy) && { opacity: 0.6 },
              pressed && { opacity: 0.85 },
            ]}>
            {isPurchasing ? (
              <ActivityIndicator size="small" color={colors.textInverse} />
            ) : (
              <Ionicons name="rocket-outline" size={18} color={colors.textInverse} />
            )}
            <Text style={styles.ctaText}>
              {isPurchasing ? 'Upgrading…' : `Upgrade to Pro — ${PRO_PRICE}/month`}
            </Text>
          </Pressable>
        )}

        {!rcEnabled && !isPro ? (
          <Text style={styles.footerNote}>Purchases aren&apos;t available in this build.</Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={isPro ? close : restore}
            disabled={busy}
            hitSlop={8}
            style={({ pressed }) => [styles.secondaryButton, pressed && { opacity: 0.6 }]}>
            <Text style={styles.secondaryText}>
              {isPro ? 'Done' : isRestoring ? 'Restoring…' : 'Restore purchases'}
            </Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function ValueCell({ value, pro = false }: { value: Cell; pro?: boolean }) {
  if (typeof value === 'string') {
    return (
      <Text style={[styles.valueText, pro && { color: colors.textInverse }]} numberOfLines={1}>
        {value}
      </Text>
    );
  }
  if (value) {
    return <Ionicons name="checkmark-circle" size={20} color={pro ? colors.accent : colors.packed} />;
  }
  return <Ionicons name="close" size={18} color={colors.textTertiary} />;
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },

  // ── Hero ──────────────────────────────
  hero: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  logoTile: {
    width: 104,
    height: 104,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
    marginBottom: spacing.lg,
    ...shadow.card,
  },
  logo: {
    width: 72,
    height: 72,
  },
  proBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    marginBottom: spacing.md,
  },
  proBadgeText: {
    fontSize: 11,
    fontFamily: fonts.bold,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.navyDeep,
  },
  heroTitle: {
    textAlign: 'center',
  },
  heroSubtitle: {
    ...font.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },

  // ── Highlights ────────────────────────
  highlights: {
    backgroundColor: colors.navy,
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    padding: spacing.lg,
    gap: spacing.lg,
    marginBottom: spacing.xxl,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  highlightIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  highlightText: {
    flex: 1,
    gap: 2,
  },
  highlightTitle: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textInverse,
  },
  highlightBody: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.textOnNavy,
  },

  // ── Comparison table ──────────────────
  eyebrow: {
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  table: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
    paddingLeft: spacing.lg,
    ...shadow.card,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  tableRowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  featureCol: {
    flex: 1,
  },
  featureCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingRight: spacing.sm,
  },
  featureLabel: {
    flex: 1,
    fontSize: 13,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  valueCol: {
    width: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  // The Pro column is a continuous navy stripe down the table.
  proCol: {
    backgroundColor: colors.navy,
  },
  proColTop: {
    paddingTop: spacing.lg,
  },
  proColBottom: {
    paddingBottom: spacing.lg,
  },
  headerCell: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  headerPrice: {
    fontSize: 12,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  valueText: {
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  finePrint: {
    fontSize: 12,
    fontFamily: fonts.regular,
    color: colors.textTertiary,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.sm,
  },

  // ── Footer ────────────────────────────
  footer: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    borderCurve: 'continuous',
  },
  ctaText: {
    fontSize: 16,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textInverse,
  },
  activeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.packedSoft,
  },
  activeText: {
    fontSize: 16,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.packed,
  },
  secondaryButton: {
    alignSelf: 'center',
    paddingVertical: spacing.xs,
  },
  secondaryText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
  },
  footerNote: {
    fontSize: 12,
    fontFamily: fonts.regular,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
