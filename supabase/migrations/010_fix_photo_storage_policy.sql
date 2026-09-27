-- Packly Database Migration
-- Version: 010
-- Description: Fix orphaned box-photo files.
--
-- Problem: the Storage API's remove() requires an object to pass BOTH the
-- SELECT and DELETE policies on storage.objects. The old SELECT policy was
-- record-driven (it matched `p.storage_path = storage.objects.name`), so as
-- soon as the box_photos row was deleted the file became invisible to the
-- authenticated user and the later storage.remove() call was denied — the DB
-- row disappeared from the UI but the file was orphaned in the bucket.
-- replacePhoto had the same flaw (it removes the old file after deleting the
-- old row).
--
-- Fix: make the SELECT policy folder-based, matching the INSERT policy's
-- shape. On databases created from the original 009 policy set the DELETE
-- policy is also record-driven, so it is rebuilt folder-based below as well. An object at {box_id}/{file}.jpg is viewable iff the
-- current user belongs to (or owns) the move containing that box. Files can
-- only reach the bucket through membership-gated uploads, so this grants
-- members no access they did not already have — but it no longer depends on a
-- box_photos row existing, so file deletion works in any order.
--
-- This migration is idempotent (safe to re-run).

DROP POLICY IF EXISTS "Members can view box photos" ON storage.objects;
CREATE POLICY "Members can view box photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'box-photos'
    AND (
      EXISTS (
        SELECT 1 FROM public.boxes b
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.move_members mm ON mm.move_id = r.move_id
        WHERE b.id = (storage.foldername(storage.objects.name))[1]::uuid
          AND mm.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.boxes b
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.moves m ON m.id = r.move_id
        WHERE b.id = (storage.foldername(storage.objects.name))[1]::uuid
          AND m.owner_id = auth.uid()
      )
    )
  );

-- The DELETE policy had the same record-driven flaw on databases created
-- from the original 009 policy set (a file without a box_photos row was
-- invisible to remove(), so rollback/replace cleanups were denied). Make it
-- folder-based too, identical in shape to the SELECT policy above.
DROP POLICY IF EXISTS "Members can delete box photos" ON storage.objects;
CREATE POLICY "Members can delete box photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'box-photos'
    AND (
      EXISTS (
        SELECT 1 FROM public.boxes b
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.move_members mm ON mm.move_id = r.move_id
        WHERE b.id = (storage.foldername(storage.objects.name))[1]::uuid
          AND mm.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.boxes b
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.moves m ON m.id = r.move_id
        WHERE b.id = (storage.foldername(storage.objects.name))[1]::uuid
          AND m.owner_id = auth.uid()
      )
    )
  );

-- Reversal (run to undo this migration):
-- DROP POLICY IF EXISTS "Members can view box photos" ON storage.objects;
-- DROP POLICY IF EXISTS "Members can delete box photos" ON storage.objects;
-- (restore the record-driven policies from the original 009 if desired)
