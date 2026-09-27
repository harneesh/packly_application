-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Adds an additional SELECT policy on the users table so that
-- members of the same move can view each other's basic profile (name, email).
--
-- The existing policy "Users can read own profile" only allows SELECT on your
-- own row (id = auth.uid()). This is correct for privacy, but it prevents the
-- Members modal from showing other members' names because the Supabase join
-- (move_members → users) gets filtered by RLS.
--
-- This new policy allows SELECT on users rows if the current user shares a
-- move with that user (both are in move_members for the same move).
--
-- Both policies are OR'd together by PostgreSQL, so the effective rule is:
--   Can read user if: it's yourself OR you share a move with them.
-- ============================================

CREATE POLICY "Members can view profiles of move collaborators"
  ON users FOR SELECT
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM move_members mm1
      JOIN move_members mm2 ON mm1.move_id = mm2.move_id
      WHERE mm1.user_id = users.id
      AND mm2.user_id = auth.uid()
    )
  );
