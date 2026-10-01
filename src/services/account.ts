// services/account.ts
// Account deletion — calls the delete_account() RPC (migration 015).
//
// The server tombstones the account: sign-in is blocked forever (banned
// auth row), the email is reserved so it can't re-sign-up and farm free
// signup credits, remaining credit balances are wiped with a ledger trail,
// and the profile email is masked. Nothing is hard-deleted client-side.

import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';

export async function deleteAccount(): Promise<void> {
  // Per-attempt token used server-side to build a collision-proof tombstone
  // email (the RPC only requires >= 8 chars).
  const confirm = Crypto.randomUUID().replace(/-/g, '');

  const { error } = await supabase.rpc('delete_account', {
    p_confirm: confirm,
  });

  if (error) throw new Error(error.message);
}
