-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Creates a SECURITY DEFINER function that searches items across
-- all moves the current user is a member of. Uses ILIKE for case-insensitive
-- pattern matching and joins through boxes → rooms → moves → move_members
-- to enforce access control via auth.uid().
--
-- The function returns typed columns (TABLE) that Supabase.rpc can map
-- directly to TypeScript objects on the client side.

-- ============================================
-- Extension: pg_trgm (optional, for trigram indexes)
-- Uncomment if you want faster ILIKE on large datasets:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON items USING gin (name gin_trgm_ops);
-- ============================================

-- ============================================
-- Function: search_user_items()
-- Purpose: Search items by name across all user's moves
-- Parameters:
--   search_term TEXT — the user's search query (case-insensitive ILIKE match)
--   result_limit INT (default 100) — maximum number of results to return
-- Returns: TABLE of matching items with room, box, and move context
-- Used by: Search screen (client calls supabase.rpc('search_user_items'))
-- Security: SECURITY DEFINER with explicit auth.uid() check via move_members
-- ============================================
CREATE OR REPLACE FUNCTION public.search_user_items(
  search_term TEXT,
  result_limit INT DEFAULT 100
)
RETURNS TABLE(
  item_id UUID,
  item_name TEXT,
  box_id UUID,
  box_number TEXT,
  room_id UUID,
  room_name TEXT,
  move_id UUID,
  move_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.name,
    b.id,
    b.box_number,
    r.id,
    r.name,
    m.id,
    m.name
  FROM public.items i
  JOIN public.boxes b ON b.id = i.box_id
  JOIN public.rooms r ON r.id = b.room_id
  JOIN public.moves m ON m.id = r.move_id
  JOIN public.move_members mm ON mm.move_id = m.id AND mm.user_id = auth.uid()
  WHERE i.name ILIKE '%' || search_term || '%'
  ORDER BY i.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(result_limit, 1), 1), 500);
END;
$$;

-- Note: B-tree indexes cannot help ILIKE '%...%' (leading wildcard prevents prefix lookup).
-- For large datasets, uncomment the GIN trigram index above. It supports
-- wildcard-prefix ILIKE via similarity search and is the correct index for
-- this query pattern.
-- CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON items USING gin (name gin_trgm_ops);

