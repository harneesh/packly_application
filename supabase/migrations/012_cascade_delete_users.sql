-- Packly Database Migration
-- Version: 012
-- Description: Cascade-delete public.users rows when the auth user is deleted.
--
-- Problem this fixes:
--   Deleting a user from Supabase Auth (Dashboard → Authentication → Users)
--   removed only the auth.users row. The matching public.users row stayed
--   behind, because public.users had no foreign key to auth.users.
--   Any future signup with the same email then crashed with:
--     duplicate key value violates unique constraint "users_email_key"
--   → surfaced to the client as "Database error saving new user"
--
-- Fix (official Supabase pattern): add a foreign key from public.users to
-- auth.users with ON DELETE CASCADE.

-- ============================================
-- 1) One-time cleanup: remove orphaned public.users rows whose auth user
--    no longer exists. Cascades to their moves / rooms / boxes / items /
--    credits (all reference users(id) ON DELETE CASCADE).
--    Idempotent — safe to re-run.
-- ============================================
DELETE FROM public.users
WHERE id NOT IN (SELECT id FROM auth.users);

-- ============================================
-- 2) Permanent fix: keep public.users in sync with auth.users forever.
-- ============================================
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_id_fkey;

ALTER TABLE public.users
  ADD CONSTRAINT users_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users (id)
  ON DELETE CASCADE;
