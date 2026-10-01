// components/photo-source-sheet.tsx
// Bottom sheet asking where a photo should come from (camera or library).
// Shared by the Box screen and the Room screen photo gallery so both have an
// identical picker experience.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, radius } from '../../packly-ui/theme';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import type { PhotoSource } from '@/services/photos';

interface PhotoSourceSheetProps {
  visible: boolean;
  title: string; // "Add a Photo" or "Replace Photo"
  busy?: boolean; // disables the options while an upload is in flight
  onChoose: (source: PhotoSource) => void;
  onCancel: () => void;
}

export default function PhotoSourceSheet({
  visible,
  title,
  busy,
  onChoose,
  onCancel,
}: PhotoSourceSheetProps) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onCancel}
      sheetStyle={{
        backgroundColor: colors.surface,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.xs,
        gap: spacing.md,
      }}>
      <BottomSheetDraggableArea style={styles.sheetTitleWrap}>
        <Text style={[font.headline, styles.sheetTitle]}>{title}</Text>
      </BottomSheetDraggableArea>
      <Pressable
        onPress={() => onChoose('camera')}
        disabled={busy}
        style={({ pressed }) => [styles.sheetOption, pressed && { opacity: 0.7 }]}>
        <View style={[styles.sheetOptionIcon, { backgroundColor: colors.primarySoft }]}>
          <Ionicons name="camera" size={20} color={colors.primary} />
        </View>
        <Text style={[font.bodyMedium, { flex: 1 }]}>Take Photo</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </Pressable>
      <Pressable
        onPress={() => onChoose('library')}
        disabled={busy}
        style={({ pressed }) => [styles.sheetOption, pressed && { opacity: 0.7 }]}>
        <View style={[styles.sheetOptionIcon, { backgroundColor: colors.itemSoft }]}>
          <Ionicons name="images" size={20} color={colors.item} />
        </View>
        <Text style={[font.bodyMedium, { flex: 1 }]}>Choose from Library</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      </Pressable>
      <Pressable
        onPress={onCancel}
        disabled={busy}
        style={({ pressed }) => [styles.sheetCancel, pressed && { opacity: 0.7 }]}>
        <Text style={[font.headline, { color: colors.primary }]}>Cancel</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetTitleWrap: {
    marginHorizontal: -spacing.xl, // stretch the drag surface over the full sheet width
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetTitle: {
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderCurve: 'continuous',
  },
  sheetOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  // Ghost pill — matches the Cancel buttons on every other sheet/modal.
  sheetCancel: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
});
