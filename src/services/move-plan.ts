// services/move-plan.ts
// The Pro state of a MOVE (migration 021).
//
// Pro belongs to the move, not to the person: any member with a live
// subscription covers everybody in it, with no seat cap. That makes this the
// source of truth for every move-scoped Pro surface — the photo gate, the
// move's shared credit pool — while `useEntitlement` keeps answering the
// personal question (does THIS user pay?) for Settings and purchases.
//
// Move plan → what the members see:
//   free — no payer covers this move; uploads need Pro to be turned on
//   pro  — at least one payer covers it; uploads and pooled credits work
//
// A payer can also switch their OWN subscription off for a specific move
// (`setMoveProShared`). That switch is symmetric: with it off the move is Free
// for everyone, the payer included, while their subscription keeps working in
// their other moves.

import { supabase } from './supabase';

export interface MovePlan {
  plan: 'free' | 'pro';
  /** End of the live Pro window covering this move, when there is one. */
  periodEnd: string | null;
  /** The payer whose window ends last — the one that keeps the move Pro. */
  payerId: string | null;
  /** Display names of everyone contributing, for "Pro · shared by A and B". */
  payerNames: string[];
  /** True when the CALLER is one of the contributors. */
  isPayer: boolean;
  /** The CALLER's own switch for this move (true when they have no switch). */
  sharingOn: boolean;
  /** True when the caller pays on this account, so the toggle applies to them. */
  canToggle: boolean;
}

/** What a move with no Pro payer looks like. */
export const FREE_MOVE_PLAN: MovePlan = {
  plan: 'free',
  periodEnd: null,
  payerId: null,
  payerNames: [],
  isPayer: false,
  sharingOn: true,
  canToggle: false,
};

interface MovePlanRow {
  plan: string | null;
  period_end: string | null;
  payer_id: string | null;
  payer_names: string[] | null;
  is_payer: boolean | null;
  sharing_on: boolean | null;
  can_toggle: boolean | null;
}

export async function fetchMovePlan(moveId: string): Promise<MovePlan> {
  const { data, error } = await supabase.rpc('move_plan', {
    p_move_id: moveId,
  });

  if (error) {
    // Removed from the move since this cache entry was written. There is no
    // move to describe any more, and throwing would leave every consumer of
    // the plan with nothing to render — so report Free, the safe default.
    if (error.message.includes('NOT_MOVE_MEMBER')) return FREE_MOVE_PLAN;
    throw new Error(error.message);
  }

  const row = (data as MovePlanRow[] | null)?.[0];
  if (!row) return FREE_MOVE_PLAN;

  return {
    plan: row.plan === 'pro' ? 'pro' : 'free',
    periodEnd: row.period_end ?? null,
    payerId: row.payer_id ?? null,
    payerNames: row.payer_names ?? [],
    isPayer: Boolean(row.is_payer),
    // An absent switch means "on" — that is the server default too.
    sharingOn: row.sharing_on !== false,
    canToggle: Boolean(row.can_toggle),
  };
}

/**
 * Turn the caller's own Pro subscription on or off FOR THIS MOVE ONLY.
 *
 * Off is symmetric by design: the move becomes Free for everybody, including
 * the payer, while the subscription keeps covering their other moves.
 */
export async function setMoveProShared(
  moveId: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('set_move_pro_enabled', {
    p_move_id: moveId,
    p_enabled: enabled,
  });

  if (error) throw new Error(error.message);
}

/** The move's shared Pro credit pool (members only). */
export async function fetchMoveCreditPool(moveId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_move_credit_pool', {
    p_move_id: moveId,
  });

  if (error) {
    if (error.message.includes('NOT_MOVE_MEMBER')) return 0;
    throw new Error(error.message);
  }

  return typeof data === 'number' ? data : 0;
}
