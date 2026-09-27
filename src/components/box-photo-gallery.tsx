// components/box-photo-gallery.tsx
// Full-screen swipeable gallery for a box's photos. Tapping the box's photo
// icon opens this viewer; the top-left back button closes it, and the bottom
// bar offers per-photo actions: Delete, Replace, Share, and Add (up to the
// 3-photo limit). Shared by the Home screen and the Room screen box lists so
// tapping a box's photo icon always opens the same experience.

import { useEffect, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Directory, File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { spacing, radius, fonts } from '../../packly-ui/theme';
import ConfirmModal from '@/components/confirm-modal';
import PhotoSourceSheet from '@/components/photo-source-sheet';
import { useAuthStore } from '@/store/auth-store';
import { useUpgrade } from '@/hooks/use-upgrade';
import {
  MAX_PHOTOS_PER_BOX,
  pickImage,
  uploadPhoto,
  replacePhoto,
  deletePhoto,
  type PhotoWithUrl,
  type PhotoSource,
} from '@/services/photos';
import { toFriendlyError } from '@/lib/errors';

interface BoxPhotoGalleryProps {
  boxId: string | null; // null → hidden
  photos: PhotoWithUrl[]; // photos of the open box (parent keeps them fresh)
  onClose: () => void;
  onPhotosChanged: (boxId: string) => void; // after add/replace/delete → parent refetches
}

export default function BoxPhotoGallery({
  boxId,
  photos,
  onClose,
  onPhotosChanged,
}: BoxPhotoGalleryProps) {
  const user = useAuthStore((s) => s.user);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // Free-plan users can view/share/delete existing photos; Add and Replace
  // are Pro actions (enforced for real by the DB trigger — this is the UX).
  const { isPro, rcEnabled } = useUpgrade();
  const locked = rcEnabled && !isPro;

  const [index, setIndex] = useState(0);
  const [showSourceSheet, setShowSourceSheet] = useState(false);
  const [pendingReplace, setPendingReplace] = useState<PhotoWithUrl | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PhotoWithUrl | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastBoxId, setLastBoxId] = useState<string | null>(boxId);

  const atLimit = photos.length >= MAX_PHOTOS_PER_BOX;

  // Reset per-box state when a different box opens (state adjustment during
  // render, so it doesn't trigger an extra effect pass).
  if (boxId !== lastBoxId) {
    setLastBoxId(boxId);
    setIndex(0);
    setActionError(null);
    setNotice(null);
    setPendingReplace(null);
    setConfirmDelete(null);
  }

  // Display-safe index: photos may shrink after a delete while the scroll
  // position hasn't caught up yet.
  const effectiveIndex = photos.length === 0 ? 0 : Math.min(index, photos.length - 1);

  // Close the gallery when the last photo is removed.
  useEffect(() => {
    if (boxId && photos.length === 0 && !busy) {
      onClose();
    }
  }, [boxId, photos.length, busy, onClose]);

  const openReplace = (photo: PhotoWithUrl) => {
    if (busy || locked) return;
    setPendingReplace(photo);
    setActionError(null);
    setNotice(null);
    setShowSourceSheet(true);
  };

  const openAdd = () => {
    if (busy || atLimit || locked) return;
    setPendingReplace(null);
    setActionError(null);
    setNotice(null);
    setShowSourceSheet(true);
  };

  const handleSourceChosen = async (source: PhotoSource) => {
    setShowSourceSheet(false);
    if (!user || busy || locked) return;

    const replaceTarget = pendingReplace;
    setPendingReplace(null);
    setActionError(null);

    if (!boxId) return;

    let asset;
    try {
      asset = await pickImage(source);
    } catch (err) {
      setActionError(toFriendlyError(err, 'Unable to open the photo picker.'));
      return;
    }
    if (!asset) return; // user cancelled

    setBusy(true);
    try {
      if (replaceTarget) {
        await replacePhoto(boxId, replaceTarget.photo, asset, user.id);
      } else {
        await uploadPhoto(boxId, asset, user.id);
      }
      onPhotosChanged(boxId);
    } catch (err) {
      setActionError(toFriendlyError(err, 'Failed to save the photo.'));
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    setActionError(null);
    try {
      const targetBoxId = confirmDelete.photo.box_id;
      await deletePhoto(confirmDelete.photo);
      setConfirmDelete(null);
      onPhotosChanged(targetBoxId);
    } catch (err) {
      setActionError(toFriendlyError(err, 'Failed to delete the photo.'));
    } finally {
      setBusy(false);
    }
  };

  // Share the image FILE itself — never the Supabase signed URL, which would
  // expose the project endpoint and a bearer token.
  //   native → download to cache, share via expo-sharing (file-only)
  //   web    → Web Share API with the image File; fallback to downloading it
  const shareCurrent = async () => {
    if (!current || busy) return;
    setActionError(null);
    try {
      if (Platform.OS === 'web') {
        await sharePhotoOnWeb(current.url);
      } else {
        await sharePhotoFile(current.url);
      }
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
      if (name === 'AbortError') return; // user dismissed the share sheet
      setActionError(toFriendlyError(err, 'Unable to share the photo.'));
    }
  };

  /** Native: download the image to a temp file and share that file. */
  const sharePhotoFile = async (url: string) => {
    const cacheDir = new Directory(Paths.cache);
    const tmp = new ExpoFile(cacheDir, `box-photo-${Date.now()}.jpg`);
    try {
      await ExpoFile.downloadFileAsync(url, tmp);
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing is not available on this device.');
      }
      await Sharing.shareAsync(tmp.uri, {
        mimeType: 'image/jpeg',
        dialogTitle: 'Share photo',
      });
    } finally {
      // The share sheet is done (or failed) — remove the temp file.
      try {
        if (tmp.exists) tmp.delete();
      } catch {
        // best-effort cleanup
      }
    }
  };

  /** Web: share the image as a file; if unsupported, download the image. */
  const sharePhotoOnWeb = async (url: string) => {
    const blob = await fetch(url).then((res) => {
      if (!res.ok) throw new Error('Unable to download the photo.');
      return res.blob();
    });
    const file = new window.File([blob], 'box-photo.jpg', { type: blob.type || 'image/jpeg' });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
    };
    if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: 'Box photo' });
    } else {
      // Fallback: download the actual image — never expose the storage link.
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'box-photo.jpg';
      anchor.click();
      URL.revokeObjectURL(objectUrl);
      setNotice('Photo downloaded');
    }
  };

  const current = photos[effectiveIndex];

  // Neat framed card the photo sits inside — sized to fit between the top
  // bar and the bottom action bar on any screen.
  const cardSize = Math.min(screenWidth - spacing.xl * 2, screenHeight * 0.58);

  return (
    <Modal visible={boxId !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        {boxId && photos.length > 0 ? (
          <>
            <View style={[styles.topBar, { paddingTop: insets.top + spacing.lg }]}>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                style={({ pressed }) => [styles.roundBtn, pressed && { opacity: 0.7 }]}>
                <Ionicons name="chevron-back" size={20} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.counter}>
                {effectiveIndex + 1} / {photos.length}
              </Text>
              <View style={styles.topBarSpacer} />
            </View>

            {/* Normal flow: the pager flexes between the top bar and the
                bottom actions, so the framed card is always centered in the
                actual visible space — and the dots (also in flow) can never
                be covered by the hint/notice boxes. */}
            <ScrollView
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onScroll={(e) => {
                const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(screenWidth, 1));
                setIndex(Math.max(0, Math.min(photos.length - 1, i)));
              }}
              scrollEventThrottle={16}
              style={styles.pager}>
              {photos.map((item) => (
                <View key={item.photo.id} style={[styles.page, { width: screenWidth }]}>
                  <View style={[styles.photoCard, { width: cardSize, height: cardSize }]}>
                    <Image source={{ uri: item.url }} style={styles.image} resizeMode="contain" />
                  </View>
                </View>
              ))}
            </ScrollView>

            {photos.length > 1 ? (
              <View style={styles.dots}>
                {photos.map((item, i) => (
                  <View key={item.photo.id} style={[styles.dot, i === effectiveIndex && styles.dotActive]} />
                ))}
              </View>
            ) : null}

            <View style={[styles.actions, { paddingBottom: insets.bottom + spacing.xxl }]}>
              {actionError ? (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle-outline" size={16} color="#FFB4B4" />
                  <Text style={styles.errorText}>{actionError}</Text>
                </View>
              ) : null}
              {notice ? (
                <View style={styles.noticeBox}>
                  <Ionicons name="checkmark-circle-outline" size={16} color="#B9F6CA" />
                  <Text style={styles.noticeText}>{notice}</Text>
                </View>
              ) : null}
              {locked && rcEnabled ? (
                <View style={styles.proHintBox}>
                  <Ionicons name="diamond-outline" size={16} color="#FCD34D" />
                  <Text style={styles.proHintText}>
                    Adding and replacing photos is a Pro feature — upgrade from
                    any box screen.
                  </Text>
                </View>
              ) : null}

              <View style={styles.actionBar}>
                <Pressable
                  onPress={() => current && setConfirmDelete(current)}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.actionItem,
                    (pressed || busy) && { opacity: 0.6 },
                  ]}>
                  <View style={[styles.actionIconSquare, { backgroundColor: 'rgba(239,68,68,0.22)' }]}>
                    <Ionicons name="trash-outline" size={22} color="#FF8A8A" />
                  </View>
                  <Text style={styles.actionLabel}>Delete</Text>
                </Pressable>

                <Pressable
                  onPress={() => current && openReplace(current)}
                  disabled={busy || locked}
                  style={({ pressed }) => [
                    styles.actionItem,
                    (pressed || busy) && { opacity: 0.6 },
                  ]}>
                  <View style={[styles.actionIconSquare, { backgroundColor: 'rgba(59,130,246,0.22)' }]}>
                    <Ionicons name="refresh" size={22} color="#93C5FD" />
                  </View>
                  <Text style={styles.actionLabel}>Replace</Text>
                </Pressable>

                <Pressable
                  onPress={shareCurrent}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.actionItem,
                    (pressed || busy) && { opacity: 0.6 },
                  ]}>
                  <View style={[styles.actionIconSquare, { backgroundColor: 'rgba(34,197,94,0.22)' }]}>
                    <Ionicons name="share-outline" size={22} color="#86EFAC" />
                  </View>
                  <Text style={styles.actionLabel}>Share</Text>
                </Pressable>

                <Pressable
                  onPress={openAdd}
                  disabled={busy || atLimit || locked}
                  style={({ pressed }) => [
                    styles.actionItem,
                    (pressed || busy || atLimit) && { opacity: 0.45 },
                  ]}>
                  <View style={[styles.actionIconSquare, { backgroundColor: 'rgba(245,158,11,0.22)' }]}>
                    <Ionicons name="add" size={24} color="#FCD34D" />
                  </View>
                  <Text style={styles.actionLabel}>{atLimit || locked ? 'Pro' : 'Add'}</Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : null}
      </View>

      {/* ── Add / Replace source sheet ── */}
      <PhotoSourceSheet
        visible={showSourceSheet}
        title={pendingReplace ? 'Replace Photo' : 'Add a Photo'}
        busy={busy}
        onChoose={handleSourceChosen}
        onCancel={() => {
          setShowSourceSheet(false);
          setPendingReplace(null);
        }}
      />

      {/* ── Delete confirmation ── */}
      <ConfirmModal
        visible={!!confirmDelete}
        title="Delete Photo?"
        message="This photo will be permanently removed from this box."
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        isLoading={busy}
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
  },
  pager: {
    flex: 1,
  },
  page: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoCard: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  topBar: {
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  topBarSpacer: {
    width: 40,
    height: 40,
  },
  counter: {
    color: '#FFFFFF',
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  dotActive: {
    backgroundColor: '#FFFFFF',
  },
  actions: {
    paddingTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.45)',
    gap: spacing.md,
    alignItems: 'center',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,80,80,0.18)',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  errorText: {
    color: '#FFB4B4',
    fontFamily: fonts.regular,
    fontSize: 13,
    flex: 1,
  },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(34,197,94,0.18)',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  noticeText: {
    color: '#B9F6CA',
    fontFamily: fonts.regular,
    fontSize: 13,
    flex: 1,
  },
  proHintBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(245,158,11,0.18)',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  proHintText: {
    color: '#FDE68A',
    fontFamily: fonts.regular,
    fontSize: 13,
    flex: 1,
  },
  // One smooth rectangular container holding the four square action buttons.
  actionBar: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: 420,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: radius.xl,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  actionItem: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  // Smooth square (not circle) icon button.
  actionIconSquare: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
});
