-- Packly Database Migration
-- Version: 013
-- Description: Free / Pro subscription entitlements (RevenueCat-driven).
--
--   Plans:
--     FREE — 5 one-time signup credits that NEVER expire, 0 photo uploads
--     PRO  — $5/mo, monthly: credits topped UP to 200 (never added on top)
--            at purchase and at each renewal; credits expire at subscription
--            period end; up to 3 photos per box
--
--   Realtime sync, boxes, moves, items: identical for both plans (not gated).
--
-- Design (server-authoritative, same philosophy as 010):
--   • user_entitlements   — plan + paid period per user, written ONLY by the
--                           webhook RPC below; clients read their own row
--   • subscription_events — log of RevenueCat events, PRIMARY KEY = event id,
--                           so a redelivered webhook is an exact no-op
--   • apply_subscription_event — the single entry point the RevenueCat
--                           webhook calls (service role only, idempotent)
--   • apply_pro_credit_topup   — balance := max(balance, 200), expiry moved
--                           to the paid period end (idempotent by event id)
--   • Photo gating at the DB: INSERT into box_photos requires the MOVE OWNER
--                           to hold active Pro (family model — members of a
--                           Pro owner's move can add photos). DELETE and
--                           SELECT stay allowed for everyone; existing photos
--                           are never touched retroactively.
--   • Free credits: signup grant changes from 30-day validity to never
--                           expiring; existing balances are un-expired.
--
-- Expiry model after this migration:
--   • Free credits: expires_at = NULL → the lazy-expiry blocks in
--     grant/consume/refund never touch them (they only act when
--     expires_at IS NOT NULL AND has passed).
--   • Pro credits: expires_at = subscription period end (set by the webhook).
--     The existing lazy-expiry machinery zeroes the balance at that instant
--     (logged to credit_ledger), even if the EXPIRATION webhook is delayed.
--
-- Security:
--   • Clients can only SELECT their own entitlement row.
--   • subscription_events is deny-all to clients (RLS, no policies);
--     only the service role (webhook) touches it.
--   • apply_subscription_event / apply_pro_credit_topup: service_role only.

-- ============================================
-- 1) Table: user_entitlements (plan + paid period)
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_entitlements (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan       TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  period_end TIMESTAMPTZ,                -- end of the current paid period
  will_renew BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own entitlement" ON public.user_entitlements;
CREATE POLICY "Users can read own entitlement"
  ON public.user_entitlements FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON public.user_entitlements TO authenticated;

-- ============================================
-- 2) Table: subscription_events (webhook dedupe + audit)
--    PK = RevenueCat event id → redelivery can never double-apply.
--    RLS enabled with NO policies: invisible to clients, service role only.
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscription_events (
  event_id   TEXT PRIMARY KEY,
  user_id    UUID,
  event_type TEXT NOT NULL,
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 3) apply_pro_credit_topup — IDEMPOTENT by external_event_id
--
--    Top-up semantics (NOT add): balance < 200 → raised to 200;
--    balance >= 200 → untouched (only the expiry window moves).
--    The paid period end becomes the credit expiry. A repeated event id
--    is a no-op (same fast-path + unique-violation-rollback pattern as
--    grant_credits). Service role only.
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
  v_balance int;
  v_current int;
  v_expired int;
BEGIN
  IF p_user_id IS NULL OR p_external_event_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Fast path: event already processed → no-op.
  PERFORM 1 FROM public.credit_ledger
    WHERE external_event_id = p_external_event_id;
  IF FOUND THEN
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  BEGIN
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    -- Pro window from a previous period passed → balance drops to 0 first
    -- (logged, so SUM(ledger.delta) === balance keeps holding).
    UPDATE public.user_credits
      SET balance = 0, updated_at = now()
      WHERE user_id = p_user_id
        AND expires_at IS NOT NULL AND expires_at <= now()
        AND balance > 0
    RETURNING balance INTO v_expired;

    IF v_expired > 0 THEN
      INSERT INTO public.credit_ledger (user_id, delta, reason)
      VALUES (p_user_id, -v_expired, 'expiry');
    END IF;

    SELECT COALESCE(balance, 0) INTO v_current
      FROM public.user_credits WHERE user_id = p_user_id;

    IF v_current < 200 THEN
      UPDATE public.user_credits
        SET balance    = 200,
            expires_at = p_period_end,   -- NULL → never expires (documented)
            updated_at = now()
        WHERE user_id = p_user_id
      RETURNING balance INTO v_balance;

      INSERT INTO public.credit_ledger (user_id, delta, reason, external_event_id)
      VALUES (p_user_id, 200 - v_current, 'pro_topup', p_external_event_id);
    ELSE
      -- Already at/above 200: only extend the paid window. A zero-delta
      -- ledger row pins the event id so redelivery stays a no-op here too.
      UPDATE public.user_credits
        SET expires_at = p_period_end, updated_at = now()
        WHERE user_id = p_user_id;
      v_balance := v_current;

      INSERT INTO public.credit_ledger (user_id, delta, reason, external_event_id)
      VALUES (p_user_id, 0, 'pro_topup', p_external_event_id);
    END IF;

    RETURN v_balance;

  EXCEPTION WHEN unique_violation THEN
    -- Concurrent delivery of the same event: everything above rolled back.
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END;
END;
$$;

-- ============================================
-- 4) apply_subscription_event — the webhook entry point
--
--    Called ONLY by the RevenueCat webhook Edge Function (service role).
--    p_event_id must be RevenueCat's unique event id.
--
--    Event handling:
--      INITIAL_PURCHASE / RENEWAL / PRODUCT_CHANGE → plan=pro, period moved,
--          credits topped up to 200 (idempotent by event id)
--      DID_NOT_RENEW  → will_renew=false (plan + credits unchanged until end)
--      UNCANCEL       → will_renew=true
--      EXPIRATION     → plan=free; if the paid window already passed, the
--          remaining balance is zeroed eagerly (logged to the ledger). If the
--          event arrives early, the lazy expiry still zeroes at period end.
--      anything else  → recorded, no state change
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
  v_dropped int;
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
      SELECT e.plan, COALESCE(c.balance, 0)
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
        -- Guard: RevenueCat can deliver UUID-shaped app_user_ids that are not
        -- real auth users (dashboard TEST pings use random ids). Unknown
        -- users are skipped — the event stays recorded, no state changes,
        -- no FK violations, no webhook retry loops.
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

        -- Eager zero only if the paid window truly passed; otherwise the
        -- lazy expiry in consume/read handles it at the right instant.
        UPDATE public.user_credits
          SET balance = 0, updated_at = now()
          WHERE user_id = p_user_id
            AND balance > 0
            AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING balance INTO v_dropped;

        IF v_dropped > 0 THEN
          INSERT INTO public.credit_ledger (user_id, delta, reason)
          VALUES (p_user_id, -v_dropped, 'expiry');
        END IF;

      ELSE
        NULL;  -- unknown event type: recorded, no state change
    END CASE;
  END IF;

  -- Report the post-event state.
  BEGIN
    SELECT e.plan, COALESCE(c.balance, 0)
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
-- 5) Free credits never expire
-- ============================================

-- 5a) grant_credits: p_validity_days NULL now means "never expires".
--     (Same function identity — only the default changes — so ACLs persist,
--     but they are re-granted below for safety.)
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id           uuid,
  p_amount            int,
  p_reason            text,
  p_external_event_id text DEFAULT NULL,
  p_validity_days     int DEFAULT NULL   -- NULL = never expires
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_balance int;
  v_expired int;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- Fast path: event already processed → no-op, return current balance.
  IF p_external_event_id IS NOT NULL THEN
    PERFORM 1 FROM public.credit_ledger
      WHERE external_event_id = p_external_event_id;
    IF FOUND THEN
      SELECT COALESCE(balance, 0) INTO v_balance
        FROM public.user_credits WHERE user_id = p_user_id;
      RETURN v_balance;
    END IF;
  END IF;

  BEGIN
    -- Ensure the row exists, locked for the update below.
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    -- Expired credits drop to 0 before the new grant is added.
    -- (Never-expiring balances have expires_at IS NULL and pass untouched.)
    UPDATE public.user_credits
      SET balance = 0, updated_at = now()
      WHERE user_id = p_user_id
        AND expires_at IS NOT NULL AND expires_at <= now()
        AND balance > 0
    RETURNING balance INTO v_expired;

    IF v_expired > 0 THEN
      INSERT INTO public.credit_ledger (user_id, delta, reason)
      VALUES (p_user_id, -v_expired, 'expiry');
    END IF;

    UPDATE public.user_credits
      SET balance    = balance + p_amount,
          expires_at = CASE
            WHEN p_validity_days IS NULL THEN NULL
            ELSE now() + make_interval(days => p_validity_days)
          END,
          updated_at = now()
      WHERE user_id = p_user_id
    RETURNING balance INTO v_balance;

    INSERT INTO public.credit_ledger (user_id, delta, reason, external_event_id)
    VALUES (p_user_id, p_amount, p_reason, p_external_event_id);

    RETURN v_balance;

  EXCEPTION WHEN unique_violation THEN
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END;
END;
$$;

-- 5b) Signup trigger: 5 free credits, never expiring.
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public.grant_credits(
    NEW.id, 5, 'signup_grant', 'signup:' || NEW.id::text, NULL
  );
  RETURN NEW;
END;
$$;

-- 5c) Un-expire existing balances (every current user is free-tier; Pro
--     expiry comes from the webhook and did not exist before this point).
UPDATE public.user_credits
  SET expires_at = NULL
  WHERE expires_at IS NOT NULL;

-- 5d) refund_voice_credit: NULL-safe expiry handling. The 010 version set
--      expires_at = now() + 1 day whenever expires_at WAS NULL — harmless
--      under 010 (expires_at was always set) but under never-expiring free
--      credits a refund would put a 1-day limit on the whole balance.
--      Only a genuinely EXPIRED window gets the 1-day grace now; a NULL
--      (never-expiring) balance stays NULL. All idempotency logic unchanged.
CREATE OR REPLACE FUNCTION public.refund_voice_credit(
  p_user_id      uuid,
  p_operation_id text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_balance int;
  v_expired int;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Only refund operations that were actually consumed.
  PERFORM 1 FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND operation_id = p_operation_id
      AND reason = 'voice_consume';
  IF NOT FOUND THEN
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  -- ...and only once per operation.
  PERFORM 1 FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND operation_id = p_operation_id
      AND reason = 'voice_refund';
  IF FOUND THEN
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  -- Expired balance drops to 0 before refunding, so the refunded credit
  -- can't resurrect expired credits. Logged to keep the ledger consistent.
  UPDATE public.user_credits
    SET balance = 0, updated_at = now()
    WHERE user_id = p_user_id
      AND expires_at IS NOT NULL AND expires_at <= now()
      AND balance > 0
  RETURNING balance INTO v_expired;

  IF v_expired > 0 THEN
    INSERT INTO public.credit_ledger (user_id, delta, reason)
    VALUES (p_user_id, -v_expired, 'expiry');
  END IF;

  UPDATE public.user_credits
    SET balance    = balance + 1,
        -- Only a genuinely EXPIRED window gets a 1-day grace so the refunded
        -- credit is usable. NULL (never-expiring) balances stay untouched.
        expires_at = CASE
          WHEN expires_at IS NOT NULL AND expires_at <= now()
            THEN now() + interval '1 day'
          ELSE expires_at
        END,
        updated_at = now()
    WHERE user_id = p_user_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.credit_ledger (user_id, delta, reason, operation_id)
  VALUES (p_user_id, 1, 'voice_refund', p_operation_id);

  RETURN v_balance;
END;
$$;

-- refund keeps its 010 ACLs (same signature); re-assert for safety.
GRANT EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text)
  TO service_role;

-- ============================================
-- 6) Photo gating: INSERT requires the MOVE OWNER to hold active Pro
--
--    • Family model: any member of a move owned by a Pro subscriber can add
--      photos; the free-tier check is on the move owner, not the uploader.
--    • DELETE and SELECT are untouched — free users keep deleting and viewing
--      existing photos forever (locked decision).
--    • Applied on INSERT only — never retroactive, nothing is ever deleted.
--    • The existing max-3-per-box limit is unchanged (and now only Pro users
--      can fill those 3 slots).
-- ============================================
CREATE OR REPLACE FUNCTION public.enforce_box_photo_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  photo_count INT;
  v_owner     UUID;
BEGIN
  PERFORM 1 FROM public.boxes WHERE id = NEW.box_id FOR UPDATE;
  SELECT COUNT(*) INTO photo_count FROM public.box_photos WHERE box_id = NEW.box_id;
  -- Deterministic ordering: the slot is assigned while the box row is locked,
  -- so concurrent inserts can never produce duplicate sort_order values.
  NEW.sort_order := photo_count;
  IF photo_count >= 3 THEN
    RAISE EXCEPTION 'MAX_PHOTOS_PER_BOX';
  END IF;

  -- Free/Pro gate: the move owner must hold an active Pro period.
  -- (period_end is deny-by-default: no entitlement row, or a Pro row whose
  -- period_end has passed and the webhook hasn't landed yet → blocked.
  -- Once period_end passes, lazy checks everywhere treat the user as free.)
  SELECT m.owner_id INTO v_owner
    FROM public.boxes b
    JOIN public.rooms r ON r.id = b.room_id
    JOIN public.moves  m ON m.id = r.move_id
   WHERE b.id = NEW.box_id;

  PERFORM 1
    FROM public.user_entitlements e
   WHERE e.user_id = v_owner
     AND e.plan = 'pro'
     AND e.period_end > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PHOTOS_REQUIRE_PRO';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_box_photo_limit_trigger ON public.box_photos;
CREATE TRIGGER enforce_box_photo_limit_trigger
  BEFORE INSERT ON public.box_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_box_photo_limit();

-- ============================================
-- 7) Permissions
--    Clients: read own entitlement row only (policy above).
--    Service role (RevenueCat webhook): apply_subscription_event,
--    apply_pro_credit_topup. Credit functions keep their 010 grants.
-- ============================================
REVOKE EXECUTE ON FUNCTION public.apply_subscription_event(text, text, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_subscription_event(text, text, uuid, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_pro_credit_topup(uuid, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pro_credit_topup(uuid, timestamptz, text)
  TO service_role;

-- grant_credits identity is unchanged; re-assert 010's grants after the
-- CREATE OR REPLACE above (belt and suspenders — ACLs normally persist).
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  TO service_role, supabase_auth_admin;

-- ============================================
-- Reversal (run to undo this migration)
-- ============================================
-- DROP TRIGGER IF EXISTS enforce_box_photo_limit_trigger ON public.box_photos;
-- (then re-run the 009 version of enforce_box_photo_limit to restore the
--  non-plan-aware 3-photo limit)
-- DROP FUNCTION IF EXISTS public.apply_subscription_event(text, text, uuid, timestamptz);
-- DROP FUNCTION IF EXISTS public.apply_pro_credit_topup(uuid, timestamptz, text);
-- DROP TABLE IF EXISTS public.subscription_events;
-- DROP TABLE IF EXISTS public.user_entitlements;
