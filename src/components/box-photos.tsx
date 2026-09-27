// components/box-photos.tsx
// Photo section for the Box Details screen.
//
// Shows up to MAX_PHOTOS_PER_BOX (3) photos in a grid. Tapping a photo opens
// the SHARED full-screen gallery (box-photo-gallery.tsx) — the same gallery
// that opens from the Home and Room box lists, with the same swipe viewer,
// framed card, and Delete / Replace / Share / Add actions.
//
// The "+" tile opens a small source sheet (Take Photo / Choose from Library)
// with optimistic upload UI (tile appears immediately, Retry overlay on
// failure). Rapid-tap protection: while an upload is in flight every photo
// action is disabled, so double-taps can never start a second upload.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing, font, radius, shadow, fonts } from '../../packly-ui/theme';
import SectionHeader from '../../packly-ui/components/SectionHeader';
import PhotoSourceSheet from '@/components/photo-source-sheet';
import BoxPhotoGallery from '@/components/box-photo-gallery';
import { useUpgrade } from '@/hooks/use-upgrade';
import { useAuthStore } from '@/store/auth-store';
import {
  MAX_PHOTOS_PER_BOX,
  fetchPhotos,
  pickImage,
  uploadPhoto,
  cacheSignedUrl,
  type PhotoWithUrl,
  type PhotoSource,
} from '@/services/photos';
import { toFriendlyError } from '@/lib/errors';

interface BoxPhotosProps {
  boxId: string;
  onPhotosChanged?: (boxId: string) => void;
}

/** A photo entry: either a completed photo from the server or a local optimistic entry. */
type PhotoEntry =
  | (PhotoWithUrl & { status?: 'completed' })
  | { entryId: string; url: string; status: 'uploading' | 'failed' };

export default function BoxPhotos({ boxId }: BoxPhotosProps) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { width: screenWidth } = useWindowDimensions();

  // Photo gating: the UI lock is an upsell affordance — the REAL gate is the
  // database trigger (migration 013). Existing photos stay visible for free
  // users (e.g. after a downgrade); only Add/Replace are Pro actions.
  const { isPro, rcEnabled } = useUpgrade();
  const locked = rcEnabled && !isPro;

  const {
    data: photos,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['box-photos', boxId],
    queryFn: () => fetchPhotos(boxId),
    enabled: !!boxId,
    staleTime: 5 * 60 * 1000,
  });

  const [busy, setBusy] = useState(false);
  const [showSourceSheet, setShowSourceSheet] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const photoList: PhotoEntry[] = photos ?? [];
  const count = photoList.length;
  const atLimit = count >= MAX_PHOTOS_PER_BOX;
  const isBusy = busy;

  // Completed photos only — what the shared gallery displays.
  const completedPhotos: PhotoWithUrl[] = photoList.filter(
    (e): e is PhotoWithUrl => 'photo' in e,
  );

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['box-photos', boxId] });
    // Also invalidate Home screen thumbnails so the box icon updates
    queryClient.invalidateQueries({ queryKey: ['room-photos'] });
  }, [queryClient, boxId]);

  const optimisticAdd = useCallback(
    (localUri: string) => {
      const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: PhotoEntry = {
        entryId: tempId,
        url: localUri,
        status: 'uploading',
      };
      queryClient.setQueryData<PhotoEntry[]>(['box-photos', boxId], (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return tempId;
    },
    [queryClient, boxId],
  );

  const commitOptimistic = useCallback(
    (tempId: string, real: PhotoWithUrl) => {
      queryClient.setQueryData<PhotoEntry[]>(['box-photos', boxId], (old) =>
        (old ?? []).map((e) =>
          'entryId' in e && e.entryId === tempId ? { ...real, status: 'completed' as const } : e,
        ),
      );
    },
    [queryClient, boxId],
  );

  const markFailed = useCallback(
    (tempId: string) => {
      // Flip the cached optimistic entry to 'failed' so the tile shows the
      // Retry overlay. (The optimistic entry must never stay 'uploading' —
      // that was the infinite-spinner bug: failure state has to land in the
      // query cache, which is what the tiles actually render from.)
      queryClient.setQueryData<PhotoEntry[]>(['box-photos', boxId], (old) =>
        (old ?? []).map((e) =>
          'entryId' in e && e.entryId === tempId ? { ...e, status: 'failed' as const } : e,
        ),
      );
    },
    [queryClient, boxId],
  );

  const handleSourceChosen = useCallback(
    async (source: PhotoSource) => {
      setShowSourceSheet(false);
      if (!user || isBusy || locked) return;

      setActionError(null);

      let asset;
      try {
        asset = await pickImage(source);
      } catch (err) {
        setActionError(toFriendlyError(err, 'Unable to open the photo picker.'));
        return;
      }
      if (!asset) return;

      // Add: optimistic UI — show photo immediately
      const tempId = optimisticAdd(asset.uri);

      try {
        const result = await uploadPhoto(boxId, asset, user.id);
        // Get a fresh signed URL for the uploaded photo (cache it for later)
        const { supabase } = await import('@/services/supabase');
        const { data: signed } = await supabase.storage
          .from('box-photos')
          .createSignedUrls([result.storage_path], 86400);
        const signedUrl = signed?.[0]?.signedUrl ?? asset.uri;
        if (signedUrl && signedUrl !== asset.uri) {
          cacheSignedUrl(result.storage_path, signedUrl);
        }
        commitOptimistic(tempId, { photo: result, url: signedUrl });
        invalidate();
      } catch (err) {
        markFailed(tempId);
        setActionError(toFriendlyError(err, 'Failed to upload the photo.'));
      }
    },
    [user, boxId, locked, isBusy, queryClient, optimisticAdd, commitOptimistic, markFailed, invalidate],
  );

  const openAddSheet = useCallback(() => {
    if (isBusy || atLimit || locked) return;
    setActionError(null);
    setShowSourceSheet(true);
  }, [isBusy, atLimit, locked]);

  const retryUpload = useCallback(
    (entryId: string) => {
      // Remove the failed entry and re-open the source sheet
      queryClient.setQueryData<PhotoEntry[]>(['box-photos', boxId], (old) =>
        (old ?? []).filter((e) => !('entryId' in e) || e.entryId !== entryId),
      );
      setActionError(null);
      setShowSourceSheet(true);
    },
    [queryClient, boxId],
  );

  // ── Tile geometry: 3 per row, 12px gaps, 20px side padding ──
  // Math.floor is essential: a fractional tile size gets rounded up by RN,
  // pushing the 3rd tile ~1px past the row width so it wraps to its own line.
  const gap = spacing.md;
  const sidePadding = spacing.xl;
  const tileSize = Math.floor((screenWidth - sidePadding * 2 - gap * 2) / 3);

  // Free plan, empty box: hide the whole Photos section instead of showing an
  // upgrade card — photo uploads are a Pro feature, so there is nothing to
  // render here. Boxes that already have photos (e.g. taken on Pro before a
  // downgrade) skip this branch and keep displaying them below.
  // NOTE: this early return lives AFTER every hook in the component so the
  // hook order stays stable when count transitions 0 → 1 mid-session.
  if (locked && count === 0 && !error) {
    return null;
  }

  return (
    <View style={styles.section}>
      <SectionHeader
        icon="images-outline"
        title="Photos"
        meta={`${count}/${MAX_PHOTOS_PER_BOX}`}
      />

      {actionError ? (
        <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
          <Text style={styles.errorText}>{actionError}</Text>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.loadingBox}>
          <Text style={styles.errorText}>Could not load photos.</Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {photoList.map((item) => {
            const isOptimistic = 'entryId' in item;
            const isUploading = isOptimistic && item.status === 'uploading';
            const isFailed = isOptimistic && item.status === 'failed';
            const tileKey = isOptimistic ? item.entryId : item.photo.id;

            return (
              <Pressable
                key={tileKey}
                onPress={() => {
                  if (!isBusy && !isOptimistic) {
                    setGalleryOpen(true);
                    setActionError(null);
                  } else if (isFailed && 'entryId' in item) {
                    // Free users can't retry (the gate would reject it again)
                    // — send them to the upgrade flow instead.
                    if (locked) {
                      return;
                    }
                    retryUpload(item.entryId);
                  }
                }}
                style={({ pressed }) => [
                  styles.tile,
                  { width: tileSize, height: tileSize },
                  pressed && !isBusy && { opacity: 0.85, transform: [{ scale: 0.97 }] },
                ]}>
                <Image source={{ uri: item.url }} style={styles.tileImage} resizeMode="cover" />
                {isUploading && (
                  <View style={styles.tileOverlay}>
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  </View>
                )}
                {isFailed && (
                  <View style={styles.tileOverlay}>
                    <Ionicons name="refresh" size={22} color="#FFFFFF" />
                    <Text style={styles.tileOverlayText}>Retry</Text>
                  </View>
                )}
              </Pressable>
            );
          })}

          {!atLimit && !locked && (
            <Pressable
              onPress={openAddSheet}
              disabled={isBusy}
              style={({ pressed }) => [
                styles.addTile,
                { width: tileSize, height: tileSize },
                pressed && !isBusy && { transform: [{ scale: 0.97 }] },
              ]}>
              {isBusy ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <>
                  <Ionicons name="camera-outline" size={26} color={colors.primary} />
                  <Text style={styles.addTileText}>Add Photo</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      )}

      {!isLoading && !error && count === 0 && !locked && (
        <Text style={styles.emptyHint}>
          Add up to {MAX_PHOTOS_PER_BOX} photos of your packed items so you can
          remember what&apos;s inside this box.
        </Text>
      )}

      {/* ── Shared full-screen gallery (same as Home / Room box lists) ── */}
      <BoxPhotoGallery
        boxId={galleryOpen ? boxId : null}
        photos={completedPhotos}
        onClose={() => setGalleryOpen(false)}
        onPhotosChanged={invalidate}
      />

      {/* ── Source sheet (Take Photo / Choose from Library) ── */}
      <PhotoSourceSheet
        visible={showSourceSheet}
        title="Add a Photo"
        busy={isBusy}
        onChoose={handleSourceChosen}
        onCancel={() => setShowSourceSheet(false)}
      />
    </View>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.xxl,
  },

  loadingBox: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    flex: 1,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  tile: {
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
    ...shadow.card,
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  addTile: {
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  addTileText: {
    fontSize: 12,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.primary,
  },
  emptyHint: {
    marginTop: spacing.md,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textTertiary,
    textAlign: 'center',
  },
  tileOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  tileOverlayText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
});
