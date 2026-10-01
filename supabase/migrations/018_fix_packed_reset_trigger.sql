-- Migration 018: repair the packed-reset trigger created by 017.
--
-- WHAT WENT WRONG
-- 017 installed an AFTER DELETE trigger on public.items whose function body
-- read OLD.is_packed. OLD is an ITEM row and items have no is_packed column,
-- so plpgsql raised:
--
--     record "old" has no field "is_packed"   (SQLSTATE 42703)
--
-- on every single item delete. Because the trigger runs inside the deleting
-- transaction, the exception rolled the DELETE back and PostgREST returned an
-- error — which the app surfaced as "Failed to delete item. Please try
-- again". It also targeted OLD.id instead of OLD.box_id, so even without the
-- missing column it would have looked for a box with the item's id.
--
-- This migration replaces the function body with the correct one. It is
-- idempotent (CREATE OR REPLACE) and safe to run on any database, including
-- ones that never ran 017 — the trigger itself is only created if missing.

CREATE OR REPLACE FUNCTION public.boxes_reset_packed_on_empty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY definer
SET search_path = public
AS $$
BEGIN
  -- OLD is the deleted item: its box is OLD.box_id. The AND is_packed guard
  -- keeps this a no-op write when the box was already un-packed.
  UPDATE public.boxes
     SET is_packed = false
   WHERE id = OLD.box_id
     AND is_packed;
  RETURN OLD;
END;
$$;

-- Only needed on a database where 017 never created it.
DROP TRIGGER IF EXISTS boxes_reset_packed_on_empty_trigger ON public.items;
CREATE TRIGGER boxes_reset_packed_on_empty_trigger
  AFTER DELETE ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION public.boxes_reset_packed_on_empty();
