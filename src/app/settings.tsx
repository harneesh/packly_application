// app/settings.tsx
// Settings — collapsible sections, open by default:
//   1. Account      — profile + sign out (icon beside the name)
//   2. Subscription — Free/Pro plan status, upgrade, restore purchases
//   3. Help Centre  — contact support, FAQ, rate Packly
//   4. About        — privacy policy, terms of service, share Packly
// Below the sections: a plain Delete Account button (store-policy
// requirement — tombstones the account, see migration 015) and the app
// version in tiny text at the very end.
//
// The page itself is swipeable: dragging down anywhere (or on the header, at
// any scroll position) closes Settings, matching the shared bottom sheet.
//
// Subscription is the app's purchase surface (restored after the redesign
// dropped it): it drives the SAME shared useUpgrade hook (RevenueCat) the
// locked-photo paywalls reference, so purchase + restore behave identically
// everywhere. Purchase actions stay hidden until RevenueCat is configured.

import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  StyleSheet,
  View,
  Text,
  Pressable,
  Linking,
  Share,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
import CollapsibleSection from '../../packly-ui/components/CollapsibleSection';
import ConfirmModal from '@/components/confirm-modal';
import { colors, spacing, font, radius, fonts, shadow } from '../../packly-ui/theme';
import { useAuthStore } from '@/store/auth-store';
import { deleteAccount } from '@/services/account';
import { toFriendlyError } from '@/lib/errors';
import { useUpgrade } from '@/hooks/use-upgrade';

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const SUPPORT_EMAIL = 'harneeshyadav@gmail.com';
const PRIVACY_POLICY_URL = 'https://packly.app/privacy';
const TERMS_URL = 'https://packly.app/terms';

// ──────────────────────────────────────────
// Swipe down to dismiss
// ──────────────────────────────────────────

// The page is what moves: the whole safe-area surface — background included —
// follows the finger, so the screen underneath is revealed as it slides away.
// Settings is presented as a transparent modal (see app/_layout.tsx) so a real
// screen is what appears behind it (not a blank window).
const AnimatedSafeAreaView = Animated.createAnimatedComponent(SafeAreaView);

/**
 * Leave Settings. Shared by the back button and the swipe gesture: a deep link
 * can land here with nothing behind it, in which case go home instead of
 * leaving a page that has slid off-screen with no way back.
 */
function closeSettings() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

/**
 * Live gesture state, owned by the closure that wires the drag up (see the
 * `drag` memo in the screen) so the callbacks always read current values
 * instead of a stale copy.
 */
interface DragState {
  /** Vertical scroll offset of the section list (0 = at the top). */
  scrollY: number;
  /** Whether this gesture is allowed to move the page (decided on touch-down). */
  canDrag: boolean;
  /** How far the page has been dragged so far (0 at rest). */
  distance: number;
  /** Flips the moment a dismissal starts; the rest of the gesture is ignored. */
  dismissing: boolean;
}

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const insets = useSafeAreaInsets();

  // Free/Pro plan (RevenueCat). Display + purchase actions come from the
  // shared hook — this screen owns no purchase logic of its own.
  // The upgrade pill opens the paywall (Free vs Pro), which runs the purchase.
  const { isPro, rcEnabled, isPurchasing, isRestoring, restore } = useUpgrade();

  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Swipe down to dismiss ────────────────
  // Animated value, gesture and live state in one place. Rebuilt when the
  // window resizes, which also parks the page back at its resting position.
  //
  // The drag runs on Gesture Handler rather than a PanResponder because a core
  // RN pan responder cannot win a vertical drag that starts inside a
  // ScrollView — the list takes the touch natively. Here the pan is registered
  // as simultaneous with the list's own gesture: the page follows the finger
  // while the list is at the top, and the list scrolls as usual everywhere
  // else (see the onBegin/onUpdate guards below).
  const { height: windowHeight } = useWindowDimensions();
  // Gesture Handler resolves the list's own scroll gesture from this ref so the
  // page pan and the list can run together (see the gesture below).
  const listRef = useRef(null);
  const drag = useMemo(() => {
    const state: DragState = { scrollY: 0, canDrag: false, distance: 0, dismissing: false };
    const translateY = new Animated.Value(0);
    const dismissDistance = windowHeight * 0.3;
    // The header sits outside the list, so a touch down there may always drag
    // (page coordinates; ScreenHeader is a fixed 56pt row under the inset).
    const headerBand = insets.top + 56;

    const springBack = () => {
      Animated.spring(translateY, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    };

    const pan = Gesture.Pan()
      // Callbacks run on the JS thread and drive a core Animated value (the
      // same style the rest of the app uses); no worklets involved.
      .runOnJS(true)
      // Gesture Handler resolves the relation from the ref when the gesture
      // attaches (nothing reads it while rendering), so the refs lint rule is a
      // false positive here.
      // eslint-disable-next-line react-hooks/refs
      .simultaneousWithExternalGesture(listRef)
      .activeOffsetY([-10, 10])
      .failOffsetX([-24, 24])
      .onBegin((e) => {
        // Decide on touch-down, before anything has moved: the page may be
        // dragged from the header at any scroll position, or from anywhere
        // else while the list is at the very top.
        state.canDrag = state.scrollY <= 1 || (e.y > 0 && e.y <= headerBand);
        state.distance = 0;
      })
      .onUpdate((e) => {
        if (state.dismissing || !state.canDrag) return;
        // Dragging up is a no-op — the page only travels down.
        const y = Math.max(0, e.translationY);
        state.distance = y;
        translateY.setValue(y);
      })
      .onFinalize((e) => {
        if (state.dismissing || !state.canDrag) return;
        state.canDrag = false;
        const distance = state.distance;
        state.distance = 0;
        // A gesture that never moved the page (a tap, or a drag while the list
        // was scrolled) has nothing to decide.
        if (distance === 0) return;
        // Past ~30% of the screen height, or flung down — same thresholds and
        // spring as the shared bottom sheet.
        if (distance > dismissDistance || e.velocityY > 800) {
          state.dismissing = true;
          Animated.timing(translateY, {
            toValue: windowHeight,
            duration: 180,
            useNativeDriver: true,
          }).start(() => closeSettings());
        } else {
          springBack();
        }
      });

    return {
      pan,
      translateY,
      /** Reported by the list's onScroll — the gesture reads it live. */
      setScrollY: (offset: number) => {
        state.scrollY = offset;
      },
    };
  }, [windowHeight, insets.top]);

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

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await deleteAccount();
      // The account is tombstoned server-side — end the local session.
      // Best-effort: a signOut hiccup must not read as "deletion failed"
      // when the account is already gone.
      try {
        await signOut();
      } catch {}
      router.replace('/sign-in');
    } catch (err) {
      setDeleteError(toFriendlyError(err, 'Failed to delete your account. Please try again.'));
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleContactSupport = () => {
    const subject = encodeURIComponent('Packly Support');
    const body = encodeURIComponent(
      `Packly v${APP_VERSION} · ${Platform.OS} ${Platform.Version}\n\n`,
    );
    Linking.openURL(
      `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`,
    ).catch(() => {
      // Fallback: silently fail if no mail client
    });
  };

  // Packly has no store listing yet, so there is nothing to link to.
  const handleRateApp = () => {
    Alert.alert(
      'Thanks for the love! 💛',
      "Packly isn't on the Play Store yet — ratings open as soon as it launches.",
    );
  };

  const handleOpenURL = (url: string) => {
    Linking.openURL(url).catch(() => {
      // Fallback: silently fail
    });
  };

  const handleShareApp = () => {
    Share.share({
      message: 'Packly — the moving app that listens while you pack. 📦',
    }).catch(() => {
      // User dismissed the share sheet — nothing to do
    });
  };

  // ── Render ───────────────────────────────

  return (
    <GestureDetector gesture={drag.pan}>
      <AnimatedSafeAreaView
        style={[
          styles.safeArea,
          {
            backgroundColor: colors.background,
            transform: [{ translateY: drag.translateY }],
          },
        ]}>
        {/* ── Header ─────────────────────────── */}
        <ScreenHeader onBack={closeSettings} title="Settings" />

        <ScrollView
          ref={listRef}
          // A downward drag at the top of the page IS the dismiss gesture, so
          // the list must not rubber-band (or glow on Android) underneath it
          // while the page slides away.
          bounces={false}
          overScrollMode="never"
          onScroll={(e) => {
            // Read at gesture time: a drag may only move the page while the
            // list is at the top.
            drag.setScrollY(e.nativeEvent.contentOffset.y);
          }}
          scrollEventThrottle={16}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + spacing.xxxl },
          ]}
          showsVerticalScrollIndicator={false}>

          {/* ── 1. Account ───────────────────── */}
          <CollapsibleSection icon="person-outline" title="Account" iconColor={colors.accentDeep}>
            <View style={styles.card}>
              <View style={styles.profileRow}>
                <View style={styles.avatar}>
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
                {/* Sign out lives beside the name — one tap, no hunting. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign out"
                  hitSlop={6}
                  style={({ pressed }) => [
                    styles.signOutButton,
                    pressed && { opacity: 0.6 },
                  ]}
                  onPress={() => setShowSignOutConfirm(true)}>
                  <Ionicons name="log-out-outline" size={18} color={colors.danger} />
                </Pressable>
              </View>
            </View>
          </CollapsibleSection>

          {/* ── 2. Subscription ───────────────── */}
          <CollapsibleSection icon="diamond-outline" title="Subscription" iconColor={colors.accentDeep}>
            <View style={styles.card}>
              {/* Plan status — the one always-visible row. */}
              <View style={styles.row}>
                <View style={styles.iconTile}>
                  <Ionicons
                    name={isPro ? 'diamond' : 'diamond-outline'}
                    size={17}
                    color={colors.primary}
                  />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Packly Pro</Text>
                <Text style={[styles.planValue, isPro && { color: colors.primary }]}>
                  {isPro ? 'Active' : 'Free'}
                </Text>
              </View>

              {/* Upgrade CTA — only when a purchase is actually possible
                  (RevenueCat configured) and the user is still on Free. */}
              {rcEnabled && !isPro && (
                <View style={styles.ctaWrap}>
                  <Pressable
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.upgradeButton,
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={() => router.push('/paywall')}
                    disabled={isPurchasing}>
                    {isPurchasing ? (
                      <ActivityIndicator size="small" color={colors.textInverse} />
                    ) : (
                      <Ionicons name="rocket-outline" size={18} color={colors.textInverse} />
                    )}
                    <Text style={styles.upgradeText}>
                      {isPurchasing ? 'Upgrading…' : 'Upgrade to Pro — $5/month'}
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* Restore — the store-required recovery path. */}
              {rcEnabled && (
                <>
                  <View style={[styles.divider, { backgroundColor: colors.divider }]} />
                  <Pressable
                    style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                    onPress={restore}
                    disabled={isRestoring}>
                    <View style={styles.iconTile}>
                      <Ionicons name="refresh-outline" size={17} color={colors.primary} />
                    </View>
                    <Text style={[font.bodyMedium, styles.rowText]}>
                      {isRestoring ? 'Restoring…' : 'Restore Purchases'}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </CollapsibleSection>

          {/* ── 3. Help Centre ────────────────── */}
          <CollapsibleSection icon="help-circle-outline" title="Help Centre" iconColor={colors.accentDeep}>
            <View style={styles.card}>
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={handleContactSupport}>
                <View style={styles.iconTile}>
                  <Ionicons name="mail-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Contact Support</Text>
              </Pressable>

              <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              {/* FAQ opens its own page — the one right-chevron in Help Centre
                  (right-chevron = navigates, matching platform convention). */}
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => router.push('/faq')}>
                <View style={styles.iconTile}>
                  <Ionicons name="document-text-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Frequently Asked Questions</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
              </Pressable>

              <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={handleRateApp}>
                <View style={styles.iconTile}>
                  <Ionicons name="star-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Rate Packly</Text>
              </Pressable>
            </View>
          </CollapsibleSection>

          {/* ── 4. About ──────────────────────── */}
          <CollapsibleSection icon="information-circle-outline" title="About" iconColor={colors.accentDeep}>
            <View style={styles.card}>
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => handleOpenURL(PRIVACY_POLICY_URL)}>
                <View style={styles.iconTile}>
                  <Ionicons name="document-text-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Privacy Policy</Text>
              </Pressable>

              <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => handleOpenURL(TERMS_URL)}>
                <View style={styles.iconTile}>
                  <Ionicons name="document-attach-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Terms of Service</Text>
              </Pressable>

              <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={handleShareApp}>
                <View style={styles.iconTile}>
                  <Ionicons name="share-social-outline" size={17} color={colors.primary} />
                </View>
                <Text style={[font.bodyMedium, styles.rowText]}>Share Packly</Text>
              </Pressable>
            </View>
          </CollapsibleSection>

          {/* ── 5. Delete Account ─────────────────
                 Same collapsible chrome as the sections above, but CLOSED by
                 default: the destructive action stays one deliberate tap
                 away instead of sitting open at the bottom of the page. ── */}
          <CollapsibleSection
            icon="trash-outline"
            title="Delete Account"
            iconColor={colors.danger}
            defaultOpen={false}>
            <View style={[styles.card, styles.dangerCard]}>
              <Pressable
                style={({ pressed }) => [styles.deleteButton, pressed && { opacity: 0.85 }]}
                onPress={() => setShowDeleteConfirm(true)}
                disabled={isDeleting}>
                {isDeleting ? (
                  <ActivityIndicator size="small" color={colors.textInverse} />
                ) : (
                  <Ionicons name="trash-outline" size={18} color={colors.textInverse} />
                )}
                <Text style={styles.deleteText}>Delete Account</Text>
              </Pressable>
            </View>
          </CollapsibleSection>

          {/* ── Version — tiny text at the very end ── */}
          <Text style={styles.versionText}>Packly v{APP_VERSION}</Text>
        </ScrollView>

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

        {/* ── Delete Account Confirmation ────── */}
        <ConfirmModal
          visible={showDeleteConfirm}
          title="Delete Account?"
          message="This permanently deletes your account and wipes your remaining credits. You won't be able to sign back in. If your Pro plan is shared with a move, deleting your account can end Pro for everyone in it."
          confirmLabel="Delete"
          confirmDestructive
          icon="trash-outline"
          onConfirm={handleDeleteAccount}
          onCancel={() => setShowDeleteConfirm(false)}
          isLoading={isDeleting}
        />

        {/* ── Delete Error ───────────────────── */}
        <ConfirmModal
          visible={deleteError !== null}
          title="Something went wrong"
          message={deleteError ?? ''}
          showCancel={false}
          confirmLabel="OK"
          icon="alert-circle-outline"
          onConfirm={() => setDeleteError(null)}
          onCancel={() => setDeleteError(null)}
        />
      </AnimatedSafeAreaView>
    </GestureDetector>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    gap: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },

  // ── Card — white grouped container behind each section's rows ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    overflow: 'hidden',
    ...shadow.card,
  },

  // ── Rows (inside cards) ────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  rowText: {
    flex: 1,
  },
  // Soft indigo tile behind each row icon (same language as the section
  // headers and list leading icons).
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  divider: {
    height: 1,
    // Starts at the label: row padding (16) + tile (34) + gap (12)
    marginLeft: 62,
    backgroundColor: colors.divider,
  },

  // ── Profile row (first row of the Account card) ──
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primarySoft,
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
  signOutButton: {
    // Sits at the trailing edge of the profile row (profileInfo flexes to
    // fill the space before it).
    marginLeft: spacing.xs,
  },

  // ── Subscription ──────────────────────
  // Plan value on the status row: indigo when Pro, quiet grey while Free.
  planValue: {
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  // Inset wrapper around the full-width upgrade pill — the same 12pt inset
  // the Delete Account card gives its button.
  ctaWrap: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  upgradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    borderCurve: 'continuous',
  },
  upgradeText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textInverse,
  },

  // ── Delete Account ────────────────────
  // The card wrapper insets the red pill from the card edges (the other
  // sections' rows bring their own padding).
  dangerCard: {
    padding: spacing.md,
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
    borderCurve: 'continuous',
  },
  deleteText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textInverse,
  },

  // ── Version footer ────────────────────
  versionText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});
