-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Creates a SECURITY DEFINER function that allows unauthenticated
-- (non-member) users to look up a move by invite_code when joining a move.
--
-- The standard RLS policy on moves requires the user to be the owner or a member
-- to SELECT. But when joining, the user is neither yet. This function bypasses
-- RLS using SECURITY DEFINER while only exposing the minimum needed data (id).

-- ============================================
-- Function: find_move_by_invite_code()
-- Purpose: Look up a move ID by invite code, bypassing RLS
-- Used by: Join Move flow (client calls supabase.rpc)
-- Returns: The move row (id, name) or null if not found
-- ============================================
CREATE OR REPLACE FUNCTION public.find_move_by_invite_code(code TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object('id', id, 'name', name)
  INTO result
  FROM public.moves
  WHERE invite_code = code;

  RETURN result;
END;
$$;
