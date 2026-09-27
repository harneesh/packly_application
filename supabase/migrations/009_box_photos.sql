-- Packly Database Migration
-- Version: 009
-- Description: Photo system for boxes.
--
--   • New table: public.box_photos (photo records linked to a box)
--   • Server-enforced hard limit: max 3 photos per box (race-safe trigger)
--   • RLS on box_photos follows the existing move-membership model
--   • Private storage bucket 'box-photos'; storage RLS also follows the
--     move-membership model (NOT just the uploader's user id folder)
--
-- Object path scheme inside the bucket: {box_id}/{uuid}.jpg
--   The top folder is the box id so storage INSERT policies can validate
--   move membership through the same joins the table RLS uses.
--
-- This migration is idempotent (safe to re-run after a partial/failed run).

-- ============================================
-- 1) Storage bucket (private)
-- ============================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('box-photos', 'box-photos', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- 2) Table: box_photos
-- ============================================
CREATE TABLE IF NOT EXISTS public.box_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id UUID NOT NULL REFERENCES public.boxes(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_box_photos_box_id ON public.box_photos(box_id);
CREATE INDEX IF NOT EXISTS idx_box_photos_created_by ON public.box_photos(created_by);

-- ============================================
-- 3) Hard limit: max 3 photos per box
--    Server-authoritative and race-safe: the parent box row is locked (FOR
--    UPDATE) so concurrent inserts for the same box serialize. A client can
--    never exceed the limit by firing parallel requests.
--    NOTE: Phase 3 will make this limit plan-aware. For now 3 is the hard max.
-- ============================================
CREATE OR REPLACE FUNCTION public.enforce_box_photo_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  photo_count INT;
BEGIN
  PERFORM 1 FROM public.boxes WHERE id = NEW.box_id FOR UPDATE;
  SELECT COUNT(*) INTO photo_count FROM public.box_photos WHERE box_id = NEW.box_id;
  -- Deterministic ordering: the slot is assigned while the box row is locked,
  -- so concurrent inserts can never produce duplicate sort_order values.
  NEW.sort_order := photo_count;
  IF photo_count >= 3 THEN
    RAISE EXCEPTION 'MAX_PHOTOS_PER_BOX';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_box_photo_limit_trigger ON public.box_photos;
CREATE TRIGGER enforce_box_photo_limit_trigger
  BEFORE INSERT ON public.box_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_box_photo_limit();

-- ============================================
-- 4) RLS on box_photos (same membership model as boxes/items)
-- ============================================
ALTER TABLE public.box_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view box photos" ON public.box_photos;
CREATE POLICY "Members can view box photos"
  ON public.box_photos FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND move_members.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.moves ON moves.id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND moves.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Members can create box photos" ON public.box_photos;
CREATE POLICY "Members can create box photos"
  ON public.box_photos FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.moves ON moves.id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND move_members.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Members can update box photos" ON public.box_photos;
CREATE POLICY "Members can update box photos"
  ON public.box_photos FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.moves ON moves.id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND move_members.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.moves ON moves.id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND move_members.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Members can delete box photos" ON public.box_photos;
CREATE POLICY "Members can delete box photos"
  ON public.box_photos FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.moves ON moves.id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.boxes
      JOIN public.rooms ON rooms.id = boxes.room_id
      JOIN public.move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = box_photos.box_id
      AND move_members.user_id = auth.uid()
    )
  );

-- ============================================
-- 5) Storage RLS — move-membership based.
--    Object paths are {box_id}/{uuid}.jpg. A file is only readable/deletable
--    if it matches a box_photos row the current user may access, so files
--    without a DB record are unreachable and records drive authorization.
-- ============================================

-- Upload: the object's top folder must be a box in a move the user belongs to.
-- NOTE: the object filename must be qualified as storage.objects.name because
-- the subqueries join boxes/rooms/moves which all have a `name` column.
DROP POLICY IF EXISTS "Members can upload box photos" ON storage.objects;
CREATE POLICY "Members can upload box photos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
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

-- View: the object path must match a box_photos row the user may access.
DROP POLICY IF EXISTS "Members can view box photos" ON storage.objects;
CREATE POLICY "Members can view box photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'box-photos'
    AND (
      EXISTS (
        SELECT 1 FROM public.box_photos p
        JOIN public.boxes b ON b.id = p.box_id
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.move_members mm ON mm.move_id = r.move_id
        WHERE p.storage_path = storage.objects.name
          AND mm.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.box_photos p
        JOIN public.boxes b ON b.id = p.box_id
        JOIN public.rooms r ON r.id = b.room_id
        JOIN public.moves m ON m.id = r.move_id
        WHERE p.storage_path = storage.objects.name
          AND m.owner_id = auth.uid()
      )
    )
  );

-- Delete: folder-based membership check (same as INSERT). A record-driven
-- check would deadlock the app: deleting a photo removes the box_photos row
-- first, so the later file delete would find no matching record and be
-- blocked by RLS, orphaning the file. This is safe because table RLS already
-- lets move members delete the box_photos records, so allowing the file
-- delete grants no extra power — it only permits cleanup of the file itself.
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

-- ============================================
-- Reversal (run to undo this migration)
-- ============================================
-- DROP POLICY IF EXISTS "Members can upload box photos" ON storage.objects;
-- DROP POLICY IF EXISTS "Members can view box photos" ON storage.objects;
-- DROP POLICY IF EXISTS "Members can delete box photos" ON storage.objects;
--
-- DROP POLICY IF EXISTS "Members can view box photos" ON public.box_photos;
-- DROP POLICY IF EXISTS "Members can create box photos" ON public.box_photos;
-- DROP POLICY IF EXISTS "Members can update box photos" ON public.box_photos;
-- DROP POLICY IF EXISTS "Members can delete box photos" ON public.box_photos;
--
-- DROP TABLE IF EXISTS public.box_photos;
-- DROP FUNCTION IF EXISTS public.enforce_box_photo_limit();
-- DELETE FROM storage.buckets WHERE id = 'box-photos';
