-- Packly Database Migration
-- Version: 019
-- Description: Search filters for packing progress and "who packed it".
--
-- Extends public.search_inventory() (016) with three new defaulted filters,
-- so the app's Filters page can answer questions beyond name lookup:
--
--   • box_states TEXT[] — any subset of {'empty','packing','packed'}.
--       Mirrors the StatusPill used across the app exactly:
--         packed  → the box is sealed                (boxes.is_packed)
--         packing → it has items but is not sealed yet
--         empty   → it has no items at all
--       A box matches when its state is ANY of the selected states, so
--       selecting {empty, packing} means "everything left to pack".
--       Item results inherit the state of the box they are in; a room
--       qualifies when it contains a box in one of the selected states.
--
--   • room_state TEXT — 'no_boxes'       → rooms with no boxes at all
--                       'nothing_packed' → rooms that have boxes, none packed
--       The two are disjoint: "no_boxes" finds rooms not even started,
--       "nothing_packed" finds rooms whose boxes are none of them sealed.
--
--   • packed_by UUID — only rows created by that move member. Items match
--       items.created_by, boxes match boxes.created_by, and a room qualifies
--       when it holds a box or item created by that member. Backs the
--       "Packed by" filter in multi-member moves.
--
-- The previous 8-argument version is DROPPED first and replaced by a single
-- 11-argument version (the same pattern 016 used): every new parameter has a
-- DEFAULT, so older clients that call with the original named arguments keep
-- resolving against this one function instead of hitting an ambiguous overload.
--
-- Idempotent: safe to re-run.

-- ============================================
-- 1) Drop the previous 8-argument signature
-- ============================================
DROP FUNCTION IF EXISTS
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, boolean, int);

-- ============================================
-- 2) search_inventory() — 11 arguments
-- ============================================
CREATE OR REPLACE FUNCTION public.search_inventory(
  search_term       TEXT    DEFAULT NULL,
  move_scope_id     UUID    DEFAULT NULL,
  kinds             TEXT[]  DEFAULT NULL,   -- subset of {item,box,room}; NULL = all
  room_ids          UUID[]  DEFAULT NULL,   -- restrict to these rooms
  box_number_filter TEXT    DEFAULT NULL,   -- substring match on box_number
  has_photos_only   BOOLEAN DEFAULT FALSE,  -- only rows linked to a photo
  no_photos_only    BOOLEAN DEFAULT FALSE,  -- only rows with NO photo at all
  box_states        TEXT[]  DEFAULT NULL,   -- subset of {empty,packing,packed}
  room_state        TEXT    DEFAULT NULL,   -- 'no_boxes' | 'nothing_packed'
  packed_by         UUID    DEFAULT NULL,   -- only rows this member created
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
  -- Unknown statuses are ignored; only the three real states survive.
  -- NULL means "no status filter".
  v_box_states TEXT[] := NULLIF(
                           ARRAY(
                             SELECT DISTINCT s
                               FROM unnest(COALESCE(box_states, '{}'::text[])) AS s
                              WHERE s IN ('empty', 'packing', 'packed')
                           ),
                           '{}'::text[]
                         );
  v_room_state TEXT := CASE WHEN room_state IN ('no_boxes', 'nothing_packed')
                            THEN room_state END;
  v_packed_by  UUID := packed_by;
BEGIN
  -- Nothing typed and nothing filtered → no browsing. This is what keeps an
  -- untouched search bar from listing the entire inventory.
  IF v_term IS NULL
     AND room_ids IS NULL
     AND v_box_term IS NULL
     AND NOT has_photos_only
     AND NOT no_photos_only
     AND v_box_states IS NULL
     AND v_room_state IS NULL
     AND v_packed_by IS NULL THEN
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
      -- Item rows inherit their box's packing state.
      AND (v_box_states IS NULL
           OR ('packed'  = ANY(v_box_states) AND b.is_packed)
           OR ('packing' = ANY(v_box_states) AND NOT b.is_packed
               AND EXISTS (SELECT 1 FROM public.items xs WHERE xs.box_id = b.id))
           OR ('empty'   = ANY(v_box_states)
               AND NOT EXISTS (SELECT 1 FROM public.items xs WHERE xs.box_id = b.id)))
      AND (v_packed_by IS NULL OR i.created_by = v_packed_by)
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
      AND (v_box_states IS NULL
           OR ('packed'  = ANY(v_box_states) AND b.is_packed)
           OR ('packing' = ANY(v_box_states) AND NOT b.is_packed
               AND EXISTS (SELECT 1 FROM public.items xs WHERE xs.box_id = b.id))
           OR ('empty'   = ANY(v_box_states)
               AND NOT EXISTS (SELECT 1 FROM public.items xs WHERE xs.box_id = b.id)))
      AND (v_packed_by IS NULL OR b.created_by = v_packed_by)
      AND (v_term IS NULL
           OR b.box_number ILIKE '%' || v_term || '%'
           OR word_similarity(v_term, b.box_number) >= 0.4
           OR similarity(b.box_number, v_term) >= 0.4)

    UNION ALL

    -- ── Rooms by name ──────────────────────────────────────────────
    -- A box-number / has-photos / box-states filter still applies to rooms:
    -- a room qualifies when it CONTAINS a box that matches. room_state and
    -- packed_by answer the room question directly.
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
      AND (v_box_states IS NULL
           OR EXISTS (SELECT 1
                        FROM public.boxes xb
                       WHERE xb.room_id = r.id
                         AND (('packed'  = ANY(v_box_states) AND xb.is_packed)
                              OR ('packing' = ANY(v_box_states) AND NOT xb.is_packed
                                  AND EXISTS (SELECT 1
                                                FROM public.items xi
                                               WHERE xi.box_id = xb.id))
                              OR ('empty'   = ANY(v_box_states)
                                  AND NOT EXISTS (SELECT 1
                                                    FROM public.items xi
                                                   WHERE xi.box_id = xb.id)))))
      AND (v_room_state IS NULL
           OR (v_room_state = 'no_boxes'
               AND NOT EXISTS (SELECT 1 FROM public.boxes xb WHERE xb.room_id = r.id))
           OR (v_room_state = 'nothing_packed'
               AND EXISTS (SELECT 1 FROM public.boxes xb WHERE xb.room_id = r.id)
               AND NOT EXISTS (SELECT 1 FROM public.boxes xb
                                WHERE xb.room_id = r.id AND xb.is_packed)))
      AND (v_packed_by IS NULL
           OR EXISTS (SELECT 1
                        FROM public.items xi
                        JOIN public.boxes xb ON xb.id = xi.box_id
                       WHERE xb.room_id = r.id
                         AND xi.created_by = v_packed_by)
           OR EXISTS (SELECT 1
                        FROM public.boxes xb
                       WHERE xb.room_id = r.id
                         AND xb.created_by = v_packed_by))
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
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, boolean, text[], text, uuid, int)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.search_inventory(text, uuid, text[], uuid[], text, boolean, boolean, text[], text, uuid, int)
  TO authenticated;

-- ============================================
-- 4) Ask PostgREST to pick up the new signature immediately
-- ============================================
NOTIFY pgrst, 'reload schema';
