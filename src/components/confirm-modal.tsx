// components/confirm-modal.tsx
// Custom confirmation and error modal that matches Packly's design system.
// Replaces the default OS-native Alert.alert() which looks out of place.
//
// Usage:
//   <ConfirmModal
//     visible={showDeleteConfirm}
//     title="Delete Room?"
//     message="This cannot be undone."
//     confirmLabel="Delete"
//     confirmDestructive
//     onConfirm={handleDelete}
//     onCancel={() => setShowDeleteConfirm(false)}
//   />
//
// For simple error alerts (single OK button):
//   <ConfirmModal
//     visible={showError}
//     title="Error"
//     message="Something went wrong."
//     showCancel={false}
//     confirmLabel="OK"
//     onConfirm={() => setShowError(false)}
//     onCancel={() => setShowError(false)}
//   />

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
import { colors, spacing, font, radius, fonts } from '../../packly-ui/theme';

// ──────────────────────────────────────────
// Props
// ──────────────────────────────────────────

interface ConfirmModalProps {
  visible: boolean;
  title: string;
  message: string;
  /** Label for the primary/confirm button. Defaults to "OK". */
  confirmLabel?: string;
  /** If true, the confirm button is styled red/destructive. */
  confirmDestructive?: boolean;
  /** If true, shows a Cancel button alongside the confirm button. Defaults to true. */
  showCancel?: boolean;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Called when the user taps the confirm button. */
  onConfirm: () => void;
  /** Called when the user taps Cancel or the backdrop. */
  onCancel: () => void;
  /** Show a loading spinner on the confirm button (e.g. during async delete). */
  isLoading?: boolean;
  /** Optional icon name from Ionicons shown above the title. */
  icon?: keyof typeof Ionicons.glyphMap;
}

// ──────────────────────────────────────────
// Component
// ──────────────────────────────────────────

export default function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = 'OK',
  confirmDestructive = false,
  showCancel = true,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isLoading = false,
  icon,
}: ConfirmModalProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 200,
          friction: 12,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.92);
    }
  }, [visible, fadeAnim, scaleAnim]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}>
      <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
        <Pressable style={styles.dismissArea} onPress={onCancel} />
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: colors.surface, transform: [{ scale: scaleAnim }] },
          ]}>
          {/* ── Icon ────────────────────── */}
          {icon && (
            <View style={[styles.iconContainer, { backgroundColor: confirmDestructive ? colors.dangerSoft : colors.primarySoft }]}>
              <Ionicons
                name={icon}
                size={28}
                color={confirmDestructive ? colors.danger : colors.primary}
              />
            </View>
          )}

          {/* ── Title ────────────────────── */}
          <Text style={[font.title, { textAlign: 'center', fontSize: 20 }]}>
            {title}
          </Text>

          {/* ── Message ──────────────────── */}
          <Text style={styles.message}>{message}</Text>

          {/* ── Buttons ──────────────────── */}
          <View style={styles.buttonRow}>
            {showCancel && (
              <Pressable
                onPress={onCancel}
                disabled={isLoading}
                style={({ pressed }) => [
                  styles.button,
                  styles.cancelButton,
                  pressed && { opacity: 0.7 },
                ]}>
                <Text style={styles.cancelButtonText}>{cancelLabel}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={onConfirm}
              disabled={isLoading}
              style={({ pressed }) => [
                styles.button,
                styles.confirmButton,
                {
                  backgroundColor: confirmDestructive ? colors.danger : colors.primary,
                  opacity: pressed || isLoading ? 0.7 : 1,
                },
              ]}>
              {isLoading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Text style={styles.confirmButtonText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Navy-tinted scrim (matches textPrimary #171A2E) instead of the old
    // near-black tint, so modals read as part of the theme.
    backgroundColor: 'rgba(23,26,46,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
  },
  dismissArea: {
    ...StyleSheet.absoluteFill,
  },

  // ── Card ──────────────────────────
  card: {
    width: '100%',
    maxWidth: 320,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
    borderCurve: 'continuous',

    // Shadow
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },

  // ── Icon ──────────────────────────
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },

  // ── Message ──────────────────────
  message: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },

  // ── Buttons ──────────────────────
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
    width: '100%',
  },
  button: {
    flex: 1,
    height: 52,
    // Pill actions — same shape as every other button in the redesign.
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  cancelButton: {
    backgroundColor: colors.surfaceMuted,
  },
  cancelButtonText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.primary,
  },
  confirmButton: {
    minWidth: 80,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
});
