-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Creates a SECURITY DEFINER function that returns all members of
-- a move with their name and email. This bypasses the restrictive RLS on the
-- users table (which only allows reading your own profile) so that move members
-- can see each other's basic info.
--
-- The function first checks that the calling user is a member of the specified
-- move, so it's not a security hole — only collaborators can see each other.
--
-- This is the same pattern used by search_user_items() and
-- find_move_by_invite_code().
-- ============================================

-- ============================================
-- Function: get_move_members()
-- Purpose: Return all members of a move with their user info
-- Parameters:
--   move_id UUID — the move to get members for
-- Returns: TABLE of user_id, name, email for each member
-- Security: SECURITY DEFINER with explicit auth.uid() check
-- ============================================
CREATE OR REPLACE FUNCTION public.get_move_members(move_id UUID)
RETURNS TABLE(
  user_id UUID,
  name TEXT,
  email TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Authorization: caller must be a member of this move
  IF NOT EXISTS (
    SELECT 1 FROM public.move_members
    WHERE move_members.move_id = get_move_members.move_id
    AND move_members.user_id = auth.uid()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.name,
    u.email
  FROM public.move_members mm
  JOIN public.users u ON u.id = mm.user_id
  WHERE mm.move_id = get_move_members.move_id;
END;
$$;
