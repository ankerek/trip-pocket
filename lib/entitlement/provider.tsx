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
import * as Sentry from '@sentry/react-native';
import Purchases, {
  LOG_LEVEL,
  PURCHASES_ERROR_CODE,
  type CustomerInfo,
  type PurchasesOfferings,
} from 'react-native-purchases';
import { entitlementStatus, type EntitlementStatus } from './status';
import { readCachedStatus, writeCachedStatus } from './storage';
import { writeSharedEntitlementStatus } from './shared-storage';
import { writeSharedRcUserId } from './shared-user-id';
import { PLANS, type PlanId } from './plans';

type ResumeHandler = () => void | number | Promise<void | number>;
type ResumedListener = (totalResumed: number) => void;

function mirrorToAppGroup(status: EntitlementStatus): void {
  try {
    writeSharedEntitlementStatus(status);
  } catch (err) {
    // The Share Extension fail-opens to 'active' when the file is missing, so a
    // write failure here only means a freshly-cancelled user might still slip a
    // share through and pause downstream. Surface via breadcrumb so we can spot
    // it if entitlement misconfigs ever land in prod.
    Sentry.addBreadcrumb({
      category: 'entitlement',
      level: 'warning',
      message: 'writeSharedEntitlementStatus failed',
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

type PurchaseResult = { ok: true } | { ok: false; reason: 'user-cancelled' | 'pending' | 'error' };

type RestoreResult = { ok: true; entitled: boolean } | { ok: false };

interface EntitlementContextValue {
  status: 'loading' | EntitlementStatus;
  customerInfo: CustomerInfo | null;
  offerings: PurchasesOfferings | null;
  refresh: () => Promise<void>;
  purchasePlan: (planId: PlanId) => Promise<PurchaseResult>;
  restore: () => Promise<RestoreResult>;
  // Callback registered by RootLayoutInner once the pipeline modules are
  // mounted. Fired on inactive→active transitions. May return a number — the
  // count of rows that the handler unpaused — which is summed across handlers
  // and surfaced via `registerOnResumed`.
  registerResumeHandler: (handler: ResumeHandler) => () => void;
  // Fires after all resume handlers settle on an inactive→active transition,
  // with the total count of rows unpaused. The layout uses this to show a
  // "Resuming your imports…" toast when total > 0.
  registerOnResumed: (handler: ResumedListener) => () => void;
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
  const [status, setStatus] = useState<'loading' | EntitlementStatus>(
    () => readCachedStatus() ?? 'loading',
  );
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo | null>(null);
  const [offerings, setOfferings] = useState<PurchasesOfferings | null>(null);
  const previousStatus = useRef<EntitlementStatus | 'loading'>(status);
  const offeringsRef = useRef<PurchasesOfferings | null>(offerings);
  const resumeHandlers = useRef<Set<ResumeHandler>>(new Set());
  const onResumedListeners = useRef<Set<ResumedListener>>(new Set());

  useEffect(() => {
    offeringsRef.current = offerings;
  }, [offerings]);

  const applyCustomerInfo = useCallback((info: CustomerInfo | null) => {
    const next = entitlementStatus(info);
    setCustomerInfo(info);
    setStatus(next);
    writeCachedStatus(next);
    mirrorToAppGroup(next);
    const prev = previousStatus.current;
    previousStatus.current = next;
    if (next === 'active' && prev !== 'active') {
      const handlers = Array.from(resumeHandlers.current);
      void (async () => {
        const results = await Promise.allSettled(handlers.map((h) => Promise.resolve(h())));
        let total = 0;
        for (const r of results) {
          if (r.status === 'fulfilled' && typeof r.value === 'number') total += r.value;
          if (r.status === 'rejected') {
            console.warn('[entitlement] resume handler failed', r.reason);
          }
        }
        if (total > 0) {
          onResumedListeners.current.forEach((l) => {
            try {
              l(total);
            } catch (err) {
              console.warn('[entitlement] onResumed listener failed', err);
            }
          });
        }
      })();
    }
  }, []);

  // Init effect.
  useEffect(() => {
    // Mirror the synchronously-seeded status into the App Group container
    // before any RC fetch resolves. Without this, the Share Extension on a
    // cold launch (after a cancellation in the prior session) would read no
    // file and fail-open to 'active', letting a share-in attempt slip through.
    const seed = readCachedStatus();
    if (seed) mirrorToAppGroup(seed);

    // Keep a stable ref to the listener callback so we can remove it on cleanup.
    let listenerCallback: ((info: CustomerInfo) => void) | null = null;
    let cancelled = false;
    (async () => {
      if (Platform.OS !== 'ios') {
        setStatus('inactive');
        return;
      }
      if (!RC_API_KEY) {
        console.warn('[entitlement] EXPO_PUBLIC_RC_IOS_API_KEY missing — treating as inactive');
        setStatus('inactive');
        return;
      }
      // configure() is synchronous in RC v10 (returns void).
      Purchases.configure({ apiKey: RC_API_KEY });
      // Replace the SDK's default log handler so cold-launch dedup notices
      // (RC posts the same /v1/receipts twice when its auto-sync races our
      // getCustomerInfo() call) don't surface as Metro red-box overlays.
      // The duplicate is harmless — RC's serial queue dedupes correctly —
      // but the SDK logs the dedup at ERROR level, which trips the overlay.
      Purchases.setLogHandler((level, message) => {
        if (
          level === LOG_LEVEL.ERROR &&
          message.includes('operation is already in progress')
        ) {
          console.warn(`[RevenueCat] ${message}`);
          return;
        }
        const prefix = `[RevenueCat] ${message}`;
        if (level === LOG_LEVEL.ERROR) console.error(prefix);
        else if (level === LOG_LEVEL.WARN) console.warn(prefix);
        else if (level === LOG_LEVEL.INFO) console.info(prefix);
        else if (level === LOG_LEVEL.DEBUG || level === LOG_LEVEL.VERBOSE)
          console.debug(prefix);
        else console.log(prefix);
      });
      // Mirror the RC user id to the App Group so the iOS Share Extension
      // can send authenticated POST /extract prewarm requests. RC v10's
      // getAppUserID returns the configured ID (which equals the anon
      // `$RCAnonymousID:…` until logIn replaces it).
      Purchases.getAppUserID()
        .then((id) => {
          if (__DEV__) console.log('[entitlement] app user ID:', id);
          try {
            writeSharedRcUserId(id);
          } catch (err) {
            // Share extension falls back to skipping prewarm — no user-
            // visible damage; the app foreground path still drives
            // extraction. Surface as a breadcrumb only.
            Sentry.addBreadcrumb({
              category: 'entitlement',
              level: 'warning',
              message: 'writeSharedRcUserId failed',
              data: { error: err instanceof Error ? err.message : String(err) },
            });
          }
        })
        .catch((err) => console.warn('[entitlement] getAppUserID failed:', err));
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

  const purchasePlan = useCallback(async (planId: PlanId): Promise<PurchaseResult> => {
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
      if (e?.userCancelled === true || e?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
        return { ok: false, reason: 'user-cancelled' };
      }
      // Detect pending payment (e.g. Ask to Buy / deferred purchase).
      if (e?.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
        return { ok: false, reason: 'pending' };
      }
      return { ok: false, reason: 'error' };
    }
  }, []);

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

  const registerResumeHandler = useCallback((handler: ResumeHandler) => {
    resumeHandlers.current.add(handler);
    return () => {
      resumeHandlers.current.delete(handler);
    };
  }, []);

  const registerOnResumed = useCallback((handler: ResumedListener) => {
    onResumedListeners.current.add(handler);
    return () => {
      onResumedListeners.current.delete(handler);
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
      registerOnResumed,
    }),
    [
      status,
      customerInfo,
      offerings,
      refresh,
      purchasePlan,
      restore,
      registerResumeHandler,
      registerOnResumed,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlement(): EntitlementContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEntitlement must be called inside <EntitlementProvider>');
  return v;
}
