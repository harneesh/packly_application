-- Packly Database Migration
-- Version: 008 (rev 2)
-- Description: Upgrade search_user_items() with typo-tolerant matching
-- (pg_trgm) and optional move scoping.
--
-- FIX (rev 2): The first version of this migration produced
--   "function word_similarity(text, text) does not exist (42883)"
-- at runtime. Cause: the function body runs with `SET search_path = ''`
-- (SECURITY DEFINER hardening), but pg_trgm installs its functions
-- (word_similarity / similarity) into a non-pg_catalog schema, so they
-- were invisible to the function.
--
-- Fix: install pg_trgm explicitly into the `extensions` schema, grant
-- usage on it, and set the function's search_path to `extensions, public`.
-- This resolves word_similarity()/similarity() no matter which schema
-- pg_trgm landed in (extensions or public). Everything else in the query
-- is already schema-qualified, so widening the path does not weaken the
-- SECURITY DEFINER hardening meaningfully.
--
-- The whole script is idempotent — safe to re-run after a partial/failed run.

-- ============================================
-- Extension: pg_trgm (trigram similarity)
-- Installed into the standard Supabase `extensions` schema.
-- If it was already created elsewhere (e.g. public), IF NOT EXISTS makes
-- this a no-op and the function below still resolves it via search_path.
-- ============================================
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_items_name_trgm ON public.items USING gin (name gin_trgm_ops);

-- ============================================
-- Drop the old 2-arg overload from migration 004 so RPC calls that omit
-- move_scope_id are not ambiguous (PostgREST resolves overloads by name).
-- ============================================
DROP FUNCTION IF EXISTS public.search_user_items(text, int);

-- ============================================
-- Function: search_user_items()
-- Purpose: Typo-tolerant item search, optionally scoped to one move
-- Parameters:
--   search_term TEXT               — the user's search query
--   move_scope_id UUID DEFAULT NULL — scope results to a single move (NULL = all moves)
--   result_limit INT DEFAULT 100   — max results, clamped to [1, 500]
-- Returns: TABLE of matching items with room, box, and move context
-- Used by: SearchWidget (client calls supabase.rpc('search_user_items'))
-- Security: SECURITY DEFINER; search_path includes extensions so the
-- pg_trgm functions resolve. All table references stay schema-qualified.
-- NOTE: The IN parameter is named move_scope_id (NOT move_id) because
-- RETURNS TABLE columns are OUT parameters and Postgres requires IN/OUT
-- parameter names to be unique — move_id already appears in the result set.
-- ============================================
CREATE OR REPLACE FUNCTION public.search_user_items(
  search_term TEXT,
  move_scope_id UUID DEFAULT NULL,
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
SECURITY DEFINER SET search_path = extensions, public
AS $$
DECLARE
  term TEXT := trim(search_term);
  max_results INT := LEAST(GREATEST(COALESCE(result_limit, 1), 1), 500);
BEGIN
  IF term = '' THEN
    RETURN;
  END IF;

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
  WHERE (move_scope_id IS NULL OR m.id = move_scope_id)
    AND (
      i.name ILIKE '%' || term || '%'
      OR word_similarity(term, i.name) >= 0.4
      OR similarity(i.name, term) >= 0.4
    )
  ORDER BY
    -- Exact substring matches first, then by similarity, then recency
    (CASE WHEN i.name ILIKE '%' || term || '%' THEN 1 ELSE 0 END) DESC,
    GREATEST(word_similarity(term, i.name), similarity(i.name, term)) DESC,
    i.created_at DESC
  LIMIT max_results;
END;
$$;
