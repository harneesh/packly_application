// hooks/use-entitlement.ts
// React hook exposing the user's Free/Pro plan.
//
// Usage:
//   const { isPro, isLoading } = useEntitlement();
//
// Two sources of truth, MERGED:
//   1. RevenueCat on-device (instant at purchase, but flickers Free for a few
//      seconds at every sandbox renewal boundary)
//   2. OUR database (webhook-written, lags a few seconds behind the boundary
//      but is what the real gates use)
//
// isPro = device says Pro OR (server row says Pro within a small grace window
// past its period_end). Either source counting as Pro keeps the UI stable —
// the flicker only appeared when we showed the device's transient "expired"
// moment. The DB gate and the credit machinery remain strictly
// period-based; this smoothing is UI-only.

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchEntitlement,
  fetchServerPlanState,
  onEntitlementChanged,
  type EntitlementState,
  type ServerPlanState,
} from '@/services/entitlements';

/** Grace window past the server's period_end during which the UI still shows Pro. */
const RENEWAL_GRACE_MS = 15 * 60 * 1000; // 15 minutes

export function useEntitlement() {
  const queryClient = useQueryClient();

  const device = useQuery({
    queryKey: ['entitlement-device'],
    queryFn: fetchEntitlement,
    staleTime: 30 * 1000,
    retry: 1,
  });

  const server = useQuery({
    queryKey: ['entitlement-server'],
    queryFn: fetchServerPlanState,
    staleTime: 30 * 1000,
    retry: 1,
  });

  // Live updates: purchase sheet closes, renewal lands, subscription expires.
  useEffect(() => {
    return onEntitlementChanged(() => {
      queryClient.invalidateQueries({ queryKey: ['entitlement-device'] });
      queryClient.invalidateQueries({ queryKey: ['entitlement-server'] });
    });
  }, [queryClient]);

  const deviceState: EntitlementState | undefined = device.data;
  const serverState: ServerPlanState | null = server.data ?? null;

  // Server-side Pro with grace: a 'pro' row whose period_end slipped into the
  // recent past is treated as still-Pro (the RENEWAL webhook is seconds away).
  let serverPro = false;
  if (serverState?.plan === 'pro') {
    if (!serverState.periodEnd) {
      serverPro = true; // Pro with no expiry pinned — treat as active
    } else {
      const msPast = Date.now() - new Date(serverState.periodEnd).getTime();
      serverPro = msPast < RENEWAL_GRACE_MS;
    }
  }

  const isPro = Boolean(deviceState?.isPro) || serverPro;

  return {
    isPro,
    periodEnd: deviceState?.periodEnd ?? serverState?.periodEnd ?? null,
    ready: deviceState?.ready ?? false,
    isLoading: device.isLoading || server.isLoading,
    refetch: async () => {
      await Promise.all([device.refetch(), server.refetch()]);
    },
  };
}
