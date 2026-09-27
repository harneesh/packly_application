// components/LeadingIcon.tsx
// The small colored square shown on the left of every list row. This is
// the "logo" you asked for: moves, rooms, boxes, and items each get their
// own icon + tint so the list reads at a glance instead of everything
// looking like flat text.

import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, fonts } from '../theme';

export type IconType = 'move' | 'room' | 'box' | 'item' | 'person';

interface LeadingIconProps {
  type: IconType;
  label?: string; // e.g. a box number ("1") shown instead of the icon
  size?: number;
  image?: string | null; // remote photo URL — renders the photo instead of the icon
  onPress?: () => void; // makes the tile tappable (e.g. open the photo viewer)
  flush?: boolean; // tile style used by list rows in fill mode — floats inside the row with a tiny gap, evenly rounded on all corners
}

const ICON_MAP: Record<IconType, keyof typeof Ionicons.glyphMap> = {
  move: 'home',
  room: 'grid-outline',
  box: 'cube',
  item: 'pricetag',
  person: 'person',
};

const COLOR_MAP: Record<IconType, { fg: string; bg: string }> = {
  move: { fg: colors.move, bg: colors.moveSoft },
  room: { fg: colors.room, bg: colors.roomSoft },
  box: { fg: colors.box, bg: colors.boxSoft },
  item: { fg: colors.item, bg: colors.itemSoft },
  person: { fg: colors.owner, bg: colors.ownerSoft },
};

export default function LeadingIcon({ type, label, size = 44, image, onPress, flush }: LeadingIconProps) {
  const { fg, bg } = COLOR_MAP[type];
  const tile = (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          backgroundColor: bg,
          // Flush tiles float inside the row with a tiny gap (ListRow's
          // rowInnerFill padding), so all four corners are rounded. radius.lg
          // is the concentric radius for the row card's radius.xl minus that gap.
          borderRadius: flush ? radius.lg : radius.md,
          borderCurve: 'continuous',
        },
      ]}
    >
      {image ? (
        <Image source={{ uri: image }} style={styles.image} resizeMode="cover" />
      ) : label ? (
        <Text style={[styles.label, { color: fg }]}>{label}</Text>
      ) : (
        <Ionicons name={ICON_MAP[type]} size={size * 0.5} color={fg} />
      )}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="View box photos">
        {tile}
      </Pressable>
    );
  }
  return tile;
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  label: { fontSize: 16, fontFamily: fonts.bold, fontWeight: '700' },
  image: {
    width: '100%',
    height: '100%',
  },
});
