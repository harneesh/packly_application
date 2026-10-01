import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/store/auth-store';
import { Link } from 'expo-router';
import { colors, spacing, radius, font, fonts, shadow } from '../../../packly-ui/theme';

export default function SignUpScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedUp, setSignedUp] = useState(false);
  const { signUp, isLoading, error, clearError } = useAuthStore();

  const handleSignUp = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) return;
    if (password.length < 6) return;
    const success = await signUp(name.trim(), email.trim(), password);
    if (success) setSignedUp(true);
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
              Account created! We've sent a confirmation link to your email. Please verify your
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
        <View style={styles.header}>
          <View style={styles.logoTile}>
            <Ionicons name="cube" size={30} color="#FFFFFF" />
          </View>
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
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Sign Up</Text>
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
    paddingHorizontal: spacing.xxl,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxxl,
    gap: spacing.sm,
  },
  // Brand mark — same indigo tile as Sign In.
  logoTile: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
    borderCurve: 'continuous',
    ...shadow.card,
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
