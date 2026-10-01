// components/ScreenHeader.tsx
// Covers every header style seen in the app: "Back", "Cancel", "Done",
// a centered title (Members), and a right-side accessory (Owner badge).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fonts } from '../theme';

interface ScreenHeaderProps {
  onBack?: () => void;
  title?: string;
  /** Optional second line under the title (e.g. "Bathroom, 8 items"). */
  subtitle?: string;
  right?: React.ReactNode;
  large?: boolean; // bigger title for detail screens (e.g. box name)
}

export default function ScreenHeader({ onBack, title, subtitle, right, large }: ScreenHeaderProps) {
  return (
    <View style={[styles.wrap, subtitle ? styles.wrapTall : null]}>
      <View style={styles.side}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} hitSlop={8} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {title ? (
        subtitle ? (
          /* Two-line title block (title + subtitle) — used by the Box screen,
             whose header shows the box name and a "Room, N items" line. */
          <View style={styles.titleBlock}>
            <Text
              style={[styles.title, styles.titleInBlock, large && styles.titleLarge]}
              numberOfLines={1}
              ellipsizeMode="tail">
              {title}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="tail">
              {subtitle}
            </Text>
          </View>
        ) : (
          <Text style={[styles.title, large && styles.titleLarge]} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
        )
      ) : (
        <View style={styles.side} />
      )}
      <View style={[styles.side, styles.rightSide]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Uniform top spacing on every screen that uses the header: 8px between
  // the safe-area edge and the header row (matches the search bar's top
  // padding on Home).
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    height: 56,
  },
  // Taller variant while a subtitle adds a second line under the title.
  wrapTall: { height: 68 },
  side: { flex: 1 },
  rightSide: { alignItems: 'flex-end' },
  backBtn: {
    flexDirection: 'row',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 2,
    textAlign: 'center',
    fontSize: 16,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  titleLarge: { fontSize: 20 },
  titleBlock: {
    flex: 2,
    alignItems: 'center',
    gap: 1,
  },
  // Inside the stacked block the title must size to its content instead of
  // growing to fill the column (flex:2 is only for the single-line layout).
  titleInBlock: { flex: 0 },
  subtitle: {
    fontFamily: fonts.medium,
    fontWeight: '500',
    fontSize: 13,
    color: colors.textSecondary,
  },
});
