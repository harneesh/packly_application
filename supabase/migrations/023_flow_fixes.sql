-- 023_flow_fixes.sql
-- Description: five gate bugs and one data bug found by walking the two-user
-- flow end to end (owner creates → joiner requests → owner approves), plus the
-- hardening that falls out of the same review.
--
--   1) Nobody can create boxes. 021's INSERT policy asked is_box_member(id) —
--      and the box row does not exist yet, so the lookup returns NULL and the
--      check is false. Every insert fails with "new row violates row-level
--      security policy". The check has to be about the ROOM.
--   2) The joiner's screen read membership and the request in two separate
--      queries; an approval landing between them looked like a decline. One
--      server-side function answers it in a single snapshot.
--   3) Requesters could read the whole moves row through is_move_joiner, which
--      includes invite_code — so rotating the code did not lock out anyone
--      already in the queue. Reading a move now requires membership.
--   4) request_to_join_move had no rate limit: a signed-in stranger could try
--      codes as fast as the network allowed and learn move names.
--   5) A move whose owner deleted their account could never be managed again.
--      Ownership now transfers to the earliest-joined member.
--   6) 003's find_move_by_invite_code was still callable by anyone, signed-out
--      included, returning a move's id and name. Unused since 021. Dropped.
--
-- ORDERING RULE (same as 021): a policy expression is validated at CREATE
-- time, so a public.* helper it calls must be defined ABOVE it; a LANGUAGE sql
-- body is validated at CREATE time including the tables it reads. Run
-- supabase/audit-forward-refs.js and supabase/audit-policy-grants.js after any
-- edit to this file — the second one exists because a policy may only call
-- functions the QUERYING role can EXECUTE.
--
-- Idempotent: safe to re-run.

-- ============================================
-- 1) Boxes: gate the INSERT on the room, not on the box
--
-- is_box_member(box_id) resolves move_of_box(box_id) → reads public.boxes for
-- that id. Postgres evaluates the WITH CHECK before the row exists, so for an
-- INSERT the answer is always "no move" → false. Pairing a room-scoped helper
-- with is_box_member mirrors the box-scoped pairing 021 already had.
-- ============================================
CREATE OR REPLACE FUNCTION public.move_of_room(p_room_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.move_id
    FROM public.rooms r
   WHERE r.id = p_room_id;
$$;

/** Owner or active member of the move a room lives in. NULL room → false. */
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.is_move_member(public.move_of_room(p_room_id));
$$;

-- Called from INSIDE RLS policies, so the querying role itself needs EXECUTE.
GRANT EXECUTE ON FUNCTION public.is_room_member(uuid) TO authenticated;
-- Internal plumbing: only is_room_member (and other definer functions) call it.
REVOKE EXECUTE ON FUNCTION public.move_of_room(uuid) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Members can create boxes" ON public.boxes;
CREATE POLICY "Members can create boxes"
  ON public.boxes FOR INSERT
  WITH CHECK (public.is_room_member(room_id));

-- USING reads the OLD row (the room it is in now, so you cannot touch a box in
-- a move you are not in); WITH CHECK reads the NEW row (the room it is moving
-- to, so a box cannot be smuggled into another move's room).
DROP POLICY IF EXISTS "Members can update boxes" ON public.boxes;
CREATE POLICY "Members can update boxes"
  ON public.boxes FOR UPDATE
  USING (public.is_room_member(room_id))
  WITH CHECK (public.is_room_member(room_id));

-- ============================================
-- 2) my_join_status — the joiner's question, answered in one snapshot
--
-- The screen used to read move_members and move_join_requests in two parallel
-- queries. Approval deletes the request AND inserts the membership, so an
-- approval landing between the two reads produced "no membership, no request"
-- — indistinguishable from a decline. A single statement sees one snapshot, so
-- the three answers cannot disagree.
--
--   'member'  — in the move (owner, or an approved member)
--   'pending' — a request is waiting for the owner
--   'none'    — neither, which after filing a request means it was denied
--               (or the move is gone)
-- ============================================
CREATE OR REPLACE FUNCTION public.my_join_status(p_move_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
           WHEN auth.uid() IS NULL OR p_move_id IS NULL THEN 'none'
           WHEN public.is_move_member(p_move_id) THEN 'member'
           WHEN EXISTS (
                  SELECT 1 FROM public.move_join_requests jr
                   WHERE jr.move_id = p_move_id
                     AND jr.user_id = auth.uid()
                ) THEN 'pending'
           ELSE 'none'
         END;
$$;

REVOKE EXECUTE ON FUNCTION public.my_join_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_join_status(uuid) TO authenticated;

-- ============================================
-- 3) The moves row is for members
--
-- 021 let is_move_joiner() through here so a requester could be told which move
-- they had asked to join — but that is the whole row, invite_code included, so
-- rotating a leaked code did not evict anyone who had already requested: they
-- simply read the new code. The requester already gets the name it needs from
-- request_to_join_move(), so nothing in the app wants this access back.
-- ============================================
DROP POLICY IF EXISTS "Members can view moves" ON public.moves;
CREATE POLICY "Members can view moves"
  ON public.moves FOR SELECT
  USING (public.is_move_member(id));

-- is_move_joiner() is now unused by any policy. Kept because it is granted and
-- documented; drop it in a later migration if nothing wants it.

-- ============================================
-- 4) Leaving: allowed, except for the owner
--
-- A member deleting their own row is how "leave this move" works. The owner
-- must not: they would vanish from their own roster while still owning the
-- move (no one could approve requests or rotate the code afterwards). Owners
-- leave by deleting the move, or by handing it over.
-- ============================================
DROP POLICY IF EXISTS "Members can leave moves" ON public.move_members;
CREATE POLICY "Members can leave moves"
  ON public.move_members FOR DELETE
  USING (user_id = auth.uid() AND NOT public.is_move_owner(move_id));

-- ============================================
-- 5) Rate limit for join attempts
--
-- 36^6 codes make guessing hopeless by brute force, but nothing stopped a
-- signed-in script from trying thousands per minute — and every hit answered
-- with the move's name. Attempts are recorded whether or not the code exists,
-- so a wrong guess costs exactly what a right one costs.
-- ============================================
CREATE TABLE IF NOT EXISTS public.join_attempts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_join_attempts_user_time
  ON public.join_attempts(user_id, attempted_at DESC);

ALTER TABLE public.join_attempts ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the SECURITY DEFINER functions below touch it.
REVOKE ALL ON public.join_attempts FROM PUBLIC, anon, authenticated;

/**
 * File a request to join a move by invite code (021 behaviour), now throttled.
 * Idempotent: calling it again returns the same status, never a second row.
 */
CREATE OR REPLACE FUNCTION public.request_to_join_move(p_invite_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_move_id uuid;
  v_name    text;
  v_tries   int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  -- ── Rate limit: 30 attempts per rolling hour ──
  -- Somehow above any human click rate (and above a two-phone test session)
  -- and astronomically below what guessing 36^6 codes would need. Old rows are
  -- swept here so the table stays tiny without a cron job.
  DELETE FROM public.join_attempts
   WHERE user_id = auth.uid()
     AND attempted_at < now() - interval '1 day';

  SELECT count(*) INTO v_tries
    FROM public.join_attempts
   WHERE user_id = auth.uid()
     AND attempted_at > now() - interval '1 hour';

  IF v_tries >= 30 THEN
    RAISE EXCEPTION 'TOO_MANY_JOIN_ATTEMPTS';
  END IF;

  INSERT INTO public.join_attempts (user_id) VALUES (auth.uid());

  SELECT m.id, m.name
    INTO v_move_id, v_name
    FROM public.moves m
   WHERE m.invite_code = NULLIF(upper(trim(COALESCE(p_invite_code, ''))), '');

  IF v_move_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_INVITE_CODE';
  END IF;

  -- Already in? Owners and members are done — asking again changes nothing.
  IF public.is_move_member_for(v_move_id, auth.uid()) THEN
    RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'active');
  END IF;

  -- ON CONFLICT DO NOTHING keeps this idempotent: a request that already exists
  -- is left alone rather than duplicated or re-dated.
  INSERT INTO public.move_join_requests (move_id, user_id)
  VALUES (v_move_id, auth.uid())
  ON CONFLICT (move_id, user_id) DO NOTHING;

  RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'pending');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_to_join_move(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_to_join_move(text) TO authenticated;

-- ============================================
-- 6) Drop the pre-021 way of looking up a move by code
--
-- find_move_by_invite_code (003) never had its EXECUTE revoked, so anyone —
-- signed out included — could pass a code and receive the move's id and name.
-- Nothing in the app has called it since request_to_join_move took over.
-- ============================================
DROP FUNCTION IF EXISTS public.find_move_by_invite_code(text);

-- ============================================
-- 7) Deleting your account must not strand a shared move
--
-- 015 keeps the moves of a deleted owner, but approving requests, rotating the
-- invite code and deleting the move are all owner-only, and the owner can
-- never sign in again — so every move they owned was frozen forever, with any
-- pending requester permanently in limbo. Ownership now goes to the member who
-- joined first, at the moment of deletion. A move with nobody else in it is
-- left exactly as it was: there is no one to hand it to and nobody is blocked
-- by it.
--
-- joined_at exists so "who joined first" is answerable; rows that predate it
-- are ordered by user_id as a stable tie-break.
-- ============================================
ALTER TABLE public.move_members
  ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.delete_account(p_confirm text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_free int;
  v_pro  int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF p_confirm IS NULL OR length(p_confirm) < 8 THEN
    RAISE EXCEPTION 'INVALID_CONFIRM';
  END IF;

  -- ── 1) Wipe credit balances with an exact ledger trail ──
  -- Read BEFORE zeroing so SUM(delta) per bucket keeps matching the balance
  -- (the 014 invariant).
  SELECT COALESCE(free_balance, 0), COALESCE(pro_balance, 0)
    INTO v_free, v_pro
    FROM public.user_credits
   WHERE user_id = v_uid;

  IF COALESCE(v_free, 0) > 0 THEN
    INSERT INTO public.credit_ledger (user_id, delta, reason, bucket)
    VALUES (v_uid, -v_free, 'account_deleted', 'free');
  END IF;

  IF COALESCE(v_pro, 0) > 0 THEN
    INSERT INTO public.credit_ledger (user_id, delta, reason, bucket)
    VALUES (v_uid, -v_pro, 'account_deleted', 'pro');
  END IF;

  UPDATE public.user_credits
     SET free_balance   = 0,
         pro_balance    = 0,
         pro_expires_at = NULL,
         updated_at     = now()
   WHERE user_id = v_uid;

  -- ── 1.5) Hand over every move they own, before they become unreachable ──
  UPDATE public.moves m
     SET owner_id = (
           SELECT mm.user_id
             FROM public.move_members mm
            WHERE mm.move_id = m.id
              AND mm.user_id <> v_uid
            ORDER BY mm.joined_at ASC, mm.user_id ASC
            LIMIT 1
         )
   WHERE m.owner_id = v_uid
     AND EXISTS (
           SELECT 1
             FROM public.move_members mm
            WHERE mm.move_id = m.id
              AND mm.user_id <> v_uid
         );

  -- Their roster rows go with them. The account is gone; a tombstoned member
  -- would only confuse the new owner about who is actually in the move.
  DELETE FROM public.move_members WHERE user_id = v_uid;

  -- ── 2) Tombstone the profile row ──
  -- Keep the row (shared moves still reference it) but free the email and
  -- mark the deletion time. The token keeps repeat deletes from colliding.
  UPDATE public.users
     SET email      = 'deleted+' || left(p_confirm, 12) || '@packly.invalid',
         deleted_at = now()
   WHERE id = v_uid;

  -- ── 3) Ban the auth user — the "deleted" the user actually sees ──
  -- Blocks ALL sign-in methods forever. The row stays, so the original email
  -- remains reserved (no re-signup → no free-credit farming).
  UPDATE auth.users
     SET banned_until = 'infinity'::timestamptz
   WHERE id = v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account(text) TO authenticated;

-- ============================================
-- 8) Verification (run after applying; all read-only)
--
--   -- the policy helpers the client role must be able to call
--   SELECT p.oid::regprocedure AS fn,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('is_move_owner','is_move_member','is_move_joiner',
--                        'is_box_member','is_room_member','my_join_status')
--    ORDER BY 1;
--   -- expect can_execute = true for all six.
--
--   -- the two boxes policies now gate on the room
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr,
--          pg_get_expr(polwithcheck, polrelid)   AS check_expr
--     FROM pg_policy
--    WHERE polrelid = 'public.boxes'::regclass
--    ORDER BY polname;
--   -- expect "Members can create boxes" to check is_room_member(room_id).
--
--   -- a requester can no longer read the move row (expect 0 rows)
--   -- (as the requester, after filing a request)
--   SELECT id, invite_code FROM public.moves WHERE id = '<move id>';
--
--   -- the old leak is gone
--   SELECT proname FROM pg_proc
--    WHERE proname = 'find_move_by_invite_code';   -- expect 0 rows
-- ============================================
