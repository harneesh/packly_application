// components/StatusPill.tsx
// Small rounded status pill used on box rows (mockup §1): Packed (green),
// Packing (amber), Empty (gray). Purely presentational — the caller owns the
// state and what happens on tap.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

export type BoxStatus = 'packed' | 'packing' | 'empty';

const META: Record<BoxStatus, { label: string; fg: string; bg: string }> = {
  packed: { label: 'Packed', fg: colors.packed, bg: colors.packedSoft },
  packing: { label: 'Packing', fg: colors.packing, bg: colors.packingSoft },
  empty: { label: 'Empty', fg: colors.empty, bg: colors.emptySoft },
};

interface StatusPillProps {
  status: BoxStatus;
  onPress?: () => void;
  disabled?: boolean;
}

export default function StatusPill({ status, onPress, disabled }: StatusPillProps) {
  const meta = META[status];
  const content = (
    <View style={[styles.pill, { backgroundColor: meta.bg }]}>
      <Text style={[styles.text, { color: meta.fg }]}>{meta.label}</Text>
    </View>
  );

  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Mark box as ${meta.label}`}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(23,26,46,0.06)',
  },
  text: {
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
});
