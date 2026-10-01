-- 024_insert_returning_fixes.sql
-- Description: three gate bugs left after 023, and one cleanup.
--
--   1) Creating a move fails. create-move.tsx does insert(...).select('id'),
--      i.e. INSERT ... RETURNING. With RETURNING, Postgres also checks the
--      table's SELECT policy against the NEW row — as a WITH CHECK, BEFORE the
--      row is written. The moves SELECT policy is is_move_member(id), which
--      looks the move up by id in public.moves; the row is not there yet, so
--      the answer is false and the insert is rejected. (001's policy compared
--      owner_id = auth.uid() on the row itself, which is why this used to work.)
--   2) "Add box" on Home fails the same way: insert(...).select() on boxes,
--      whose SELECT policy is_box_member(id) looks the box up by id. Gating on
--      the ROOM (which already exists) works for both new and existing rows.
--   3) The join rate limit never counted wrong codes. request_to_join_move
--      recorded the attempt and then RAISEd INVALID_INVITE_CODE — and a raise
--      rolls back the whole call, the attempt row included. Code guessing,
--      the case the limit exists for, was never throttled. An unknown code now
--      RETURNS {status: 'invalid'} so the attempt row commits.
--   4) delete_account left the deleted user's pending join requests in other
--      owners' queues, where an owner could approve an account that is gone.
--
-- RULE for anyone adding a policy: a SELECT policy must be true for a row that
-- is being INSERTed with RETURNING, so it may only look up OTHER rows (the
-- parent), never the row itself by its own id.
--
-- Idempotent: safe to re-run.

-- ============================================
-- 1) moves: the owner column answers for a row that does not exist yet
-- ============================================
DROP POLICY IF EXISTS "Members can view moves" ON public.moves;
CREATE POLICY "Members can view moves"
  ON public.moves FOR SELECT
  USING (owner_id = auth.uid() OR public.is_move_member(id));

-- ============================================
-- 2) boxes: every policy gates on the room, never on the box's own id
-- ============================================
DROP POLICY IF EXISTS "Members can view boxes" ON public.boxes;
CREATE POLICY "Members can view boxes"
  ON public.boxes FOR SELECT
  USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS "Members can delete boxes" ON public.boxes;
CREATE POLICY "Members can delete boxes"
  ON public.boxes FOR DELETE
  USING (public.is_room_member(room_id));

-- ============================================
-- 3) request_to_join_move: a wrong code is an answer, not an error
--
-- Returns json:
--   {status: 'invalid'}                     — no move has this code
--   {id, name, status: 'active'}            — owner or already a member
--   {id, name, status: 'pending'}           — a request is waiting
-- TOO_MANY_JOIN_ATTEMPTS is still raised: nothing is written on that path, so
-- there is nothing for the rollback to lose.
-- ============================================
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

  -- RETURN, not RAISE: a raise would roll back the attempt row above.
  IF v_move_id IS NULL THEN
    RETURN json_build_object('status', 'invalid');
  END IF;

  IF public.is_move_member_for(v_move_id, auth.uid()) THEN
    RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'active');
  END IF;

  INSERT INTO public.move_join_requests (move_id, user_id)
  VALUES (v_move_id, auth.uid())
  ON CONFLICT (move_id, user_id) DO NOTHING;

  RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'pending');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_to_join_move(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_to_join_move(text) TO authenticated;

-- ============================================
-- 4) delete_account: also withdraw the user's pending join requests
--    (023's body, plus one DELETE)
-- ============================================
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

  DELETE FROM public.move_members WHERE user_id = v_uid;

  -- A deleted account must not sit in anyone's approval queue.
  DELETE FROM public.move_join_requests WHERE user_id = v_uid;

  -- ── 2) Tombstone the profile row ──
  UPDATE public.users
     SET email      = 'deleted+' || left(p_confirm, 12) || '@packly.invalid',
         deleted_at = now()
   WHERE id = v_uid;

  -- ── 3) Ban the auth user ──
  UPDATE auth.users
     SET banned_until = 'infinity'::timestamptz
   WHERE id = v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- Verification (as a signed-in test user, via the app or the API — NOT the
-- SQL editor, which runs as postgres and bypasses RLS):
--   • Create a move               → succeeds, lands on Home.
--   • Home → Add box              → succeeds.
--   • Join with a wrong code 31×  → the 31st says "Too many tries".
-- ============================================
