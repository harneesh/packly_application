// components/CollapsibleSection.tsx
// A collapsible section used by the Settings screen — plain, card-free,
// iOS-settings style: an icon + title + meta row that smoothly expands and
// collapses its body.
//
// Visual language (big-app convention):
//   • The header's DOWN chevron (rotating 180° to UP when open) is the ONLY
//     expand/collapse affordance — vertical chevron = "this is a dropdown".
//   • Icons are flat and uniform: no colored tiles, one neutral gray.
//
// Smoothness: the height animation runs on the UI THREAD via
// react-native-reanimated (no JS work per frame, no bridge traffic). One
// shared progress value drives the body height, the content fade + glide,
// and the chevron rotation, so the whole dropdown moves as one gesture.
//
// Reliability: the touch-block (pointerEvents) lives on a plain inner View —
// NOT on the Reanimated-managed node — so tapping a closed section always
// reaches the header and reopens it. The body is always mounted, clipped by
// overflow:hidden; its natural height is measured with onLayout into a
// shared value (no re-render, no state churn).

import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, fonts, spacing } from '../theme';

/** One duration for the whole gesture (standard ease-in-out curve). */
const DURATION = 300;

interface CollapsibleSectionProps {
  /** Ionicons name shown left of the title (flat, uniform gray). */
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Small right-aligned summary text, e.g. "Active" or "5 left". */
  meta?: string;
  children: React.ReactNode;
  /** Whether the section starts expanded. */
  defaultOpen?: boolean;
  /** Icon color (defaults to the uniform neutral gray used across Settings). */
  iconColor?: string;
  containerStyle?: StyleProp<ViewStyle>;
}

export default function CollapsibleSection({
  icon,
  title,
  meta,
  children,
  defaultOpen = true,
  iconColor = colors.textSecondary,
  containerStyle,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  // 1 = fully open, 0 = fully collapsed. Lives entirely on the UI thread.
  const progress = useSharedValue(defaultOpen ? 1 : 0);
  // Natural content height from onLayout — a shared value, so measuring
  // never triggers a React re-render. 0 = not measured yet.
  const contentHeight = useSharedValue(0);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    // Starting a new timing supersedes any in-flight one, so rapid tapping
    // always lands on the correct final state.
    progress.value = withTiming(next ? 1 : 0, {
      duration: DURATION,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });
  };

  // Body height: measured content height × progress. Until the first layout
  // we omit height (auto) so an open-by-default section never flashes from 0.
  const bodyStyle = useAnimatedStyle(() => {
    if (contentHeight.value === 0) {
      return { opacity: progress.value };
    }
    return {
      height: Math.max(0, progress.value * contentHeight.value),
      opacity: progress.value,
    };
  });

  // Content glides down a touch as it reveals — reads as a drawer sliding out.
  const contentStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [-12, 0]) },
    ],
  }));

  // Chevron: DOWN when closed ("tap to expand"), rotating 180° to UP when
  // open ("tap to collapse"). Vertical chevron = dropdown, the standard
  // expand affordance in big apps — distinct from the right-chevron used
  // for row navigation.
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(progress.value, [0, 1], [0, 180])}deg` },
    ],
  }));

  return (
    <View style={containerStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        onPress={toggle}
        style={({ pressed }) => [styles.header, pressed && { opacity: 0.7 }]}>
        <Ionicons name={icon} size={20} color={iconColor} />
        <Text style={[font.headline, styles.title]} numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        <Animated.View style={chevronStyle}>
          <Ionicons name="chevron-down" size={16} color={colors.textTertiary} />
        </Animated.View>
      </Pressable>

      {/* overflow:hidden clips the body while it collapses to height 0. */}
      <Animated.View style={[styles.clip, bodyStyle]}>
        {/* Touch-block lives on a plain (non-Reanimated) View: a closed
            section can never swallow taps, so it always reopens. */}
        <View pointerEvents={isOpen ? 'auto' : 'none'} style={styles.fill}>
          <Animated.View style={contentStyle}>
            <View
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                if (h > 0) contentHeight.value = h;
              }}>
              {children}
            </View>
          </Animated.View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Header ────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  title: {
    flex: 1,
  },
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
    maxWidth: 140,
  },

  // ── Body ──────────────────────────────
  clip: {
    overflow: 'hidden',
  },
  fill: {
    // Small pause between the header and its content; the rows carry their
    // own vertical rhythm.
    paddingBottom: spacing.xs,
  },
});
