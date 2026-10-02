import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link, router } from 'expo-router';
import { FontAwesome } from '@expo/vector-icons';
import { useAuthStore } from '@/store/auth-store';
import AuthLogo from '@/components/auth-logo';
import { colors, spacing, radius, font, fonts, shadow } from '../../../packly-ui/theme';

export default function SignUpScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedUp, setSignedUp] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const { signUp, signInWithGoogle, isLoading, error, clearError } = useAuthStore();

  const handleSignUp = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) return;
    if (password.length < 6) return;
    const success = await signUp(name.trim(), email.trim(), password);
    if (success) setSignedUp(true);
  };

  // Google creates the Packly account on first use, so "Continue with Google"
  // is the same flow as on Sign In — no email confirmation step needed.
  const handleGoogleSignUp = async () => {
    if (isLoading || googleLoading) return;
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
    } finally {
      setGoogleLoading(false);
    }
  };

  useEffect(() => {
    if (signedUp) {
      const timer = setTimeout(() => {
        router.replace('/sign-in');
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [signedUp]);

  if (signedUp) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.successContainer}>
          <Text style={font.largeTitle}>Check Your Email</Text>
          <View style={[styles.successBox, { backgroundColor: colors.packedSoft }]}>
            <Text style={{ color: colors.packed, textAlign: 'center', fontFamily: fonts.medium }}>
              Account created! We&apos;ve sent a confirmation link to your email. Please verify your
              email address before signing in.
            </Text>
          </View>
          <Text style={[font.body, { color: colors.textSecondary, marginTop: spacing.sm }]}>
            Redirecting to Sign In...
          </Text>
          <Link href="/sign-in" asChild>
            <Pressable>
              <Text style={{ color: colors.primary, fontFamily: fonts.semiBold, fontWeight: '600' }}>Tap here to go now</Text>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.container}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <AuthLogo />
            <Text style={font.largeTitle}>Create Account</Text>
            <Text style={[font.body, { color: colors.textSecondary }]}>
              Sign up to start packing with Packly
            </Text>
          </View>

          <View style={styles.form}>
            {error ? (
              <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                <Text style={{ color: colors.danger }}>{error}</Text>
              </View>
            ) : null}

            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              placeholder="Your name"
              placeholderTextColor={colors.textTertiary}
              value={name}
              onChangeText={(text) => { setName(text); clearError(); }}
              autoCapitalize="words"
              editable={!isLoading}
              maxLength={100}
            />

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.textTertiary}
              value={email}
              onChangeText={(text) => { setEmail(text); clearError(); }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!isLoading}
              maxLength={254}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              placeholder="At least 6 characters"
              placeholderTextColor={colors.textTertiary}
              value={password}
              onChangeText={(text) => { setPassword(text); clearError(); }}
              secureTextEntry
              editable={!isLoading}
              returnKeyType="done"
              onSubmitEditing={handleSignUp}
              maxLength={128}
            />

            <Pressable
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.85 },
              ]}
              onPress={handleSignUp}
              disabled={isLoading || googleLoading}
            >
              {isLoading && !googleLoading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Sign Up</Text>
              )}
            </Pressable>

            <View style={styles.divider}>
              <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
              <Text style={[font.caption, { color: colors.textSecondary }]}>or</Text>
              <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.googleButton,
                pressed && { opacity: 0.85 },
              ]}
              onPress={handleGoogleSignUp}
              disabled={isLoading || googleLoading}
            >
              {googleLoading ? (
                <ActivityIndicator color="#4285F4" />
              ) : (
                <>
                  <FontAwesome name="google" size={18} color="#4285F4" />
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </>
              )}
            </Pressable>
          </View>

          <View style={styles.footer}>
            <Text style={[font.body, { color: colors.textSecondary }]}>
              Already have an account?{' '}
            </Text>
            <Link href="/sign-in" asChild>
              <Pressable>
                <Text style={{ color: colors.primary, fontFamily: fonts.semiBold, fontWeight: '600' }}>Sign In</Text>
              </Pressable>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  // Centred like Sign In, but scrollable — the form plus Google button can be
  // taller than a small screen (or what the keyboard leaves of it).
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  form: {
    gap: spacing.md,
    marginBottom: spacing.xxxl,
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  // White fields with a hairline border — same field language as TextField.
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    // Fixed height + zero vertical padding + Android centering (see sign-in).
    paddingVertical: 0,
    textAlignVertical: 'center',
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
    height: 52,
    borderCurve: 'continuous',
  },
  button: {
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    borderCurve: 'continuous',
    ...shadow.card,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.md,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  // Same Google button as Sign In.
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.pill,
    height: 52,
    borderCurve: 'continuous',
  },
  googleButtonText: {
    fontSize: 16,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.md,
  },
  successBox: {
    padding: spacing.xxl,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
});
