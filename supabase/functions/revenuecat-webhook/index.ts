/**
 * Packly — RevenueCat Webhook Edge Function
 *
 * Purpose:
 *   Receives subscription lifecycle events from RevenueCat (Google Play
 *   Billing) and applies them server-authoritatively via the
 *   apply_subscription_event() RPC (migration 013).
 *
 * Flow:
 *   RevenueCat → (Authorization: Bearer <secret>) → this function →
 *   apply_subscription_event RPC → user_entitlements + user_credits updated
 *
 * Security:
 *   - Every request must carry `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`
 *     (set in both the RevenueCat dashboard and the Supabase Edge Function
 *     secrets). Requests without the exact secret are rejected with 401.
 *   - The function itself is deployed with "Verify JWT" DISABLED, because
 *     RevenueCat cannot send a Supabase JWT — the shared secret IS the auth.
 *   - The RPC is locked to the service role; clients can never grant Pro.
 *   - `TEST` events from the RevenueCat dashboard are accepted WITHOUT the
 *     secret (RevenueCat does not sign them) and only recorded.
 *
 * Idempotency:
 *   - `subscription_events` PK = RevenueCat event id → a redelivered event
 *     changes nothing (the RPC reports processed=false).
 *   - Any error AFTER a passed secret check returns 5xx so RevenueCat
 *     retries; retries are safe because of the dedupe above.
 *
 * Response format:
 *   { "success": true,  "processed": true|false, "plan": "free"|"pro", "balance": 123 }
 *   { "success": false, "error": "Description", "code": "..." }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
// Shared secret — set in Supabase Edge Function secrets AND in the
// RevenueCat dashboard webhook config (Authorization header).
const REVENUECAT_WEBHOOK_SECRET = Deno.env.get('REVENUECAT_WEBHOOK_SECRET') ?? ''

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ──────────────────────────────────────────
// Event mapping: RevenueCat type → RPC type (013's CASE labels)
//   • DID_RENEW is RevenueCat's CURRENT renewal event (RENEWAL is the
//     legacy alias) — both must become a pro grant + top-up.
//   • SUBSCRIPTION_EXTENDED pushes the period out → same as a renewal.
//   • Unknown types pass through and are merely recorded by the RPC.
// ──────────────────────────────────────────
const RPC_EVENT_TYPE: Record<string, string> = {
  INITIAL_PURCHASE: 'INITIAL_PURCHASE',
  RENEWAL: 'RENEWAL', // legacy alias
  DID_RENEW: 'RENEWAL', // current renewal event type
  SUBSCRIPTION_EXTENDED: 'RENEWAL',
  PRODUCT_CHANGE: 'PRODUCT_CHANGE',
  CANCELLATION: 'DID_NOT_RENEW', // auto-renew off; Pro stays until period end
  DID_NOT_RENEW: 'DID_NOT_RENEW',
  UNCANCELLATION: 'UNCANCEL',
  UNCANCEL: 'UNCANCEL',
  EXPIRATION: 'EXPIRATION',
}

interface RcEvent {
  type?: string
  id?: string
  app_user_id?: string
  expiration_at_ms?: number | null
  environment?: string
  [key: string]: unknown
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Process one RevenueCat event.
 * Returns { processed, plan, balance } from the RPC, or skips with null.
 */
async function processEvent(
  supabase: ReturnType<typeof createClient>,
  event: RcEvent,
): Promise<{ processed: boolean; plan: string | null; balance: number | null } | null> {
  const eventType = event.type ?? ''
  const eventId = event.id
  const rawUserId = event.app_user_id
  const environment = event.environment ?? 'UNKNOWN'

  // A payload without an event id cannot be deduped safely → record-and-skip
  // (returning success stops RevenueCat from retrying it forever).
  if (!eventId) {
    console.warn(`[revenuecat] event without id (type=${eventType}) — skipped`)
    return null
  }

  // expiration_at_ms → ISO timestamp for the RPC (null if absent).
  const periodEnd =
    typeof event.expiration_at_ms === 'number' && event.expiration_at_ms > 0
      ? new Date(event.expiration_at_ms).toISOString()
      : null

  // The app user id must be the Supabase auth user id (a UUID). Anything
  // else (e.g. "$RCAnonymousID:...") is recorded for audit and NOT applied —
  // returning success stops RevenueCat from retrying a hopeless event.
  const userId = rawUserId && UUID_RE.test(rawUserId) ? rawUserId : null

  if (!userId) {
    console.log(`[revenuecat] event ${eventId} (${eventType}): app_user_id is not a UUID — recorded only`)
  }

  console.log(
    `[revenuecat] event=${eventId} type=${eventType} env=${environment} user=${userId ?? 'n/a'} periodEnd=${periodEnd ?? 'n/a'}`,
  )

  const { data, error } = await supabase.rpc('apply_subscription_event', {
    p_event_id: eventId,
    p_event_type: RPC_EVENT_TYPE[eventType] ?? eventType,
    p_user_id: userId,
    p_period_end: periodEnd,
  })

  if (error) {
    console.error(`[revenuecat] apply_subscription_event failed for ${eventId}:`, error.message)
    throw new Error(error.message)
  }

  const result = Array.isArray(data) ? data[0] : data
  console.log(
    `[revenuecat] event ${eventId} applied: processed=${result?.processed} plan=${result?.plan} balance=${result?.balance}`,
  )
  return {
    processed: Boolean(result?.processed),
    plan: (result?.plan as string | null) ?? null,
    balance: (result?.balance as number | null) ?? null,
  }
}

// ──────────────────────────────────────────
// Request handler
// ──────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
  }

  // Service-role client: the only identity allowed to call the RPC.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  let body: { event?: RcEvent; events?: RcEvent[] } | null = null
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const events: RcEvent[] = body?.events ?? (body?.event ? [body.event] : [])
  if (events.length === 0) {
    return jsonResponse({ success: false, error: 'No event in payload' }, 400)
  }

  // ── Shared-secret auth ──
  // RevenueCat dashboard "TEST" events are unsigned; process those without
  // the secret. Real webhooks must present the exact bearer secret.
  const authHeader = req.headers.get('authorization') ?? ''
  const providedSecret = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : ''
  const isTestOnly = events.every((e) => e.type === 'TEST')

  if (!isTestOnly) {
    if (!REVENUECAT_WEBHOOK_SECRET) {
      console.error('[revenuecat] REVENUECAT_WEBHOOK_SECRET is not set on this function')
      return jsonResponse(
        { success: false, error: 'Webhook not configured', code: 'SECRET_MISSING' },
        500,
      )
    }
    if (providedSecret !== REVENUECAT_WEBHOOK_SECRET) {
      console.warn('[revenuecat] rejected request: bad or missing bearer secret')
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
    }
  } else {
    console.log('[revenuecat] TEST event received — signature check skipped (dashboard ping)')
  }

  // ── Apply each event (dedupe happens inside the RPC) ──
  try {
    let last: { processed: boolean; plan: string | null; balance: number | null } | null = null
    for (const event of events) {
      const result = await processEvent(supabase, event)
      if (result) last = result
    }
    return jsonResponse({ success: true, ...(last ?? { processed: true }) })
  } catch (err) {
    // 5xx → RevenueCat retries; the RPC dedupe makes retries safe.
    return jsonResponse(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        code: 'APPLY_FAILED',
      },
      500,
    )
  }
})
