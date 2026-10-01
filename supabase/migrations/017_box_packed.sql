-- Migration 017: Box packed state
-- Adds a user-controlled packed flag to boxes so the Home list can show a
-- Packed / Packing / Empty status pill per box.
--
--   • is_packed = true            → "Packed"  (user tapped the toggle)
--   • is_packed = false, has items → "Packing" (in progress)
--   • no items                     → "Empty"
--
-- Adding to the boxes table (same table the app already updates with RLS
-- "Members can update boxes"), so no policy changes are needed.

ALTER TABLE public.boxes
  ADD COLUMN is_packed BOOLEAN NOT NULL DEFAULT false;

-- Un-packing a box (e.g. items removed for re-pack) resets the flag so the
-- pill can't claim "Packed" on a box that was reopened. Removing the last
-- item flips the pill to "Empty" automatically (the app derives Empty from
-- the item count).
--
-- NOTE: the trigger fires on the ITEM row being deleted, so the box to reset
-- is OLD.box_id. Items have no is_packed column — referencing OLD.is_packed
-- here raised 'record "old" has no field "is_packed"' and rolled back every
-- item delete (fixed by 018 for databases that already ran this migration).
CREATE OR REPLACE FUNCTION public.boxes_reset_packed_on_empty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY definer
SET search_path = public
AS $$
BEGIN
  UPDATE public.boxes
     SET is_packed = false
   WHERE id = OLD.box_id
     AND is_packed;
  RETURN OLD;
END;
$$;

CREATE TRIGGER boxes_reset_packed_on_empty_trigger
  AFTER DELETE ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION public.boxes_reset_packed_on_empty();
