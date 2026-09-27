import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { PropsWithChildren, useEffect } from 'react';

import { configureRevenueCat, syncRevenueCatUser } from '@/services/entitlements';
import { useAuthStore } from '@/store/auth-store';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 2,
    },
  },
});

/**
 * RevenueCat bootstrap — must live INSIDE QueryClientProvider so it can
 * invalidate the entitlement query once configuration completes (screens
 * mounted before that point read `ready: false` and would otherwise never
 * re-check). Configuration + user sync are no-ops when the API key is
 * absent, so the app degrades to free-only mode without crashing.
 */
function RevenueCatSync() {
  const queryClient = useQueryClient();
  // undefined = auth still hydrating (zustand starts isLoading=true);
  // null = hydration complete and genuinely signed out. Passing undefined
  // through to syncRevenueCatUser prevents the cold-start race that logged
  // the SDK out of the real user.
  const authLoading = useAuthStore((state) => state.isLoading);
  const user = useAuthStore((state) => state.user);
  const userId: string | null | undefined = authLoading ? undefined : user?.id ?? null;

  useEffect(() => {
    if (userId === undefined) return; // hydration in progress — wait for it
    let cancelled = false;
    (async () => {
      try {
        await configureRevenueCat();
        if (cancelled) return;
        await syncRevenueCatUser(userId);
        // Entitlement state may differ once logged in / configured.
        // (Both cache keys — the device query and the server query — need
        // refreshing so screens that mounted before configure see ready=true.)
        queryClient.invalidateQueries({ queryKey: ['entitlement-device'] });
        queryClient.invalidateQueries({ queryKey: ['entitlement-server'] });
      } catch (err) {
        console.warn('[revenuecat] init failed:', err instanceof Error ? err.message : err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, queryClient]);

  return null;
}

export function Providers({ children }: PropsWithChildren) {
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <QueryClientProvider client={queryClient}>
      <RevenueCatSync />
      {children}
    </QueryClientProvider>
  );
}
