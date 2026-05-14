import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import Purchases, {
  PURCHASES_ERROR_CODE,
  type CustomerInfo,
  type PurchasesOfferings,
} from 'react-native-purchases';
import { entitlementStatus, type EntitlementStatus } from './status';
import { readCachedStatus, writeCachedStatus } from './storage';
import { PLANS, type PlanId } from './plans';

type PurchaseResult =
  | { ok: true }
  | { ok: false; reason: 'user-cancelled' | 'pending' | 'error' };

type RestoreResult =
  | { ok: true; entitled: boolean }
  | { ok: false };

interface EntitlementContextValue {
  status: 'loading' | EntitlementStatus;
  customerInfo: CustomerInfo | null;
  offerings: PurchasesOfferings | null;
  refresh: () => Promise<void>;
  purchasePlan: (planId: PlanId) => Promise<PurchaseResult>;
  restore: () => Promise<RestoreResult>;
  // Callback registered by RootLayoutInner once the pipeline modules are
  // mounted. Fired on inactive→active transitions.
  registerResumeHandler: (handler: () => void | Promise<void>) => () => void;
}

const Ctx = createContext<EntitlementContextValue | null>(null);

// Resolved at build time in app.config.ts so the dev variant gets the dev
// RC project's key (when EXPO_PUBLIC_RC_IOS_API_KEY_DEV is set) without a
// runtime branch on __DEV__.
const RC_API_KEY = (Constants.expoConfig?.extra?.rcIosApiKey as string | undefined) ?? '';

export function EntitlementProvider({ children }: { children: ReactNode }) {
  // Seed from the cached file synchronously so first render has a definite
  // status. Provider sits outside the existing root `ready` guard — see
  // app/_layout.tsx changes in Task 21.
  const [status, setStatus] = useState<'loading' | EntitlementStatus>(() => readCachedStatus() ?? 'loading');
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [offerings, setOfferings] = useState<PurchasesOfferings | null>(null);
  const previousStatus = useRef<EntitlementStatus | 'loading'>(status);
  const offeringsRef = useRef<PurchasesOfferings | null>(offerings);
  const resumeHandlers = useRef<Set<() => void | Promise<void>>>(new Set());

  useEffect(() => { offeringsRef.current = offerings; }, [offerings]);

  const applyCustomerInfo = useCallback((info: CustomerInfo | null) => {
    const next = entitlementStatus(info);
    setCustomerInfo(info);
    setStatus(next);
    writeCachedStatus(next);
    const prev = previousStatus.current;
    previousStatus.current = next;
    if (next === 'active' && prev !== 'active') {
      resumeHandlers.current.forEach((h) => {
        Promise.resolve(h()).catch((err) =>
          console.warn('[entitlement] resume handler failed', err),
        );
      });
    }
  }, []);

  // Init effect.
  useEffect(() => {
    // Keep a stable ref to the listener callback so we can remove it on cleanup.
    let listenerCallback: ((info: CustomerInfo) => void) | null = null;
    let cancelled = false;
    (async () => {
      if (Platform.OS !== 'ios') {
        setStatus('inactive');
        return;
      }
      if (!RC_API_KEY) {
        console.warn(
          '[entitlement] EXPO_PUBLIC_RC_IOS_API_KEY missing — treating as inactive',
        );
        setStatus('inactive');
        return;
      }
      // configure() is synchronous in RC v10 (returns void).
      Purchases.configure({ apiKey: RC_API_KEY });
      if (__DEV__) {
        // Surface the anon RC user ID so dev can grant entitlements in the
        // RC dashboard after a reinstall without spelunking the debugger.
        Purchases.getAppUserID()
          .then((id) => console.log('[entitlement] app user ID:', id))
          .catch((err) => console.warn('[entitlement] getAppUserID failed:', err));
      }
      try {
        const info = await Purchases.getCustomerInfo();
        if (cancelled) return;
        applyCustomerInfo(info);
      } catch (err) {
        console.warn('[entitlement] initial getCustomerInfo failed', err);
        if (!cancelled) {
          // Don't apply null — that would overwrite the cache with 'inactive'
          // and erase a previously-known good state. Keep the seed status from
          // the cache and let the listener / next refresh recover.
          setCustomerInfo(null);
          setStatus((s) => (s === 'loading' ? (readCachedStatus() ?? 'inactive') : s));
        }
      }
      try {
        const off = await Purchases.getOfferings();
        if (!cancelled) setOfferings(off);
      } catch (err) {
        console.warn('[entitlement] getOfferings failed', err);
      }
      // RC v10: addCustomerInfoUpdateListener returns void.
      // Store the callback reference so we can remove it on cleanup.
      listenerCallback = (info: CustomerInfo) => {
        applyCustomerInfo(info);
      };
      Purchases.addCustomerInfoUpdateListener(listenerCallback);
    })();
    // cancelled guards the IIFE continuation; the listener is removed
    // synchronously in cleanup so it will not fire after unmount.
    return () => {
      cancelled = true;
      if (listenerCallback) {
        Purchases.removeCustomerInfoUpdateListener(listenerCallback);
      }
    };
  }, [applyCustomerInfo]);

  const refresh = useCallback(async () => {
    try {
      const info = await Purchases.getCustomerInfo();
      applyCustomerInfo(info);
    } catch (err) {
      console.warn('[entitlement] refresh failed', err);
    }
  }, [applyCustomerInfo]);

  const purchasePlan = useCallback(
    async (planId: PlanId): Promise<PurchaseResult> => {
      const plan = PLANS.find((p) => p.id === planId);
      if (!plan) return { ok: false, reason: 'error' };
      try {
        const off = offeringsRef.current ?? (await Purchases.getOfferings());
        const pkg = off.current?.availablePackages.find(
          (p) => p.product.identifier === plan.productId,
        );
        if (!pkg) return { ok: false, reason: 'error' };
        await Purchases.purchasePackage(pkg);
        return { ok: true };
      } catch (err: unknown) {
        const e = err as { userCancelled?: boolean | null; code?: PURCHASES_ERROR_CODE };
        // Detect user cancel: check both the legacy boolean field and the canonical error code.
        if (
          e?.userCancelled === true ||
          e?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
        ) {
          return { ok: false, reason: 'user-cancelled' };
        }
        // Detect pending payment (e.g. Ask to Buy / deferred purchase).
        if (e?.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
          return { ok: false, reason: 'pending' };
        }
        return { ok: false, reason: 'error' };
      }
    },
    [],
  );

  const restore = useCallback(async (): Promise<RestoreResult> => {
    try {
      const info = await Purchases.restorePurchases();
      applyCustomerInfo(info);
      return { ok: true, entitled: entitlementStatus(info) === 'active' };
    } catch (err) {
      console.warn('[entitlement] restore failed', err);
      return { ok: false };
    }
  }, [applyCustomerInfo]);

  const registerResumeHandler = useCallback((handler: () => void | Promise<void>) => {
    resumeHandlers.current.add(handler);
    return () => {
      resumeHandlers.current.delete(handler);
    };
  }, []);

  const value = useMemo<EntitlementContextValue>(
    () => ({
      status,
      customerInfo,
      offerings,
      refresh,
      purchasePlan,
      restore,
      registerResumeHandler,
    }),
    [status, customerInfo, offerings, refresh, purchasePlan, restore, registerResumeHandler],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEntitlement must be called inside <EntitlementProvider>');
  return v;
}
