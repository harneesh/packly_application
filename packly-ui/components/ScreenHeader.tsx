// components/ScreenHeader.tsx
// Covers every header style seen in the app: "Back", "Cancel", "Done",
// a centered title (Members), and a right-side accessory (Owner badge).
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../theme';

interface ScreenHeaderProps {
  onBack?: () => void;
  title?: string;
  right?: React.ReactNode;
  large?: boolean; // bigger title for detail screens (e.g. box name)
}

export default function ScreenHeader({ onBack, title, right, large }: ScreenHeaderProps) {
  return (
    <View style={styles.wrap}>
      <View style={styles.side}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} hitSlop={8} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {title ? (
        <Text style={[styles.title, large && styles.titleLarge]} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
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
  side: { flex: 1 },
  rightSide: { alignItems: 'flex-end' },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 2, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  titleLarge: { fontSize: 20 },
});
