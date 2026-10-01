// hooks/use-move-plan.ts
// Pro state for a MOVE, as opposed to a person.
//
// `useEntitlement()` answers "does this user pay?" — correct for Settings,
// purchases and restore. Every move-scoped gate (photo upload, shared credit
// pool) must ask THIS instead, because a family shares one subscription: the
// move is Pro when any member's plan covers it.
//
// Cached for a minute and persisted like every other query, so an offline
// start still knows the move was Pro instead of silently locking uploads.
//
// The plan of a move the user has no access to reads Free and never throws:
// see `fetchMovePlan`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchMoveCreditPool,
  fetchMovePlan,
  setMoveProShared,
  type MovePlan,
} from '@/services/move-plan';

/** Memberships and plans change rarely — a minute is plenty. */
export const MOVE_PLAN_STALE_MS = 60 * 1000;

/** The shared pool moves on every recording, so it is read fresher. */
const MOVE_POOL_STALE_MS = 30 * 1000;

export function useMovePlan(moveId?: string | null) {
  const queryClient = useQueryClient();
  const key = moveId ?? 'none';

  const query = useQuery({
    queryKey: ['move-plan', key],
    queryFn: () => fetchMovePlan(moveId!),
    enabled: !!moveId,
    staleTime: MOVE_PLAN_STALE_MS,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setMoveProShared(moveId!, enabled),
    onSuccess: () => {
      // The plan and the pool both change the moment the switch flips.
      queryClient.invalidateQueries({ queryKey: ['move-plan', key] });
      queryClient.invalidateQueries({ queryKey: ['move-credit-pool', key] });
    },
  });

  const plan: MovePlan | undefined = moveId ? query.data : undefined;

  return {
    plan,
    isMovePro: plan?.plan === 'pro',
    isLoading: !!moveId && query.isLoading,
    /** The caller pays and may switch their plan off for this move. */
    canToggle: plan?.canToggle ?? false,
    sharingOn: plan?.sharingOn ?? true,
    isToggling: toggle.isPending,
    /** Flip the caller's own subscription on/off for this move only. */
    setShared: toggle.mutateAsync,
    refetch: query.refetch,
  };
}

/**
 * The move's shared credit pool: the sum of its contributors' live Pro
 * credits. Shown alongside the personal balance wherever a recording happens
 * inside a move.
 */
export function useMoveCreditPool(moveId?: string | null) {
  const query = useQuery({
    queryKey: ['move-credit-pool', moveId ?? 'none'],
    queryFn: () => fetchMoveCreditPool(moveId!),
    enabled: !!moveId,
    staleTime: MOVE_POOL_STALE_MS,
  });

  return {
    pool: typeof query.data === 'number' ? query.data : null,
    isLoading: !!moveId && query.isLoading,
    refetch: query.refetch,
  };
}
