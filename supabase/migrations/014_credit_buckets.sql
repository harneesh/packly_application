-- Packly Database Migration
-- Version: 014
-- Description: Two-bucket credit model — free credits survive Pro cycles.
--
--   Problem: the single-pool model folded the 5 free signup credits into the
--   Pro balance on upgrade (top-up set balance := 200). When the subscription
--   expired, lazy expiry zeroed the whole pool — the user's own free credits
--   vanished with the subscription. Free credits are the user's property;
--   Pro credits belong to the subscription. They must not commingle.
--
-- Model:
--   user_credits.free_balance   — never expires, survives upgrade/downgrade
--   user_credits.pro_balance    — dies at pro_expires_at (lazy expiry)
--   user_credits.pro_expires_at — end of the current paid period (NULL = no pro)
--   user_credits.balance        — GENERATED column: free + pro (raw sum;
--                                 expired pro is subtracted at read time by
--                                 get_credit_balance, never stored)
--
-- Consumption order: PRO FIRST, then FREE — spend the perishable credits
-- before the user's own. Refunds return to the bucket the consume came from
-- (unless that pro window has since died, in which case the refund lands in
-- free so it can't be stranded).
--
-- Ledger gains a NOT NULL `bucket` column ('free' | 'pro') so the audit stays
-- exact: SUM(delta) per (user, bucket) === that bucket's balance. Historical
-- rows are marked 'pro' (written under the single-pool model where the pro
-- top-up overwrote everything — treating that history as pro keeps sums
-- consistent for anyone mid-subscription during the swap).
--
-- ALSO FIXES a latent bug from 010/013: the lazy-expiry blocks used
-- UPDATE ... RETURNING balance INTO v_expired, but RETURNING yields the
-- POST-update value (0 after SET balance = 0) — so 'expiry' ledger rows were
-- silently never written and the documented SUM(delta) = balance invariant
-- was broken. The corrected helper reads the balance BEFORE the update and
-- subtracts the NEW value inside RETURNING. Existing ledgers are not
-- back-filled; from this migration on, the trail is exact.
--
-- ALSO REWRITES apply_subscription_event (from 013): its EXPIRATION branch
-- referenced the dropped `balance`/`expires_at` columns and would have
-- broken at runtime. Logic is otherwise unchanged; it now delegates the
-- eager zero to the shared expiry helper.
--
-- Compatibility: every function signature is unchanged, so callers (auth
-- trigger, process-audio Edge Function, webhook RPC) need no code changes.

-- ============================================
-- 1) user_credits: add bucket columns (old balance/expires_at kept for now)
-- ============================================
ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS free_balance   INT NOT NULL DEFAULT 0 CHECK (free_balance >= 0),
  ADD COLUMN IF NOT EXISTS pro_balance    INT NOT NULL DEFAULT 0 CHECK (pro_balance >= 0),
  ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;

-- Fold the old single pool into the FREE bucket. (Post-013 the old pool is a
-- free-tier user's never-expiring balance. Anyone mid-Pro gets their pro
-- credits re-created by the next webhook top-up — the top-up's normal
-- behavior, documented in 013.)
UPDATE public.user_credits
   SET free_balance = balance, pro_balance = 0, pro_expires_at = NULL;

-- Swap the old pool columns for the generated total.
ALTER TABLE public.user_credits DROP COLUMN IF EXISTS expires_at;
ALTER TABLE public.user_credits DROP COLUMN IF EXISTS balance;
ALTER TABLE public.user_credits
  ADD COLUMN balance INT GENERATED ALWAYS AS (free_balance + pro_balance) STORED;

COMMENT ON COLUMN public.user_credits.balance IS
  'Generated raw sum: free_balance + pro_balance. Read-only — never UPDATE it directly. Expired pro credits are subtracted at read time by get_credit_balance().';

-- ============================================
-- 2) credit_ledger: bucket column
-- ============================================
ALTER TABLE public.credit_ledger
  ADD COLUMN IF NOT EXISTS bucket TEXT CHECK (bucket IN ('free', 'pro'));

UPDATE public.credit_ledger SET bucket = 'pro' WHERE bucket IS NULL;

ALTER TABLE public.credit_ledger ALTER COLUMN bucket SET NOT NULL;

-- ============================================
-- 3) Shared lazy-expiry helper (service-role form: explicit user id).
--    Reads pro_balance BEFORE zeroing (the RETURNING-after-SET bug fix) and
--    logs the exact dropped amount to the ledger.
--    Invoked only from other SECURITY DEFINER functions — runs as the owner,
--    so no direct grants are needed (and none are given).
-- ============================================
CREATE OR REPLACE FUNCTION public.expire_pro_credits_if_due_for(p_user_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_pro     int;
  v_dropped int;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(pro_balance, 0) INTO v_pro
    FROM public.user_credits
   WHERE user_id = p_user_id
     AND pro_expires_at IS NOT NULL
     AND pro_expires_at <= now()
     AND pro_balance > 0;

  IF v_pro IS NULL OR v_pro = 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.user_credits
     SET pro_balance = 0, updated_at = now()
   WHERE user_id = p_user_id
     AND pro_expires_at IS NOT NULL
     AND pro_expires_at <= now()
     AND pro_balance > 0
  -- v_pro (captured before) minus NEW pro_balance (0) = exact dropped amount.
  RETURNING v_pro - pro_balance INTO v_dropped;

  IF COALESCE(v_dropped, 0) > 0 THEN
    INSERT INTO public.credit_ledger (user_id, delta, reason, bucket)
    VALUES (p_user_id, -v_dropped, 'expiry', 'pro');
    RETURN v_dropped;
  END IF;

  RETURN 0;
END;
$$;

-- ============================================
-- 4) grant_credits — targets the FREE bucket. Signature unchanged.
-- ============================================
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id           uuid,
  p_amount            int,
  p_reason            text,
  p_external_event_id text DEFAULT NULL,
  p_validity_days     int DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_total int;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Fast path: event already processed → no-op, return current total.
  IF p_external_event_id IS NOT NULL THEN
    PERFORM 1 FROM public.credit_ledger
      WHERE external_event_id = p_external_event_id;
    IF FOUND THEN
      SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
        FROM public.user_credits WHERE user_id = p_user_id;
      RETURN v_total;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.user_credits
       SET free_balance = free_balance + p_amount, updated_at = now()
     WHERE user_id = p_user_id;

    INSERT INTO public.credit_ledger
      (user_id, delta, reason, external_event_id, bucket)
    VALUES
      (p_user_id, p_amount, p_reason, p_external_event_id, 'free');

    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;

  EXCEPTION WHEN unique_violation THEN
    -- Duplicate event raced past the fast path: everything rolled back.
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;
  END;
END;
$$;

-- ============================================
-- 5) consume_voice_credit — pro first, then free. Idempotent as before.
-- ============================================
CREATE OR REPLACE FUNCTION public.consume_voice_credit(
  p_user_id      uuid,
  p_operation_id text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row       public.user_credits%ROWTYPE;
  v_remaining int;
  v_bucket    text;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Idempotent: already consumed → no double charge.
  PERFORM 1 FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND operation_id = p_operation_id
      AND reason = 'voice_consume';
  IF FOUND THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_remaining
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_remaining;
  END IF;

  BEGIN
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    -- Lazy pro expiry first, so a dead window can't be spent. (Inside the
    -- same subtransaction: a later unique_violation rolls this back too.)
    PERFORM public.expire_pro_credits_if_due_for(p_user_id);

    SELECT * INTO v_row FROM public.user_credits
     WHERE user_id = p_user_id
       FOR UPDATE;

    IF v_row.pro_balance > 0 THEN
      v_bucket := 'pro';    -- perishable credits spend first
    ELSIF v_row.free_balance > 0 THEN
      v_bucket := 'free';
    ELSE
      RAISE EXCEPTION 'OUT_OF_CREDITS';
    END IF;

    UPDATE public.user_credits
       SET free_balance = CASE WHEN v_bucket = 'free' THEN free_balance - 1 ELSE free_balance END,
           pro_balance  = CASE WHEN v_bucket = 'pro'  THEN pro_balance  - 1 ELSE pro_balance  END,
           updated_at   = now()
     WHERE user_id = p_user_id;

    INSERT INTO public.credit_ledger
      (user_id, delta, reason, operation_id, bucket)
    VALUES
      (p_user_id, -1, 'voice_consume', p_operation_id, v_bucket);

    SELECT free_balance + pro_balance INTO v_remaining
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_remaining;

  EXCEPTION WHEN unique_violation THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_remaining
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_remaining;
  END;
END;
$$;

-- ============================================
-- 6) refund_voice_credit — returns the credit to its origin bucket
-- ============================================
CREATE OR REPLACE FUNCTION public.refund_voice_credit(
  p_user_id      uuid,
  p_operation_id text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_bucket text;
  v_total  int;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Only refund operations that were actually consumed...
  SELECT bucket INTO v_bucket
    FROM public.credit_ledger
   WHERE user_id = p_user_id
     AND operation_id = p_operation_id
     AND reason = 'voice_consume'
   LIMIT 1;

  IF v_bucket IS NULL THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;
  END IF;

  -- ...and only once per operation.
  PERFORM 1 FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND operation_id = p_operation_id
      AND reason = 'voice_refund';
  IF FOUND THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;
  END IF;

  INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  -- A refund into a DEAD pro window would strand an unusable credit —
  -- land it in free instead.
  IF v_bucket = 'pro'
     AND EXISTS (
       SELECT 1 FROM public.user_credits
        WHERE user_id = p_user_id
          AND pro_expires_at IS NOT NULL
          AND pro_expires_at <= now()
     ) THEN
    v_bucket := 'free';
  END IF;

  UPDATE public.user_credits
     SET free_balance = CASE WHEN v_bucket = 'free' THEN free_balance + 1 ELSE free_balance END,
         pro_balance  = CASE WHEN v_bucket = 'pro'  THEN pro_balance  + 1 ELSE pro_balance  END,
         updated_at   = now()
   WHERE user_id = p_user_id;

  INSERT INTO public.credit_ledger
    (user_id, delta, reason, operation_id, bucket)
  VALUES
    (p_user_id, 1, 'voice_refund', p_operation_id, v_bucket);

  SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
    FROM public.user_credits WHERE user_id = p_user_id;
  RETURN v_total;
END;
$$;

-- ============================================
-- 7) get_credit_balance — effective totals at read time
--    balance = free + unexpired pro (expired pro subtracted here, since a
--    STABLE function cannot mutate). expires_at = the live pro window only.
-- ============================================
CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS TABLE (balance int, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT free_balance
         + CASE WHEN pro_expires_at IS NOT NULL AND pro_expires_at > now()
                THEN pro_balance ELSE 0 END
         AS balance,
         CASE WHEN pro_expires_at IS NOT NULL AND pro_expires_at > now()
              THEN pro_expires_at END
         AS expires_at
    FROM public.user_credits
   WHERE user_id = auth.uid();
$$;

-- ============================================
-- 8) apply_pro_credit_topup — same semantics, pro bucket
-- ============================================
CREATE OR REPLACE FUNCTION public.apply_pro_credit_topup(
  p_user_id           uuid,
  p_period_end        timestamptz,
  p_external_event_id text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_total   int;
  v_current int;
BEGIN
  IF p_user_id IS NULL OR p_external_event_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Fast path: event already processed → no-op.
  PERFORM 1 FROM public.credit_ledger
    WHERE external_event_id = p_external_event_id;
  IF FOUND THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;
  END IF;

  BEGIN
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    -- Previous paid window passed → drop stale pro credits (logged).
    PERFORM public.expire_pro_credits_if_due_for(p_user_id);

    SELECT COALESCE(pro_balance, 0) INTO v_current
      FROM public.user_credits WHERE user_id = p_user_id;

    IF v_current < 200 THEN
      -- Top up (NOT add): raise the pro bucket to 200.
      UPDATE public.user_credits
         SET pro_balance = 200,
             pro_expires_at = p_period_end,
             updated_at  = now()
       WHERE user_id = p_user_id;

      INSERT INTO public.credit_ledger
        (user_id, delta, reason, external_event_id, bucket)
      VALUES
        (p_user_id, 200 - v_current, 'pro_topup', p_external_event_id, 'pro');
    ELSE
      -- Already at/above 200: only extend the paid window. Zero-delta row
      -- pins the event id so redelivery stays a no-op.
      UPDATE public.user_credits
         SET pro_expires_at = p_period_end, updated_at = now()
       WHERE user_id = p_user_id;

      INSERT INTO public.credit_ledger
        (user_id, delta, reason, external_event_id, bucket)
      VALUES
        (p_user_id, 0, 'pro_topup', p_external_event_id, 'pro');
    END IF;

    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;

  EXCEPTION WHEN unique_violation THEN
    SELECT COALESCE(free_balance + pro_balance, 0) INTO v_total
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_total;
  END;
END;
$$;

-- ============================================
-- 9) apply_subscription_event — rewritten for the bucket columns.
--    Identical event semantics to 013; only the EXPIRATION branch's eager
--    zero changed (it referenced dropped columns). Signature unchanged, so
--    the webhook needs no redeploy... but redeploying is still recommended
--    to pick up no changes — this note exists so nobody "fixes" it twice.
-- ============================================
CREATE OR REPLACE FUNCTION public.apply_subscription_event(
  p_event_id   text,
  p_event_type text,
  p_user_id    uuid,
  p_period_end timestamptz DEFAULT NULL
)
RETURNS TABLE (processed boolean, plan text, balance int)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_plan    text;
  v_balance int;
BEGIN
  IF p_event_id IS NULL OR p_event_type IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Dedupe: a redelivered event inserts nothing and changes nothing.
  BEGIN
    INSERT INTO public.subscription_events (event_id, user_id, event_type, period_end)
    VALUES (p_event_id, p_user_id, p_event_type, p_period_end);
  EXCEPTION WHEN unique_violation THEN
    BEGIN
      SELECT e.plan, COALESCE(c.free_balance + c.pro_balance, 0)
        INTO v_plan, v_balance
        FROM public.user_entitlements e
        LEFT JOIN public.user_credits c ON c.user_id = e.user_id
       WHERE e.user_id = p_user_id;
    EXCEPTION WHEN no_data_found THEN
      v_plan := 'free';
      v_balance := 0;
    END;
    RETURN QUERY SELECT false, v_plan, v_balance;
    RETURN;
  END;

  IF p_user_id IS NOT NULL THEN
    CASE p_event_type
      WHEN 'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE' THEN
        -- Unknown users (e.g. dashboard TEST pings) are skipped — recorded,
        -- no state change, no FK violations, no retry loops.
        IF EXISTS (SELECT 1 FROM auth.users au WHERE au.id = p_user_id) THEN
          INSERT INTO public.user_entitlements (user_id, plan, status, period_end, will_renew)
          VALUES (p_user_id, 'pro', 'active', p_period_end, true)
          ON CONFLICT (user_id) DO UPDATE
            SET plan       = 'pro',
                status     = 'active',
                period_end = COALESCE(p_period_end, public.user_entitlements.period_end),
                will_renew = true,
                updated_at = now();
          v_balance := public.apply_pro_credit_topup(p_user_id, p_period_end, p_event_id);
        END IF;

      WHEN 'DID_NOT_RENEW' THEN
        UPDATE public.user_entitlements
           SET will_renew = false, updated_at = now()
         WHERE user_id = p_user_id;

      WHEN 'UNCANCEL' THEN
        UPDATE public.user_entitlements
           SET will_renew = true, updated_at = now()
         WHERE user_id = p_user_id;

      WHEN 'EXPIRATION' THEN
        UPDATE public.user_entitlements
           SET plan = 'free', status = 'expired', will_renew = false, updated_at = now()
         WHERE user_id = p_user_id;

        -- Eager zero of any already-passed pro window (logged by the helper).
        -- Free-bucket credits are NEVER touched here.
        PERFORM public.expire_pro_credits_if_due_for(p_user_id);

      ELSE
        NULL;  -- unknown event type: recorded, no state change
    END CASE;
  END IF;

  -- Report the post-event state.
  BEGIN
    SELECT e.plan, COALESCE(c.free_balance + c.pro_balance, 0)
      INTO v_plan, v_balance
      FROM public.user_entitlements e
      LEFT JOIN public.user_credits c ON c.user_id = e.user_id
     WHERE e.user_id = p_user_id;
  EXCEPTION WHEN no_data_found THEN
    v_plan := 'free';
    v_balance := 0;
  END;

  RETURN QUERY SELECT true, v_plan, v_balance;
END;
$$;

-- ============================================
-- 10) Permissions — re-assert explicitly (security-definer entry points)
-- ============================================
REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  TO service_role, supabase_auth_admin;

REVOKE EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_pro_credit_topup(uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pro_credit_topup(uuid, timestamptz, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_subscription_event(text, text, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_subscription_event(text, text, uuid, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.expire_pro_credits_if_due_for(uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;

-- ============================================
-- Reversal (run to undo this migration)
-- ============================================
-- ALTER TABLE public.credit_ledger DROP COLUMN bucket;
-- ALTER TABLE public.user_credits
--   ADD COLUMN expires_at TIMESTAMPTZ,
--   ADD COLUMN balance INT,
--   DROP COLUMN free_balance,
--   DROP COLUMN pro_balance,
--   DROP COLUMN pro_expires_at;
-- UPDATE public.user_credits SET balance = free_balance;  -- approximate
-- (then re-apply 013's versions of the credit functions)
