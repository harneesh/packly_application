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
}

interface CreditRow {
  balance: number;
  expires_at: string | null;
}

export async function fetchCreditBalance(): Promise<CreditBalance> {
  const { data, error } = await supabase.rpc('get_credit_balance');

  if (error) throw new Error(error.message);

  const row = (data as CreditRow[] | null)?.[0];

  return {
    balance: row?.balance ?? 0,
    // The server only returns expires_at while the Pro window is live.
    expiresAt: row?.expires_at ?? null,
  };
}
