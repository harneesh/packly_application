-- Packly Database Migration
-- Version: 016
-- Description: Faceted search — items, boxes AND rooms, with filters.
--
-- Adds public.search_inventory(), the successor to search_user_items()
-- (which is kept intact below so an older client build keeps working).
--
-- What it can do that 008 could not:
--   • match BOXES by box_number          ("Kitchen 3" → the box itself)
--   • match ROOMS by name                ("Kitchen" → the room itself)
--   • restrict results to specific rooms (room_ids)
--   • restrict results to boxes whose number contains text (box_number_filter)
--   • return only rows that HAVE photos (has_photos_only) or only rows with
--     NO photos (no_photos_only) — the "Item with picture / No picture" toggle
--   • run with an EMPTY search term — pure filter browsing ("browse taps"),
--     which is how Google Photos / Airbnb style filters behave
--
-- It returns all three result kinds in ONE round trip, each row carrying the
-- full context (box + room + move) plus a relevance score. Rows are ordered
-- by score, then by kind (boxes first — the packing workflow), then title.
--
-- Photos: the 'box-photos' bucket is PRIVATE, so this function returns the
-- box's first photo *storage path*; the client signs it into a short-lived
-- URL (services/photos.ts → signPhotoPaths). Never expose a raw path as a URL.
--
-- Security: SECURITY DEFINER with search_path = extensions, public (same
-- hardening as 008 — pg_trgm lives in the extensions schema). Membership is
-- checked as "move owner OR move member", mirroring the RLS used by
-- boxes/items/rooms rather than relying on move_members alone.
--
-- Idempotent: safe to re-run.

-- ============================================
-- 1) Trigram indexes for the new match columns
--    (items.name already has one from migration 008)
-- ============================================
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_boxes_number_trgm
  ON public.boxes USING gin (box_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rooms_name_trgm
  ON public.rooms USING gin (name gin_trgm_ops);

-- ============================================
-- 2) search_inventory()
-- ============================================
-- Drop any previously-created 7-argument version first: this migration adds
-- the `no_photos_only` parameter, and CREATE OR REPLACE with a new signature
-- would otherwise leave the old overload behind (PostgREST would then see two
-- candidates and fail the call as ambiguous).
DROP FUNCTION IF EXISTS
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, int);

CREATE OR REPLACE FUNCTION public.search_inventory(
  search_term       TEXT    DEFAULT NULL,
  move_scope_id     UUID    DEFAULT NULL,
  kinds             TEXT[]  DEFAULT NULL,   -- subset of {item,box,room}; NULL = all
  room_ids          UUID[]  DEFAULT NULL,   -- restrict to these rooms
  box_number_filter TEXT    DEFAULT NULL,   -- substring match on box_number
  has_photos_only   BOOLEAN DEFAULT FALSE,  -- only rows linked to a photo
  no_photos_only    BOOLEAN DEFAULT FALSE,  -- only rows with NO photo at all
  result_limit      INT     DEFAULT 100
)
RETURNS TABLE(
  kind        TEXT,
  entity_id   UUID,
  title       TEXT,
  box_id      UUID,
  box_number  TEXT,
  room_id     UUID,
  room_name   TEXT,
  move_id     UUID,
  move_name   TEXT,
  photo_path  TEXT,
  score       REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = extensions, public
AS $$
DECLARE
  v_term       TEXT := NULLIF(trim(COALESCE(search_term, '')), '');
  v_box_term   TEXT := NULLIF(trim(COALESCE(box_number_filter, '')), '');
  v_lim        INT  := LEAST(GREATEST(COALESCE(result_limit, 100), 1), 500);
  v_items      BOOLEAN := (kinds IS NULL OR 'item' = ANY(kinds));
  v_boxes      BOOLEAN := (kinds IS NULL OR 'box'  = ANY(kinds));
  v_rooms      BOOLEAN := (kinds IS NULL OR 'room' = ANY(kinds));
BEGIN
  -- Nothing typed and nothing filtered → no browsing. This is what keeps an
  -- untouched search bar from listing the entire inventory.
  IF v_term IS NULL
     AND room_ids IS NULL
     AND v_box_term IS NULL
     AND NOT has_photos_only
     AND NOT no_photos_only THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    u.kind, u.entity_id, u.title, u.box_id, u.box_number, u.room_id,
    u.room_name, u.move_id, u.move_name, u.photo_path, u.score
  FROM (
    -- ── Items by name ──────────────────────────────────────────────
    SELECT
      'item'::text AS kind,
      i.id                        AS entity_id,
      i.name                      AS title,
      b.id                        AS box_id,
      b.box_number                AS box_number,
      r.id                        AS room_id,
      r.name                      AS room_name,
      m.id                        AS move_id,
      m.name                      AS move_name,
      (SELECT p.storage_path
         FROM public.box_photos p
        WHERE p.box_id = b.id
        ORDER BY p.sort_order, p.created_at
        LIMIT 1)                  AS photo_path,
      (CASE
         WHEN v_term IS NULL THEN 0::real
         ELSE GREATEST(
                CASE WHEN i.name ILIKE '%' || v_term || '%' THEN 1.0 ELSE 0.0 END,
                word_similarity(v_term, i.name),
                similarity(i.name, v_term)
              )::real
       END)                       AS score,
      1                           AS kind_rank
    FROM public.items i
    JOIN public.boxes b ON b.id = i.box_id
    JOIN public.rooms r ON r.id = b.room_id
    JOIN public.moves m ON m.id = r.move_id
    WHERE v_items
      AND (m.owner_id = auth.uid()
           OR EXISTS (SELECT 1 FROM public.move_members mm
                       WHERE mm.move_id = m.id AND mm.user_id = auth.uid()))
      AND (move_scope_id IS NULL OR m.id = move_scope_id)
      AND (room_ids IS NULL OR r.id = ANY(room_ids))
      AND (v_box_term IS NULL OR b.box_number ILIKE '%' || v_box_term || '%')
      AND (NOT has_photos_only
           OR EXISTS (SELECT 1 FROM public.box_photos p WHERE p.box_id = b.id))
      AND (NOT no_photos_only
           OR NOT EXISTS (SELECT 1 FROM public.box_photos p WHERE p.box_id = b.id))
      AND (v_term IS NULL
           OR i.name ILIKE '%' || v_term || '%'
           OR word_similarity(v_term, i.name) >= 0.4
           OR similarity(i.name, v_term) >= 0.4)

    UNION ALL

    -- ── Boxes by box number ────────────────────────────────────────
    SELECT
      'box'::text,
      b.id,
      b.box_number,
      b.id,
      b.box_number,
      r.id,
      r.name,
      m.id,
      m.name,
      (SELECT p.storage_path
         FROM public.box_photos p
        WHERE p.box_id = b.id
        ORDER BY p.sort_order, p.created_at
        LIMIT 1),
      (CASE
         WHEN v_term IS NULL THEN 0::real
         ELSE GREATEST(
                CASE WHEN b.box_number ILIKE '%' || v_term || '%' THEN 1.0 ELSE 0.0 END,
                word_similarity(v_term, b.box_number),
                similarity(b.box_number, v_term)
              )::real
       END),
      0
    FROM public.boxes b
    JOIN public.rooms r ON r.id = b.room_id
    JOIN public.moves m ON m.id = r.move_id
    WHERE v_boxes
      AND (m.owner_id = auth.uid()
           OR EXISTS (SELECT 1 FROM public.move_members mm
                       WHERE mm.move_id = m.id AND mm.user_id = auth.uid()))
      AND (move_scope_id IS NULL OR m.id = move_scope_id)
      AND (room_ids IS NULL OR r.id = ANY(room_ids))
      AND (v_box_term IS NULL OR b.box_number ILIKE '%' || v_box_term || '%')
      AND (NOT has_photos_only
           OR EXISTS (SELECT 1 FROM public.box_photos p WHERE p.box_id = b.id))
      AND (NOT no_photos_only
           OR NOT EXISTS (SELECT 1 FROM public.box_photos p WHERE p.box_id = b.id))
      AND (v_term IS NULL
           OR b.box_number ILIKE '%' || v_term || '%'
           OR word_similarity(v_term, b.box_number) >= 0.4
           OR similarity(b.box_number, v_term) >= 0.4)

    UNION ALL

    -- ── Rooms by name ─────────────────────────────────────────────
    -- A box-number / has-photos filter still applies to rooms: a room
    -- qualifies when it CONTAINS a box that matches.
    SELECT
      'room'::text,
      r.id,
      r.name,
      NULL::uuid,
      NULL::text,
      r.id,
      r.name,
      m.id,
      m.name,
      NULL::text,
      (CASE
         WHEN v_term IS NULL THEN 0::real
         ELSE GREATEST(
                CASE WHEN r.name ILIKE '%' || v_term || '%' THEN 1.0 ELSE 0.0 END,
                word_similarity(v_term, r.name),
                similarity(r.name, v_term)
              )::real
       END),
      2
    FROM public.rooms r
    JOIN public.moves m ON m.id = r.move_id
    WHERE v_rooms
      AND (m.owner_id = auth.uid()
           OR EXISTS (SELECT 1 FROM public.move_members mm
                       WHERE mm.move_id = m.id AND mm.user_id = auth.uid()))
      AND (move_scope_id IS NULL OR m.id = move_scope_id)
      AND (room_ids IS NULL OR r.id = ANY(room_ids))
      AND (v_box_term IS NULL
           OR EXISTS (SELECT 1 FROM public.boxes b2
                       WHERE b2.room_id = r.id
                         AND b2.box_number ILIKE '%' || v_box_term || '%'))
      AND (NOT has_photos_only
           OR EXISTS (SELECT 1
                        FROM public.boxes b3
                        JOIN public.box_photos p ON p.box_id = b3.id
                       WHERE b3.room_id = r.id))
      AND (NOT no_photos_only
           OR NOT EXISTS (SELECT 1
                            FROM public.boxes b4
                            JOIN public.box_photos p ON p.box_id = b4.id
                           WHERE b4.room_id = r.id))
      AND (v_term IS NULL
           OR r.name ILIKE '%' || v_term || '%'
           OR word_similarity(v_term, r.name) >= 0.4
           OR similarity(r.name, v_term) >= 0.4)
  ) u
  ORDER BY u.score DESC, u.kind_rank ASC, u.title ASC
  LIMIT v_lim;
END;
$$;

-- ============================================
-- 3) Permissions — authenticated callers only
-- ============================================
REVOKE EXECUTE ON FUNCTION
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, boolean, int)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, boolean, int)
  TO authenticated;

-- ============================================
-- NOTE: search_user_items() from migration 008 is intentionally left in
-- place (deprecated). The app now calls search_inventory(). Drop it once no
-- released build references it:
--   DROP FUNCTION IF EXISTS public.search_user_items(text, uuid, int);
-- ============================================
