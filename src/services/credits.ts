// services/credits.ts
// AI voice credit balance service.
//
// 1 credit = 1 successful voice recording. Credits live in two server-side
// buckets (migration 014):
//   • free — signup grants, never expire, survive upgrade/downgrade
//   • pro  — topped up to 200 by the RevenueCat webhook, expires at the
//            subscription period end
// Consumption spends pro first. This service only READS the effective
// balance — the server already subtracts an expired pro window at read
// time, and all moving (grant/consume/refund/topup) happens server-side, so
// the client can never misreport or move credits.

import { supabase } from './supabase';

export interface CreditBalance {
  /** Effective balance: free credits + unexpired pro credits. */
  balance: number;
  /**
   * End of the live Pro window (when any of the balance is Pro credits),
   * or null when the remaining balance is entirely free credits.
   */
  expiresAt: string | null;
  /**
   * The free bucket on its own (never expires). Needed wherever a move's
   * shared pool is added on top: a payer's own Pro credits are already IN
   * that pool, so only their free credits may be added to it.
   */
  freeBalance: number;
}

interface CreditRow {
  balance: number;
  expires_at: string | null;
}

export async function fetchCreditBalance(): Promise<CreditBalance> {
  // The effective balance comes from the RPC (it applies Pro expiry at read
  // time); the free bucket is read from the caller's own row (RLS: own row only).
  const [balanceRes, rowRes] = await Promise.all([
    supabase.rpc('get_credit_balance'),
    supabase.from('user_credits').select('free_balance').maybeSingle(),
  ]);

  if (balanceRes.error) throw new Error(balanceRes.error.message);

  const row = (balanceRes.data as CreditRow[] | null)?.[0];
  const balance = row?.balance ?? 0;
  // If the row can't be read, assume no free credits — that can only
  // under-count a payer's total (by their few free credits), never inflate it.
  const free = rowRes.error ? 0 : (rowRes.data?.free_balance ?? 0);

  return {
    balance,
    // The server only returns expires_at while the Pro window is live.
    expiresAt: row?.expires_at ?? null,
    freeBalance: Math.min(free, balance),
  };
}
