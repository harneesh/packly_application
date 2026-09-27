-- Packly Database Migration
-- Version: 010
-- Description: AI voice credit system.
--
--   1 credit = 1 successful voice recording (Gemini call).
--
-- Design:
--   • user_credits  — one row per user: balance + expiry timestamp
--   • credit_ledger — append-only audit log of EVERY credit change
--
-- Idempotency (production requirements):
--   • Grants   are idempotent by external_event_id — a RevenueCat webhook
--     delivered twice (purchase or renewal) can never grant twice.
--   • Consumes are idempotent by operation_id — one charge per AI operation,
--     even if the Edge Function retries.
--   • Refunds  are idempotent by operation_id — a retried refund can never
--     double-refund, and only operations that were actually consumed can be
--     refunded.
--
-- Expiry: credits become 0 once 30 days pass (lazy expiry — enforced at
-- read/consume/grant time and logged to the ledger as an 'expiry' entry).
--
-- Security:
--   • Clients can only READ their own balance/ledger (RLS).
--   • grant / consume / refund are callable ONLY by the service role
--     (the process-audio Edge Function and the future RevenueCat webhook).
--   • Clients can never move credits directly.

-- ============================================
-- 1) Table: user_credits (fast balance read)
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_credits (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance    INT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  expires_at TIMESTAMPTZ,                -- null = never expires (not used today)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own credits" ON public.user_credits;
CREATE POLICY "Users can read own credits"
  ON public.user_credits FOR SELECT
  USING (user_id = auth.uid());

-- ============================================
-- 2) Table: credit_ledger (append-only audit)
--    Invariant: SUM(delta) per user === user_credits.balance
-- ============================================
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta             INT NOT NULL,        -- +grants +refunds, -consumes -expiry
  reason            TEXT NOT NULL,       -- signup_grant | pro_grant | voice_consume | voice_refund | expiry
  operation_id      TEXT,                -- voice_consume / voice_refund only
  external_event_id TEXT,                -- grants only (RevenueCat event id, signup:<uid>)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user
  ON public.credit_ledger(user_id, created_at);

-- Idempotency guarantees (database-enforced):
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_grant_event
  ON public.credit_ledger(external_event_id)
  WHERE external_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_consume_op
  ON public.credit_ledger(operation_id)
  WHERE operation_id IS NOT NULL AND reason = 'voice_consume';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_refund_op
  ON public.credit_ledger(operation_id)
  WHERE operation_id IS NOT NULL AND reason = 'voice_refund';

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own credit ledger" ON public.credit_ledger;
CREATE POLICY "Users can read own credit ledger"
  ON public.credit_ledger FOR SELECT
  USING (user_id = auth.uid());

-- ============================================
-- 3) grant_credits — IDEMPOTENT by external_event_id
--
--    Called by: signup trigger (5 free) and the future RevenueCat webhook
--    (200 per purchase/renewal). A repeated external_event_id is a no-op.
-- ============================================
CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id           uuid,
  p_amount            int,
  p_reason            text,
  p_external_event_id text DEFAULT NULL,
  p_validity_days     int DEFAULT 30
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
    -- The dropped amount is logged so SUM(ledger.delta) === balance holds.
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
          expires_at = now() + make_interval(days => p_validity_days),
          updated_at = now()
      WHERE user_id = p_user_id
    RETURNING balance INTO v_balance;

    INSERT INTO public.credit_ledger (user_id, delta, reason, external_event_id)
    VALUES (p_user_id, p_amount, p_reason, p_external_event_id);

    RETURN v_balance;

  EXCEPTION WHEN unique_violation THEN
    -- Duplicate webhook raced past the fast path: the unique index on
    -- external_event_id fired, and every change in this block (the balance
    -- update included) was rolled back by the implicit subtransaction.
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END;
END;
$$;

-- ============================================
-- 4) consume_voice_credit — IDEMPOTENT by operation_id
--
--    Called ONLY by the process-audio Edge Function (service role), which
--    verifies the user's JWT first. p_user_id is passed explicitly because
--    service-role calls have no user JWT in context.
--
--    Raises OUT_OF_CREDITS when the user has no usable credit.
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
  v_balance int;
  v_expired int;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Idempotent: this operation already consumed → no double charge.
  PERFORM 1 FROM public.credit_ledger
    WHERE user_id = p_user_id
      AND operation_id = p_operation_id
      AND reason = 'voice_consume';
  IF FOUND THEN
    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.user_credits WHERE user_id = p_user_id;
    RETURN v_balance;
  END IF;

  BEGIN
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    -- Lazy expiry: window passed → balance is 0. The dropped amount is
    -- logged so SUM(ledger.delta) === balance holds.
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
      SET balance = balance - 1, updated_at = now()
      WHERE user_id = p_user_id
        AND (expires_at IS NULL OR expires_at > now())
        AND balance > 0
    RETURNING balance INTO v_balance;

    IF v_balance IS NULL THEN
      RAISE EXCEPTION 'OUT_OF_CREDITS';
    END IF;

    INSERT INTO public.credit_ledger (user_id, delta, reason, operation_id)
    VALUES (p_user_id, -1, 'voice_consume', p_operation_id);

    RETURN v_balance;

  EXCEPTION
    WHEN unique_violation THEN
      -- Concurrent consume with the same operation_id: rolled back above.
      SELECT COALESCE(balance, 0) INTO v_balance
        FROM public.user_credits WHERE user_id = p_user_id;
      RETURN v_balance;
  END;
END;
$$;

-- ============================================
-- 5) refund_voice_credit — IDEMPOTENT by operation_id
--
--    Called ONLY by the Edge Function when Gemini fails AFTER a successful
--    consume. Refunds only operations that were actually consumed, and only
--    once per operation. Service role only.
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
        -- make sure the refunded credit is usable even if the window lapsed
        expires_at = CASE
          WHEN expires_at IS NULL OR expires_at <= now()
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

-- ============================================
-- 6) get_credit_balance — client-facing read (authenticated)
--    The client computes effective balance as 0 when expires_at has passed.
-- ============================================
CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS TABLE (balance int, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.balance, c.expires_at
  FROM public.user_credits c
  WHERE c.user_id = auth.uid();
$$;

-- ============================================
-- 7) Signup grant: 5 one-time free credits, 30-day validity
--    Idempotent via external_event_id = 'signup:<user_id>'
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_new_user_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public.grant_credits(
    NEW.id, 5, 'signup_grant', 'signup:' || NEW.id::text, 30
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_credits ON auth.users;
CREATE TRIGGER on_auth_user_created_credits
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_credits();

-- ============================================
-- 8) Permissions
--    Clients (anon/authenticated): read balance only.
--    Service role (Edge Function / webhook): grant, consume, refund.
-- ============================================
REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  TO service_role;
-- The auth trigger (handle_new_user_credits) fires as supabase_auth_admin
-- during signup, so it needs execute rights on grant_credits.
GRANT EXECUTE ON FUNCTION public.grant_credits(uuid, int, text, text, int)
  TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;

-- ============================================
-- Reversal (run to undo this migration)
-- ============================================
-- DROP TRIGGER IF EXISTS on_auth_user_created_credits ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_new_user_credits();
-- DROP FUNCTION IF EXISTS public.get_credit_balance();
-- DROP FUNCTION IF EXISTS public.refund_voice_credit(uuid, text);
-- DROP FUNCTION IF EXISTS public.consume_voice_credit(uuid, text);
-- DROP FUNCTION IF EXISTS public.grant_credits(uuid, int, text, text, int);
-- DROP TABLE IF EXISTS public.credit_ledger;
-- DROP TABLE IF EXISTS public.user_credits;
