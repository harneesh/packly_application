-- 022_grant_policy_functions.sql
-- Fix: an RLS policy may only call functions the QUERYING role can EXECUTE.
--
-- 021 introduced two policies whose expression calls public.is_move_owner():
--
--   move_join_requests | "Requesters and owners can view join requests"
--   move_members       | "Members can join moves"
--
-- and, in the same file, revoked EXECUTE on is_move_owner from anon and
-- authenticated (it was filed under "internal plumbing — called by other
-- SECURITY DEFINER functions, never by a client"). That classification is
-- wrong for a function used *inside a policy*: Postgres checks the privilege
-- against the role running the query, and a SECURITY DEFINER wrapper does not
-- help, because the check happens at the policy's own call site.
--
-- Effect in production: every signed-in read of move_join_requests failed with
--   42501 "permission denied for function is_move_owner"
-- instead of returning rows. A requester polling for their own request got
-- nothing back, which the app read as "the owner declined your request", and
-- the owner saw an empty queue. The SQL editor never showed it because the
-- SQL editor runs as postgres, which owns every table and function.
--
-- is_move_owner(p_move_id) is SECURITY DEFINER and takes no user id: it only
-- ever answers "is auth.uid() the owner of this move?", so granting EXECUTE to
-- authenticated exposes nothing about anyone else's moves.
--
-- supabase/audit-policy-grants.js checks this whole class statically — run it
-- after any change that adds a policy or moves a REVOKE.
--
-- Idempotent: safe to re-run.

GRANT EXECUTE ON FUNCTION public.is_move_owner(uuid) TO authenticated;

-- Same root cause, one level out: create-move.tsx inserts the owner's own
-- move_members row right after creating the move, and that INSERT is checked
-- against the "Members can join moves" policy above — so it was rejected, too,
-- and the app logs it as non-critical. The move still worked (every membership
-- test treats m.owner_id = auth.uid() as a member), but the owner was missing
-- from the roster and from any list built from move_members alone.
-- Backfill the owners whose row never landed. Idempotent.
INSERT INTO public.move_members (move_id, user_id)
SELECT m.id, m.owner_id
  FROM public.moves m
ON CONFLICT (move_id, user_id) DO NOTHING;

-- Verify with:
--
--   SELECT p.oid::regprocedure,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('is_move_owner', 'is_move_member', 'is_move_joiner',
--                        'is_box_member', 'is_move_member_for')
--    ORDER BY p.proname;
--
-- Expect can_execute = true for is_move_owner / is_move_member / is_move_joiner
-- / is_box_member, and false for is_move_member_for (internal, never a policy).
