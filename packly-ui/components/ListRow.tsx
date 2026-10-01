// components/ListRow.tsx
// One reusable row for every list in the app (moves, rooms, boxes, items).
// This is what replaces the plain gray boxes in the old UI: a card with a
// leading icon, title/subtitle, and an optional right-side chevron, meta
// text, or "..." menu button.

import React, { useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import LeadingIcon, { IconType } from './LeadingIcon';
import StatusPill, { BoxStatus } from './StatusPill';
import { colors, radius, spacing, font, fonts, shadow } from '../theme';

interface ListRowProps {
  iconType: IconType;
  iconLabel?: string | null;
  title: string;
  subtitle?: string;
  badge?: string; // small pill under the title, e.g. an invite code
  meta?: string; // right-aligned small text, e.g. "1d ago"
  chevron?: boolean;
  onPress?: () => void;
  /** Long press — opens the row's action sheet (e.g. rename/delete a box). */
  onLongPress?: () => void;
  onMenuPress?: () => void; // shows a "..." button when provided
  /**
   * Status pill on the right (mockup §1: Packed/Packing/Empty). When
   * `onStatusPress` is given the pill is tappable (tap = toggle packed).
   */
  status?: BoxStatus;
  onStatusPress?: () => void;
  leadingImage?: string | null; // photo URL shown instead of the icon
  onLeadingPress?: () => void; // makes the leading tile tappable (photo viewer)
  leadingSize?: number; // explicit leading tile size; defaults to LEADING_SIZE (44)
  /**
   * Flush mode: the leading tile becomes a square that fills the full row
   * height and bleeds to the row's left edge (photo edge-to-edge, clipped by
   * the row's rounded corners). Row padding moves to the text side so the
   * title alignment is unchanged.
   */
  leadingFill?: boolean;
}

/** Default leading tile size in normal (non-fill) mode. */
const LEADING_SIZE = 44;
/** Row height in fill mode = tile size + the tiny inset padding around it. */
const FILL_TILE_SIZE = 68;

export default function ListRow({
  iconType,
  iconLabel,
  title,
  subtitle,
  badge,
  meta,
  chevron,
  onPress,
  onLongPress,
  onMenuPress,
  status,
  onStatusPress,
  leadingImage,
  onLeadingPress,
  leadingSize,
  leadingFill = false,
}: ListRowProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    if (!onPress) return;
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      useNativeDriver: true,
      tension: 200,
      friction: 6,
    }).start();
  }, [onPress, scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 200,
      friction: 6,
    }).start();
  }, [scaleAnim]);

  return (
    <Animated.View
      style={[
        styles.row,
        leadingFill && styles.rowFill,
        { transform: [{ scale: scaleAnim }] },
      ]}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={leadingFill ? styles.rowInnerFill : styles.rowInner}>
        <LeadingIcon
          type={iconType}
          label={iconLabel}
          image={leadingImage}
          onPress={onLeadingPress}
          size={leadingFill ? FILL_TILE_SIZE : leadingSize ?? LEADING_SIZE}
          flush={leadingFill}
        />
        <View style={leadingFill ? styles.textWrapFill : styles.textWrap}>
          {/* numberOfLines=1 + tail truncation; deliberately NOT selectable —
              selectable breaks single-line truncation on Android and wraps the
              ellipsis onto its own line. */}
          <Text style={font.headline} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
          {subtitle ? (
            <Text style={[font.caption, styles.subtitle]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          {badge ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        {status ? (
          <StatusPill status={status} onPress={onStatusPress} />
        ) : null}
        {onMenuPress && !status ? (
          <TouchableOpacity onPress={onMenuPress} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
        {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} /> : null}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    marginBottom: spacing.md,
    overflow: 'hidden',
    ...shadow.card,
  },
  // Fill mode rows sit in tighter lists — the container's gap does the work.
  rowFill: {
    marginBottom: spacing.xs,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderCurve: 'continuous',
  },
  // Fill mode: the leading tile floats inside the row with a tiny gap on the
  // left/top/bottom (spacing.xs) instead of bleeding to the edge, and is
  // evenly rounded on all corners. paddingRight separates the text.
  rowInnerFill: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.xs,
    paddingRight: spacing.md,
    borderCurve: 'continuous',
  },
  textWrap: { flex: 1, marginLeft: spacing.md },
  // Fill mode: title sits a touch higher (4px top vs 8px bottom) so the name
  // optically centers against the tile while the subtitle breathes below.
  textWrapFill: {
    flex: 1,
    marginLeft: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  subtitle: { marginTop: 2 },
  meta: { fontSize: 12, color: colors.textTertiary, marginLeft: spacing.sm },
  menuBtn: { padding: spacing.xs, marginLeft: spacing.sm },
  badge: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.3,
  },
});
