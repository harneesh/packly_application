// services/providers.tsx
// App-wide providers: a TanStack Query client whose cache is PERSISTED to
// AsyncStorage, so a cold start paints the last-known data instantly (and
// works offline) while the network revalidates in the background.
//
// How the cold start works now:
//   1. Root layout holds the native splash over font + auth hydration.
//   2. PersistQueryClientProvider restores the cache from AsyncStorage and
//      PAUSES queries until that read finishes — so no request races the
//      restore and the first paint already has data.
//   3. onSuccess/onError → RootLayout hides the splash, so the first visible
//      frame is populated instead of a spinner.
// Restored entries are served while stale, then refreshed in the background
// (stale-while-revalidate). `CACHE_MAX_AGE_MS` bounds how old a restored
// entry may be before it is dropped and fetched fresh.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { PropsWithChildren, useEffect, useRef } from 'react';

import { configureRevenueCat, syncRevenueCatUser } from '@/services/entitlements';
import { useAuthStore } from '@/store/auth-store';

/** 24 hours — how long a persisted entry stays restorable. */
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute — revalidate in the background after that
      // Keep entries in memory long enough that a restored cache is actually
      // usable (default 5 min would drop restored data immediately).
      gcTime: CACHE_MAX_AGE_MS,
      retry: 2,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'packly-query-cache-v1',
  // Coalesce cache writes — the cache changes constantly during sync.
  throttleTime: 1000,
});

/**
 * RevenueCat bootstrap — must live INSIDE the query provider so it can
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

/**
 * Drops cached data when the signed-in account goes away or changes, so the
 * persisted cache can never leak one account's moves into another's session
 * (or back onto the sign-in screen after a sign-out / deletion).
 */
function CacheOwnerSync() {
  const queryClient = useQueryClient();
  const authLoading = useAuthStore((state) => state.isLoading);
  const userId = useAuthStore((state) => state.user?.id ?? null);
  // undefined until the first hydrated value — distinguishes "not hydrated
  // yet" from "hydrated and signed out".
  const lastUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (authLoading) return;
    const previous = lastUserId.current;
    lastUserId.current = userId;
    // Only act on a real transition between accounts (including → null).
    // `previous !== undefined` (not truthiness) is deliberate: a null→user
    // sign-in must ALSO clear, otherwise a cache persisted by a previous
    // account on a shared device survives the signed-out window and leaks
    // into the next account's session.
    if (previous !== undefined && previous !== userId) {
      queryClient.clear();
      // Also delete the persisted copy, not just the in-memory cache.
      void persister.removeClient();
    }
  }, [authLoading, userId, queryClient]);

  return null;
}

interface ProvidersProps extends PropsWithChildren {
  /**
   * Called once the persisted cache has been restored (or failed) — the root
   * layout keeps the splash up until this fires so the first frame is
   * already populated.
   */
  onCacheRestored?: () => void;
}

export function Providers({ children, onCacheRestored }: ProvidersProps) {
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: CACHE_MAX_AGE_MS,
        dehydrateOptions: {
          // Successful queries only; never persist mutations.
          shouldDehydrateMutation: () => false,
        },
      }}
      onSuccess={onCacheRestored}
      onError={onCacheRestored}>
      <RevenueCatSync />
      <CacheOwnerSync />
      {children}
    </PersistQueryClientProvider>
  );
}
