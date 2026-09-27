// components/SectionHeader.tsx
// One shared header for every list/section in the app (Photos, Voice, Items,
// Boxes, Rooms...). A single component guarantees the icon size, icon-text
// gap, title weight, and spacing are identical everywhere — hand-rolled
// per-screen headers drifted apart.
import React from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, fonts } from '../theme';

interface SectionHeaderProps {
  /** Ionicons name shown left of the title (omit for no icon). */
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Small right-aligned meta text, e.g. "2/3" or "Items: 4". */
  meta?: string;
  /** Overrides for the outer row (extra margins/padding per screen). */
  style?: StyleProp<ViewStyle>;
}

export default function SectionHeader({ icon, title, meta, style }: SectionHeaderProps) {
  return (
    <View style={[styles.header, style]}>
      <View style={styles.left}>
        {icon ? <Ionicons name={icon} size={18} color={colors.primary} /> : null}
        <Text style={font.headline}>{title}</Text>
      </View>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
});
