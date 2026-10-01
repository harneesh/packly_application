// components/label-prompt-modal.tsx
// Shown after creating a box or opening a box whose label hasn't been written yet.
// The user must confirm they've written the box number on the physical box before accessing it.

import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, radius, shadow, fonts } from '../../packly-ui/theme';

interface LabelPromptModalProps {
  visible: boolean;
  boxNumber: string;
  onWroteIt: () => void;
  onSkip: () => void;
  loading?: boolean;
}

export default function LabelPromptModal({
  visible,
  boxNumber,
  onWroteIt,
  onSkip,
  loading,
}: LabelPromptModalProps) {
  const scaleAnim = useRef(new Animated.Value(0.85)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      scaleAnim.setValue(0.85);
      opacityAnim.setValue(0);
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 100, friction: 10 }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, scaleAnim, opacityAnim]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onSkip}>
      <View style={styles.backdrop}>
        <Animated.View
          style={[
            styles.card,
            {
              opacity: opacityAnim,
              transform: [{ scale: scaleAnim }],
            },
          ]}>
          {/* ── Icon ──────────────────────────── */}
          <View style={styles.iconRow}>
            <View style={styles.iconWrap}>
              <View style={styles.boxIcon}>
                <Ionicons name="cube" size={36} color={colors.box} />
              </View>
              <View style={styles.penIcon}>
                <Ionicons name="create-outline" size={16} color="#FFFFFF" />
              </View>
            </View>
          </View>

          {/* ── Title ─────────────────────────── */}
          <Text style={styles.title}>Label Your Box</Text>

          {/* ── Body ──────────────────────────── */}
          <Text style={styles.body}>
            Write <Text style={styles.bold}>{boxNumber}</Text> on your physical box using a{' '}
            <Text style={styles.bold}>marker or pen</Text>. This helps you find your items
            quickly after the move.
          </Text>

          {/* ── Buttons ───────────────────────── */}
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              (pressed || loading) && { opacity: 0.8 },
            ]}
            onPress={onWroteIt}
            disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
            )}
            <Text style={styles.primaryText}>I Wrote It</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.6 }]}
            onPress={onSkip}
            disabled={loading}>
            <Text style={styles.skipText}>I Didn't Write It</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(23,26,46,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.lg,
    borderCurve: 'continuous',
    ...shadow.card,
  },

  // ── Icon ──────────────────────────────
  iconRow: {
    marginBottom: spacing.xs,
  },
  iconWrap: {
    position: 'relative',
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.boxSoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  penIcon: {
    position: 'absolute',
    bottom: 2,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },

  // ── Text ──────────────────────────────
  title: {
    fontSize: 22,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  bold: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  // ── Buttons ───────────────────────────
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    width: '100%',
    justifyContent: 'center',
    height: 52,
    borderCurve: 'continuous',
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  skipBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  skipText: {
    fontSize: 15,
    color: colors.textSecondary,
    fontFamily: fonts.medium,
    fontWeight: '500',
  },
});
