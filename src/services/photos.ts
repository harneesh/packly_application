// services/photos.ts
// Photo system for boxes.
//
// Lifecycle (each step below is handled here, never duplicated in the UI):
//   pick     → choose from library or camera (expo-image-picker)
//   compress → JPEG with an adaptive quality/dimension loop until the file is
//              ≤ 300 KB (expo-image-manipulator + expo-file-system size check)
//   upload   → private 'box-photos' bucket at {box_id}/{uuid}.jpg
//   record   → insert the box_photos row; if the insert fails, the uploaded
//              file is rolled back (no orphaned files or records)
//   read     → short-lived signed URLs (bucket is private)
//   delete   → file first, then DB row. The Storage API requires the object to
//              pass the storage.objects SELECT policy; the policy is
//              folder-based (see migration 010), but removing the file while
//              the row still exists also keeps deletes working against the old
//              record-driven policy. If the file removal fails, the row is
//              kept so the user can retry — no orphaned files.
//   replace  → upload new file; remove the old file FIRST (while its row still
//              exists so the record-driven storage SELECT policy passes); swap
//              rows. No file is ever left orphaned in the bucket.
//
// Security: storage + DB RLS both enforce the move-membership model (the same
// joins used by boxes/items), so files are only reachable through box_photos
// records the current user may access.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/services/supabase';
import type { BoxPhoto } from '@/types/database';

export const MAX_PHOTOS_PER_BOX = 3;
export const PHOTO_BUCKET = 'box-photos';

/** Target size after compression — the actual stored file must be ≤ this. */
const MAX_BYTES = 300 * 1024;

/** Signed URL TTL — 24 hours. The bucket is private and URLs are not guessable,
 *  so a long TTL is safe. This avoids regenerating URLs on every navigation. */
const SIGNED_URL_TTL = 86400;

/**
 * In-memory cache for signed URLs, keyed by storage_path.
 * Entries expire after SIGNED_URL_TTL seconds. This avoids hitting
 * createSignedUrls() on every screen navigation — the #1 latency source.
 */
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();

function getCachedUrl(storagePath: string): string | null {
  const entry = signedUrlCache.get(storagePath);
  if (entry && Date.now() < entry.expiresAt) return entry.url;
  signedUrlCache.delete(storagePath);
  return null;
}

function setCachedUrl(storagePath: string, url: string): void {
  signedUrlCache.set(storagePath, {
    url,
    expiresAt: Date.now() + SIGNED_URL_TTL * 1000,
  });
}

/** Cache a signed URL externally (e.g., after a fresh upload). */
export function cacheSignedUrl(storagePath: string, url: string): void {
  setCachedUrl(storagePath, url);
}

export interface PhotoWithUrl {
  photo: BoxPhoto;
  url: string;
}

export type PhotoSource = 'library' | 'camera';

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeObjectPath(boxId: string): string {
  // {box_id}/{timestamp}-{random}.jpg — the top folder drives storage RLS.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${boxId}/${Date.now()}-${rand}.jpg`;
}

/** Size of a local file. Web has no native file API, so read it as a Blob. */
async function getFileSize(uri: string): Promise<number> {
  if (Platform.OS === 'web') {
    const blob = await fetch(uri).then((res) => res.blob());
    return blob.size;
  }
  const file = new File(uri);
  return file.exists ? file.size : 0;
}

/** Remove a temp file on native. Web URIs (data:/blob:) need no cleanup. */
function deleteTempFile(uri: string): void {
  if (Platform.OS === 'web') return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best-effort cleanup — never block the user on a failed delete.
  }
}

/**
 * Compress a local image to ≤ 300 KB as JPEG while preserving aspect ratio.
 *
 * JPEG was chosen (verified against Expo SDK 57 docs): it is the only format
 * supported across iOS/Android/Web with a controllable quality knob, whereas
 * WebP encoding quality varies by platform and PNG is lossless (too large).
 *
 * Strategy: try progressively smaller dimensions + lower quality until the
 * file fits. First pass never upscales (width clamped to the source width).
 */
async function compressToMaxBytes(sourceUri: string, sourceWidth: number): Promise<string> {
  const attempts = [
    { width: 1280, quality: 0.6 },
    { width: 800, quality: 0.4 },
  ];

  let lastUri = sourceUri;
  for (const attempt of attempts) {
    const targetWidth = Math.min(attempt.width, sourceWidth || attempt.width);
    const result = await manipulateAsync(
      sourceUri,
      [{ resize: { width: targetWidth } }],
      { compress: attempt.quality, format: SaveFormat.JPEG },
    );
    lastUri = result.uri;

    const size = await getFileSize(result.uri);
    if (size > 0 && size <= MAX_BYTES) {
      return result.uri;
    }
  }

  // Even the smallest attempt is still over the limit — never upload an
  // oversized file. Clean up the temp result and surface a friendly error.
  deleteTempFile(lastUri);
  throw new Error('This photo is too large to compress. Please choose a smaller image.');
}

/**
 * Turn a local file URI into a body the installed storage-js accepts.
 *
 * NOTE: @supabase/storage-js 2.110+ dropped the legacy React Native
 * `{ uri, type, name }` file object. Passing one now sends the object itself
 * as the request body (JSON-stringified), so uploads "succeed" but store
 * garbage bytes that no image viewer can render. Send a real body instead:
 *   - web    → Blob (uploaded as multipart form data)
 *   - native → ArrayBuffer (sent as raw bytes + the content-type header)
 */
async function toUploadBody(localUri: string): Promise<Blob | ArrayBuffer> {
  if (Platform.OS === 'web') {
    const res = await fetch(localUri);
    return res.blob();
  }
  const bytes = await new File(localUri).bytes();
  // bytes() returns a Uint8Array view; hand the storage layer a clean ArrayBuffer.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function uploadFileToStorage(boxId: string, localUri: string): Promise<string> {
  const path = makeObjectPath(boxId);
  const body = await toUploadBody(localUri);
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, body, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return path;
}

// ──────────────────────────────────────────
// Pick
// ──────────────────────────────────────────

/**
 * Open the image picker for the requested source. Returns null when the user
 * cancels. Throws a friendly error when permission is denied.
 */
export async function pickImage(source: PhotoSource): Promise<ImagePicker.ImagePickerAsset | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error(
        'Camera access is required to take a photo of your box. Please enable it in your device settings and try again.',
      );
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
      allowsEditing: false,
    });
    return result.canceled ? null : result.assets[0];
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      'Photo library access is required to add photos. Please enable it in your device settings and try again.',
    );
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
  });
  return result.canceled ? null : result.assets[0];
}

// ──────────────────────────────────────────
// Add
// ──────────────────────────────────────────

/**
 * Compress + upload + record a picked photo for a box.
 * - If the DB insert fails, the uploaded file is removed (no orphan).
 * - The DB trigger enforces the hard max of 3 per box and rejects with
 *   MAX_PHOTOS_PER_BOX if exceeded.
 */
export async function uploadPhoto(
  boxId: string,
  asset: ImagePicker.ImagePickerAsset,
  userId: string,
): Promise<BoxPhoto> {
  const t0 = performance.now();
  const compressedUri = await compressToMaxBytes(asset.uri, asset.width);
  const t1 = performance.now();

  const path = await uploadFileToStorage(boxId, compressedUri);
  const t2 = performance.now();

  try {
    // sort_order is assigned by the DB trigger while the box row is locked,
    // so it is always deterministic even under concurrent inserts.
    const { data, error } = await supabase
      .from('box_photos')
      .insert({
        box_id: boxId,
        storage_path: path,
        created_by: userId,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    const t3 = performance.now();
    if (__DEV__) {
      console.log(`[photos] uploadPhoto: compress=${(t1 - t0).toFixed(0)}ms upload=${(t2 - t1).toFixed(0)}ms db=${(t3 - t2).toFixed(0)}ms total=${(t3 - t0).toFixed(0)}ms`);
    }
    return data;
  } catch (err) {
    // Roll back the uploaded file so a failed insert never orphans storage.
    const { error: cleanupError } = await supabase.storage.from(PHOTO_BUCKET).remove([path]);
    if (cleanupError) {
      // Never swallow this: a silent cleanup failure orphans the file in
      // Storage forever (e.g. storage RLS denying the DELETE). The file is
      // unreferenced — no box_photos row exists — so log it loudly and tell
      // the user, instead of pretending the failure was clean.
      console.error('[photos] uploadPhoto: failed to roll back uploaded file:', cleanupError.message);
      if (err instanceof Error && err.message.includes('PHOTOS_REQUIRE_PRO')) {
        throw new Error('PHOTOS_REQUIRE_PRO_WITH_ORPHAN');
      }
    }
    throw err;
  }
}

// ──────────────────────────────────────────
// Read
// ──────────────────────────────────────────

/**
 * Attach fresh signed URLs (bucket is private) to photo records.
 *
 * Also prunes "dead" rows: records whose storage file no longer exists (the
 * signing API returns no URL for them). Such rows are invisible in the UI
 * anyway, but keeping them inflates the server-side max-3-photos count — so
 * a box could show room in the UI while the DB trigger rejects every new
 * upload. Deleting the dead rows keeps the count in sync with what the user
 * actually sees. Only per-item failures are pruned; if the whole signing call
 * fails (network etc.) nothing is deleted.
 */
async function attachSignedUrls(photos: BoxPhoto[]): Promise<PhotoWithUrl[]> {
  if (photos.length === 0) return [];

  // Split: cached vs need-signing
  const cached: PhotoWithUrl[] = [];
  const needSigning: BoxPhoto[] = [];
  for (const p of photos) {
    const cachedUrl = getCachedUrl(p.storage_path);
    if (cachedUrl) {
      cached.push({ photo: p, url: cachedUrl });
    } else {
      needSigning.push(p);
    }
  }

  if (needSigning.length === 0) {
    // All cached — zero network calls
    if (__DEV__) {
      console.log(`[photos] attachSignedUrls: ${photos.length} photos, ALL CACHED (0ms)`);
    }
    return cached;
  }

  const t0 = performance.now();
  const { data: signed, error: signedError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(
      needSigning.map((p) => p.storage_path),
      SIGNED_URL_TTL,
    );
  const t1 = performance.now();

  if (signedError) throw new Error(signedError.message);

  const urlByPath = new Map<string, string>();
  const deadPaths = new Set<string>();
  for (const item of signed ?? []) {
    if (item.signedUrl && item.path) {
      urlByPath.set(item.path, item.signedUrl);
      setCachedUrl(item.path, item.signedUrl);
    } else if (item.path) {
      deadPaths.add(item.path);
    }
  }

  const dead = needSigning.filter((p) => deadPaths.has(p.storage_path));
  if (dead.length > 0) {
    try {
      await supabase.from('box_photos').delete().in('id', dead.map((p) => p.id));
    } catch {
      // ignore — retried on the next fetch
    }
  }

  const signedPhotos = needSigning
    .filter((p) => urlByPath.has(p.storage_path))
    .map((p) => ({ photo: p, url: urlByPath.get(p.storage_path)! }));

  const result = [...cached, ...signedPhotos];
  if (__DEV__) {
    console.log(`[photos] attachSignedUrls: ${photos.length} photos (${cached.length} cached, ${needSigning.length} signed in ${(t1 - t0).toFixed(0)}ms)`);
  }
  return result;
}

/**
 * Resolve storage paths to short-lived signed URLs, reusing the same in-memory
 * cache as the galleries (so repeat searches cost zero network calls).
 *
 * Used by search results: the search RPC can only return photo *storage
 * paths* because the bucket is private — a path is never a usable URL.
 * Missing/dead paths are simply absent from the result (no pruning here).
 */
export async function signPhotoPaths(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => !!p))];
  if (unique.length === 0) return {};

  const urlByPath: Record<string, string> = {};
  const needSigning: string[] = [];
  for (const path of unique) {
    const cached = getCachedUrl(path);
    if (cached) urlByPath[path] = cached;
    else needSigning.push(path);
  }

  if (needSigning.length > 0) {
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(needSigning, SIGNED_URL_TTL);
    if (error) throw new Error(error.message);

    for (const item of data ?? []) {
      if (item.signedUrl && item.path) {
        urlByPath[item.path] = item.signedUrl;
        setCachedUrl(item.path, item.signedUrl);
      }
    }
  }

  return urlByPath;
}

/** Fetch photo records for a box and attach fresh signed URLs. */
export async function fetchPhotos(boxId: string): Promise<PhotoWithUrl[]> {
  const t0 = performance.now();
  const { data, error } = await supabase
    .from('box_photos')
    .select('*')
    .eq('box_id', boxId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  const result = await attachSignedUrls(data ?? []);
  if (__DEV__) {
    console.log(`[photos] fetchPhotos: box=${boxId.slice(0, 8)} photos=${(data ?? []).length} total=${(performance.now() - t0).toFixed(0)}ms`);
  }
  return result;
}

/**
 * Fetch photos for several boxes at once (room-screen thumbnails).
 * Returns an ordered { boxId → photos } map; boxes without photos are absent.
 */
export async function fetchBoxPhotosByBox(
  boxIds: string[],
): Promise<Record<string, PhotoWithUrl[]>> {
  if (boxIds.length === 0) return {};

  const t0 = performance.now();
  const { data, error } = await supabase
    .from('box_photos')
    .select('*')
    .in('box_id', boxIds)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    if (__DEV__) {
      console.log(`[photos] fetchBoxPhotosByBox: ${boxIds.length} boxes, 0 photos, total=${(performance.now() - t0).toFixed(0)}ms`);
    }
    return {};
  }

  const withUrls = await attachSignedUrls(data);
  const t1 = performance.now();

  const byBox: Record<string, PhotoWithUrl[]> = {};
  for (const item of withUrls) {
    (byBox[item.photo.box_id] ??= []).push(item);
  }
  if (__DEV__) {
    console.log(`[photos] fetchBoxPhotosByBox: ${boxIds.length} boxes, ${data.length} photos, total=${(t1 - t0).toFixed(0)}ms`);
  }
  return byBox;
}

// ──────────────────────────────────────────
// Bulk Storage Cleanup (pre-delete)
// ──────────────────────────────────────────

/**
 * Remove all storage files for the given box IDs.
 * Must be called BEFORE the DB cascade deletes the box rows, because
 * the storage DELETE RLS policy requires the box to exist.
 *
 * This is intentionally best-effort: if the storage removal fails, the
 * DB cascade still runs (leaving orphaned files), but the alternative
 * (skipping the delete) is worse.
 */
export async function deleteStorageForBoxIds(boxIds: string[]): Promise<void> {
  if (boxIds.length === 0) return;

  // Fetch all storage paths for these boxes
  const { data: photos, error: queryError } = await supabase
    .from('box_photos')
    .select('storage_path')
    .in('box_id', boxIds);

  if (queryError || !photos || photos.length === 0) return;

  const paths = photos.map((p) => p.storage_path);

  // Supabase Storage remove() accepts up to 1000 objects per call
  const BATCH_SIZE = 1000;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    await supabase.storage.from(PHOTO_BUCKET).remove(batch).catch(() => {});
  }

  // Also clear the in-memory signed URL cache for these paths
  for (const path of paths) {
    signedUrlCache.delete(path);
  }
}

// ──────────────────────────────────────────
// Delete
// ──────────────────────────────────────────

/**
 * Remove a photo: the storage file first, then the DB row.
 *
 * The Storage API's remove() requires the object to pass the storage.objects
 * SELECT policy. The SELECT policy is record-driven in older installs (it
 * matches a live box_photos row) and folder-based after migration 010 —
 * removing the file while the row still exists satisfies both. If the file
 * removal fails, we keep the row (the photo stays visible) and throw so the
 * UI can surface the error and let the user retry, instead of orphaning the
 * file.
 */
export async function deletePhoto(photo: BoxPhoto): Promise<void> {
  const { error: storageError } = await supabase.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
  if (storageError) throw new Error(storageError.message);

  const { error } = await supabase.from('box_photos').delete().eq('id', photo.id);
  if (error) throw new Error(error.message);
}

// ──────────────────────────────────────────
// Replace (re-upload)
// ──────────────────────────────────────────

/**
 * Replace an existing photo with a newly picked one.
 *
 * The old file is deleted FIRST, while the old row still exists. The Storage
 * API's remove() must pass the storage.objects SELECT policy, which is
 * record-driven until migration 010 is applied (it matches a live box_photos
 * row). Removing the file AFTER the row swap would be denied under that
 * policy and orphan the old file — that is the bug this order fixes. It works
 * under both policy styles (record-driven and migration-010 folder-based):
 *   1. compress + upload the new file        (no DB change yet)
 *   2. remove the old storage file           (old row still exists → passes)
 *   3. delete the old DB row
 *   4. insert the new DB row (keeps the old slot; the max-3 trigger is fine
 *      because step 3 already removed the old row)
 * On any failure the new file is rolled back so nothing is orphaned.
 */
export async function replacePhoto(
  boxId: string,
  oldPhoto: BoxPhoto,
  asset: ImagePicker.ImagePickerAsset,
  userId: string,
): Promise<BoxPhoto> {
  const compressedUri = await compressToMaxBytes(asset.uri, asset.width);
  const newPath = await uploadFileToStorage(boxId, compressedUri);

  // Remove the old file while its row still exists, so the record-driven
  // storage.objects SELECT policy (pre-migration-010) does not block it.
  const { error: oldFileError } = await supabase.storage.from(PHOTO_BUCKET).remove([oldPhoto.storage_path]);
  if (oldFileError) {
    // The old photo stays fully intact; just roll back the new file.
    const { error: rollbackError } = await supabase.storage.from(PHOTO_BUCKET).remove([newPath]);
    if (rollbackError) {
      console.error('[photos] replacePhoto: failed to roll back new file:', rollbackError.message);
    }
    throw new Error(oldFileError.message);
  }

  const { error: deleteError } = await supabase.from('box_photos').delete().eq('id', oldPhoto.id);
  if (deleteError) {
    const { error: rollbackError } = await supabase.storage.from(PHOTO_BUCKET).remove([newPath]);
    if (rollbackError) {
      console.error('[photos] replacePhoto: failed to roll back new file:', rollbackError.message);
    }
    throw new Error(deleteError.message);
  }

  const { data, error } = await supabase
    .from('box_photos')
    .insert({
      box_id: boxId,
      storage_path: newPath,
      sort_order: oldPhoto.sort_order,
      created_by: userId,
    })
    .select()
    .single();

  if (error) {
    // Restore the old row, then remove the new file.
    const { error: restoreError } = await supabase.from('box_photos').insert({
      id: oldPhoto.id,
      box_id: oldPhoto.box_id,
      storage_path: oldPhoto.storage_path,
      sort_order: oldPhoto.sort_order,
      created_by: oldPhoto.created_by,
    });
    if (restoreError) {
      console.error('[photos] failed to restore old row during replace:', restoreError.message);
    }
    const { error: rollbackError } = await supabase.storage.from(PHOTO_BUCKET).remove([newPath]);
    if (rollbackError) {
      console.error('[photos] replacePhoto: failed to roll back new file:', rollbackError.message);
    }
    throw error;
  }

  return data;
}
