// hooks/use-upgrade.ts
// Shared Free → Pro purchase flow, extracted from Settings so any paywall
// surface (locked photo sections, credit-exhausted states) can trigger the
// exact same purchase + restore experience with zero duplicated logic.
//
// Usage:
//   const { isPro, rcEnabled, isPurchasing, isRestoring, upgrade, restore } = useUpgrade();
//
// After a successful purchase the hook waits for OUR database to flip to Pro
// (webhook → 200 credits + photo gate) and refreshes every plan-related
// query, so the whole UI updates without any manual refresh.

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import {
  isPurchaseCancelled,
  purchasePro,
  restorePurchases,
  waitForServerPro,
} from '@/services/entitlements';
import { useEntitlement } from '@/hooks/use-entitlement';

function friendlyPurchaseError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'NO_PRODUCTS_CONFIGURED') {
    return 'The subscription product is not configured yet.';
  }
  if (msg === 'REVENUECAT_NOT_CONFIGURED') {
    return 'Purchases are not available in this build.';
  }
  return 'Something went wrong. Please try again.';
}

export function useUpgrade() {
  const queryClient = useQueryClient();
  const { isPro, ready, refetch } = useEntitlement();

  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const upgrade = useCallback(async () => {
    setIsPurchasing(true);
    try {
      await purchasePro();
      // The webhook grants Pro + 200 credits in OUR database — give it a
      // moment to land, then refresh every plan-related view.
      await waitForServerPro();
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['credits'] });
      Alert.alert('Welcome to Pro! 🎉', '200 AI recordings and photo uploads are unlocked.');
    } catch (err) {
      if (!isPurchaseCancelled(err)) {
        Alert.alert('Purchase failed', friendlyPurchaseError(err));
      }
    } finally {
      setIsPurchasing(false);
    }
  }, [queryClient, refetch]);

  const restore = useCallback(async () => {
    setIsRestoring(true);
    try {
      const state = await restorePurchases();
      if (state.isPro) {
        await waitForServerPro();
        queryClient.invalidateQueries({ queryKey: ['credits'] });
      }
      await refetch();
      Alert.alert(
        state.isPro ? 'Purchases restored' : 'Nothing to restore',
        state.isPro
          ? 'Your Pro plan is active again.'
          : 'No previous purchases were found for this account.',
      );
    } catch (err) {
      if (!isPurchaseCancelled(err)) {
        Alert.alert('Restore failed', friendlyPurchaseError(err));
      }
    } finally {
      setIsRestoring(false);
    }
  }, [queryClient, refetch]);

  return {
    isPro,
    /** True once RevenueCat is configured — purchase actions stay hidden until then. */
    rcEnabled: ready,
    isPurchasing,
    isRestoring,
    upgrade,
    restore,
  };
}
