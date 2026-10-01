// components/LeadingIcon.tsx
// The small colored square shown on the left of every list row. This is
// the "logo" you asked for: moves, rooms, boxes, and items each get their
// own icon + tint so the list reads at a glance instead of everything
// looking like flat text.
//
// 2026 redesign: boxes render as kraft cardboard tiles — tan body, yellow
// lid strip across the top, and the box number printed in kraft brown —
// matching the designer mockup (§1). Other entity types keep a soft-tinted
// rounded square with their icon/label.

import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, fonts } from '../theme';

export type IconType = 'move' | 'room' | 'box' | 'item' | 'person';

interface LeadingIconProps {
  type: IconType;
  label?: string | null; // e.g. a box number ("1") shown instead of the icon
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

  // Labels are box numbers, and "1000" used to render at full size with no
  // insets — it ran into (and past) the tile edges. Shrink the glyph as the
  // label grows so 1–5+ characters always sit comfortably inside the tile.
  const labelText = label ?? '';
  const labelScale =
    labelText.length <= 2 ? 1 : labelText.length === 3 ? 0.82 : labelText.length === 4 ? 0.68 : 0.56;
  const labelFontSize = size * 0.36 * labelScale;
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
        type === 'box' && styles.kraft,
      ]}
    >
      {image ? (
        <Image source={{ uri: image }} style={styles.image} resizeMode="cover" />
      ) : type === 'box' && !image ? (
        // Kraft cardboard tile: tan body, yellow lid strip across the top,
        // box number printed in kraft brown.
        <>
          <View
            style={[
              styles.kraftLid,
              {
                height: size * 0.24,
                borderTopLeftRadius: flush ? radius.lg : radius.md,
                borderTopRightRadius: flush ? radius.lg : radius.md,
              },
            ]}
          />
          {labelText ? (
            <Text
              style={[
                styles.kraftText,
                {
                  fontSize: labelFontSize,
                  lineHeight: Math.round(labelFontSize * 1.15),
                  // Center the number in the tan BODY, not the whole tile: the
                  // lid strip occupies the top quarter, so the text has to sit
                  // lower to look optically centered.
                  marginTop: Math.round(size * 0.22),
                },
              ]}
              numberOfLines={1}
              allowFontScaling={false}>
              {labelText}
            </Text>
          ) : (
            // Custom box labels ("Fragile") have no digits to print — show the
            // box glyph instead of leaving the tile blank.
            <Ionicons
              name={ICON_MAP.box}
              size={size * 0.42}
              color={colors.kraftText}
              style={{ marginTop: Math.round(size * 0.22) }}
            />
          )}
        </>
      ) : labelText ? (
        <Text
          style={[styles.label, { color: fg, fontSize: labelFontSize }]}
          numberOfLines={1}
          allowFontScaling={false}>
          {labelText}
        </Text>
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
  // Text labels keep an inset from the tile edge and can never exceed it.
  label: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    paddingHorizontal: 3,
    maxWidth: '100%',
    textAlign: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  // Kraft tile extras
  kraft: {
    backgroundColor: colors.box,
  },
  kraftLid: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.kraftLid,
  },
  kraftText: {
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    color: colors.kraftText,
    paddingHorizontal: 3,
    maxWidth: '100%',
    textAlign: 'center',
  },
});
