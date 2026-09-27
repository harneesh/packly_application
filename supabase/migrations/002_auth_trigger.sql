-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Creates a trigger on auth.users that automatically inserts a
-- corresponding row into public.users whenever a new user signs up.
--
-- This ensures the public.users table stays in sync with Supabase Auth
-- without requiring client-side inserts, which would fail with RLS
-- when email confirmation is enabled (auth.uid() returns null).

-- ============================================
-- Function: handle_new_user()
-- Triggered by: AFTER INSERT ON auth.users
-- Purpose: Copies new user data from auth.users to public.users
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, name, email, created_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.created_at, NOW())
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ============================================
-- Trigger: on_auth_user_created
-- Fires: AFTER INSERT ON auth.users
-- ============================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
