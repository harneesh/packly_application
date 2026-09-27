// services/entitlements.ts
// RevenueCat client service — the Free/Pro plan source for the UI.
//
// IMPORTANT (server-authoritative design):
//   The UI shows what RevenueCat reports, but the REAL gates live in the
//   database (migration 013): photo INSERT requires an active Pro period and
//   credits are only moved by the webhook RPC. The client can never unlock
//   anything by tampering with this layer.
//
// Dev builds use the RevenueCat TEST STORE API key (EXPO_PUBLIC_REVENUECAT_API_KEY)
// — test purchases are simulated in-app and still fire sandbox webhooks to
// Supabase, flipping the user to Pro for real. Never ship with the Test Store
// key; release builds get the Android-specific API key.

import Purchases, {
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  PACKAGE_TYPE,
  type CustomerInfo,
  type CustomerInfoUpdateListener,
  type PurchasesPackage,
} from 'react-native-purchases';

import { supabase } from './supabase';

const RC_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ?? '';

/** Entitlement identifier — must match the RevenueCat dashboard exactly. */
export const PRO_ENTITLEMENT_ID = 'pro';

export interface EntitlementState {
  /** True when the `pro` entitlement is currently active. */
  isPro: boolean;
  /** ISO date the paid period ends, when known. */
  periodEnd: string | null;
  /** True once RevenueCat has been configured and an initial read succeeded. */
  ready: boolean;
}

let configured = false;

// Listeners registered before configuration completed are attached as soon
// as configure() finishes — this removes the mount-vs-configure race where
// a screen mounts before the SDK is ready and silently never gets updates.
const listeners = new Map<
  (state: EntitlementState) => void,
  CustomerInfoUpdateListener | null
>();

function makeListener(cb: (state: EntitlementState) => void): CustomerInfoUpdateListener {
  return (info: CustomerInfo) => {
    cb(toEntitlementState(info));
  };
}

/**
 * Configure the SDK once. Safe to call repeatedly; no-ops when the API key
 * is missing (e.g. teammate clone without .env) so the app keeps working
 * in degraded free-only mode instead of crashing.
 */
export async function configureRevenueCat(): Promise<void> {
  if (configured) return;
  if (!RC_API_KEY) {
    console.warn('[revenuecat] EXPO_PUBLIC_REVENUECAT_API_KEY missing — Pro features disabled');
    return;
  }

  if (__DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }

  await Purchases.configure({ apiKey: RC_API_KEY });
  configured = true;

  // Attach anything registered while we were still configuring.
  for (const [cb, listener] of listeners) {
    if (listener === null) {
      const l = makeListener(cb);
      listeners.set(cb, l);
      Purchases.addCustomerInfoUpdateListener(l);
    }
  }
}

// Serialized user-sync chain. The read-then-act below (getAppUserID →
// logIn/logOut) must never interleave with another in-flight sync — two
// effects firing back-to-back (auth hydration flips null → real id on every
// cold start / JS reload) would otherwise both read the same pre-logout id,
// one logs out, the other skips as "already synced", and the SDK ends up
// anonymous with the purchases stranded on the identified user.
let syncChain: Promise<void> = Promise.resolve();

/**
 * Keep RevenueCat's app_user_id identical to the Supabase auth user id so
 * webhook events (which carry app_user_id) can find the right rows in our
 * database. Logging out resets to an anonymous id.
 *
 * `undefined` means "auth still hydrating" — never treated as signed-out,
 * because acting on the transient null logged the SDK out of the real user
 * on every cold start. Only a completed hydration with no session logs out.
 */
export async function syncRevenueCatUser(
  userId: string | null | undefined,
): Promise<void> {
  if (!configured || userId === undefined) return;

  const run = syncChain.then(async () => {
    try {
      const current = await Purchases.getAppUserID();
      if (userId) {
        // Already identified as this exact user (typical on every startup
        // after the first) — calling logIn again would fire a redundant
        // /identify network call for no benefit.
        if (current === userId) return;
        await Purchases.logIn(userId);
      } else {
        // Only log out if RevenueCat currently holds a real (non-anonymous)
        // id — logging out an anonymous user throws.
        if (current.startsWith('$RCAnonymousID:')) return;
        await Purchases.logOut();
      }
    } catch (err) {
      // Non-fatal: worst case the webhook can't match a purchase to a user.
      console.warn('[revenuecat] user sync failed:', err instanceof Error ? err.message : err);
    }
  });
  // run never rejects (all errors caught inside), so the chain can't die.
  syncChain = run;
  return run;
}

/** Read the current entitlement state from RevenueCat. */
export async function fetchEntitlement(): Promise<EntitlementState> {
  if (!configured) {
    return { isPro: false, periodEnd: null, ready: false };
  }
  const info = await Purchases.getCustomerInfo();
  return toEntitlementState(info);
}

function toEntitlementState(info: CustomerInfo): EntitlementState {
  const pro = info.entitlements.active[PRO_ENTITLEMENT_ID];
  return {
    isPro: Boolean(pro),
    periodEnd: pro?.expirationDate ?? null,
    ready: true,
  };
}

/**
 * Subscribe to entitlement changes (purchases, renewals, expirations
 * reported by RevenueCat). Returns an unsubscribe function.
 */
export function onEntitlementChanged(
  cb: (state: EntitlementState) => void,
): () => void {
  if (!configured) {
    // Queue it — configure() will attach it the moment it finishes.
    listeners.set(cb, null);
    return () => {
      const attached = listeners.get(cb);
      listeners.delete(cb);
      if (attached) {
        Purchases.removeCustomerInfoUpdateListener(attached);
      }
    };
  }
  // v10 API: addCustomerInfoUpdateListener returns void; removal happens by
  // passing the same function reference to the static remover.
  const listener = makeListener(cb);
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => {
    Purchases.removeCustomerInfoUpdateListener(listener);
  };
}

/**
 * Purchase the Pro subscription. Picks the monthly package from the current
 * offering. Resolves with the new entitlement state.
 * Throws 'PURCHASE_CANCELLED' when the user backs out of the sheet.
 */
export async function purchasePro(): Promise<EntitlementState> {
  assertReady();

  const offerings = await Purchases.getOfferings();
  const current = offerings.current;
  if (!current || current.availablePackages.length === 0) {
    throw new Error('NO_PRODUCTS_CONFIGURED');
  }

  const pkg: PurchasesPackage | undefined =
    current.availablePackages.find((p) => p.identifier === PACKAGE_TYPE.MONTHLY) ??
    current.availablePackages[0];

  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return toEntitlementState(customerInfo);
}

/** Restore previous purchases (required for app-store compliance). */
export async function restorePurchases(): Promise<EntitlementState> {
  assertReady();
  const info = await Purchases.restorePurchases();
  return toEntitlementState(info);
}

/** True when the error is "user closed the purchase sheet" — not a failure. */
export function isPurchaseCancelled(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;
}

/**
 * Read OUR database's plan for the signed-in user (the server truth written
 * by the RevenueCat webhook). Returns null when unconfigured/unsigned-in.
 */
export async function fetchServerPlan(): Promise<'free' | 'pro' | null> {
  const state = await fetchServerPlanState();
  return state ? state.plan : null;
}

export interface ServerPlanState {
  plan: 'free' | 'pro';
  /** Raw period_end from the DB row — may already be in the past. */
  periodEnd: string | null;
}

/**
 * Same as fetchServerPlan but also returns the raw period_end, so the UI
 * can apply a grace window around renewal boundaries (webhooks lag seconds
 * behind the device-side flip; the raw plan alone flickers Free mid-renewal).
 */
export async function fetchServerPlanState(): Promise<ServerPlanState | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('user_entitlements')
    .select('plan, period_end')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!data) return null;
  return {
    plan: (data.plan as 'free' | 'pro') ?? 'free',
    periodEnd: (data.period_end as string | null) ?? null,
  };
}

/**
 * After a successful purchase RevenueCat reports Pro instantly, but OUR
 * database (credits → 200, photo gate) updates via the webhook, which can
 * lag a second or two. Poll the server plan until it flips to 'pro' (or
 * give up after `attempts` — the customerInfo listener still refreshes the
 * UI, and the webhook will land eventually).
 */
export async function waitForServerPro(
  attempts = 6,
  delayMs = 1000,
): Promise<'free' | 'pro' | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const plan = await fetchServerPlan();
      if (plan === 'pro') return 'pro';
    } catch {
      // transient network/db error — keep polling
    }
  }
  return fetchServerPlan().catch(() => null);
}

function assertReady(): void {
  if (!configured) {
    throw new Error('REVENUECAT_NOT_CONFIGURED');
  }
}
