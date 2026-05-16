import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, Pressable, ScrollView, Text, View } from '@/tw';
import { Stack } from 'expo-router';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Purchases, { INTRO_ELIGIBILITY_STATUS, type PurchasesPackage } from 'react-native-purchases';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useThemeColors } from '@/tw/theme';
import {
  PLANS,
  DEFAULT_SELECTED_PLAN,
  type PlanId,
  type PlanConfig,
} from '@/lib/entitlement/plans';
import { useEntitlement } from '@/lib/entitlement/provider';
import { PRIVACY_URL, TERMS_URL } from '@/lib/links';
import { showToast } from '@/lib/toast/toast';

// Fallback display, shown only for the frame before RC offerings resolve.
// Intentionally omits any "Save X%" copy — the real % is computed live from
// the loaded packages so it stays correct across currencies and price tiers.
const FALLBACK_PRICES: Record<
  PlanId,
  { price: string; per: string; trialNote: string; subNote: string }
> = {
  yearly: {
    price: '$39.99',
    per: '/yr',
    trialNote: 'Billed yearly after the trial.',
    subNote: 'Billed yearly, auto-renews.',
  },
  weekly: {
    price: '$3.99',
    per: '/wk',
    trialNote: 'Billed weekly after the trial.',
    subNote: 'Billed weekly, auto-renews.',
  },
};

function buildPlanNote(
  plan: PlanConfig,
  trialEligible: boolean,
  yearlyPerWeekString: string | null,
  discountPct: number | null,
): string {
  const tail = trialEligible
    ? `Billed ${plan.label.toLowerCase()} after the trial.`
    : `Billed ${plan.label.toLowerCase()}, auto-renews.`;
  if (
    plan.id === 'yearly' &&
    yearlyPerWeekString != null &&
    discountPct != null &&
    discountPct > 0
  ) {
    return `Save ${discountPct}% · just ${yearlyPerWeekString}/wk. ${tail}`;
  }
  return tail;
}

function trialDaysFromPackage(pkg: PurchasesPackage | undefined): number | null {
  const period = pkg?.product.introPrice?.periodNumberOfUnits;
  const unit = pkg?.product.introPrice?.periodUnit;
  if (period == null || unit == null) return null;
  switch (unit) {
    case 'DAY':
      return period;
    case 'WEEK':
      return period * 7;
    case 'MONTH':
      return period * 30;
    case 'YEAR':
      return period * 365;
    default:
      return null;
  }
}

export type PaywallBodyProps = {
  headline: string;
  /** Called when purchase or successful restore completes (entitled). */
  onSuccess: () => void;
  /**
   * Optional close affordance. When provided, an X is rendered in the top-right
   * and tapping it invokes this callback. Lapse mode always passes one; first-
   * run passes one only under __DEV__.
   */
  onClose?: () => void;
  closeAccessibilityLabel?: string;
  /** Slot above the headline (e.g. subtitle for lapse mode). */
  subtitle?: ReactNode;
};

export function PaywallBody({
  headline,
  onSuccess,
  onClose,
  closeAccessibilityLabel = 'Close paywall',
  subtitle,
}: PaywallBodyProps) {
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [plan, setPlan] = useState<PlanId>(DEFAULT_SELECTED_PLAN);
  const [busy, setBusy] = useState(false);
  const { status, offerings, purchasePlan, restore } = useEntitlement();

  // Auto-exit when entitlement is already active. Covers two paths:
  //  1. Returning subscriber whose reinstall raced past the root-layout
  //     onboarding gate (RC fetch resolved after the modal was pushed).
  //  2. Lapse paywall where status flips back to active via the customer-
  //     info listener (e.g. background renew, billing recovery).
  // onSuccess is inline in the parent so its identity changes every render;
  // route it through a ref + one-shot flag so the dismiss fires exactly once.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const autoExitedRef = useRef(false);
  useEffect(() => {
    if (status === 'active' && !autoExitedRef.current) {
      autoExitedRef.current = true;
      onSuccessRef.current();
    }
  }, [status]);

  const selectedPlanCfg = PLANS.find((pl) => pl.id === plan);
  const pkgFor = (planId: PlanId): PurchasesPackage | undefined => {
    const productId = PLANS.find((pl) => pl.id === planId)?.productId;
    return offerings?.current?.availablePackages.find((p) => p.product.identifier === productId);
  };
  const selectedPkg = pkgFor(plan);

  // Yearly's weekly-equivalent + discount %, computed live from RC packages so
  // both stay correct in every storefront/currency (Apple's price tiers aren't
  // perfectly proportional, so the % differs by region). Both `pricePerWeek`
  // and `priceString` come back already formatted in the device locale.
  const yearlyPkg = pkgFor('yearly');
  const weeklyPkg = pkgFor('weekly');
  const yearlyPerWeekString = yearlyPkg?.product.pricePerWeekString ?? null;
  const discountPct =
    yearlyPkg?.product.pricePerWeek != null && weeklyPkg?.product.price != null
      ? Math.round((1 - yearlyPkg.product.pricePerWeek / weeklyPkg.product.price) * 100)
      : null;

  // Eligibility per plan from RC. We only promise the trial when RC
  // explicitly returns ELIGIBLE — UNKNOWN (RC couldn't determine, usually
  // missing subscription-group info) falls back to non-intro copy per RC's
  // recommendation, so we never make a promise StoreKit will reject.
  // `undefined` = check not yet resolved; treat the same as non-eligible to
  // avoid flashing trial copy that flips to "Subscribe" a frame later for
  // ineligible users (mis-leading is worse than under-selling).
  const [eligibility, setEligibility] = useState<Record<PlanId, boolean | undefined>>({
    yearly: undefined,
    weekly: undefined,
  });
  useEffect(() => {
    const ids = PLANS.map((p) => p.productId);
    let cancelled = false;
    Purchases.checkTrialOrIntroductoryPriceEligibility(ids)
      .then((map) => {
        if (cancelled) return;
        const next: Record<PlanId, boolean | undefined> = { yearly: false, weekly: false };
        for (const planCfg of PLANS) {
          next[planCfg.id] =
            map[planCfg.productId]?.status ===
            INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE;
        }
        setEligibility(next);
      })
      .catch((err) => {
        console.warn('[paywall] checkTrialOrIntroductoryPriceEligibility failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTrialDays = trialDaysFromPackage(selectedPkg);
  const hasTrial = selectedTrialDays != null && selectedTrialDays > 0 && eligibility[plan] === true;
  const ctaLabel = hasTrial
    ? `Start your ${selectedTrialDays}-day free trial`
    : selectedPlanCfg
      ? `Subscribe ${selectedPlanCfg.label.toLowerCase()}`
      : 'Subscribe';
  const footerCopy = hasTrial
    ? `Cancel anytime. No charge for ${selectedTrialDays} days. Then your plan auto-renews.`
    : 'Cancel anytime. Your subscription auto-renews until cancelled.';

  async function handleStartTrial() {
    if (busy) return;
    setBusy(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const result = await purchasePlan(plan);
    if (result.ok) {
      onSuccess();
      return;
    }
    setBusy(false);
    if (result.reason === 'user-cancelled') return;
    showToast({
      kind: 'error',
      message: hasTrial
        ? "Couldn't start your trial. Try again."
        : "Couldn't start your subscription. Try again.",
    });
  }

  async function handleRestore() {
    if (busy) return;
    setBusy(true);
    void Haptics.selectionAsync();
    const result = await restore();
    if (result.ok && result.entitled) {
      onSuccess();
      return;
    }
    setBusy(false);
    if (result.ok) {
      showToast({ kind: 'success', message: 'No purchases to restore.' });
      return;
    }
    showToast({ kind: 'error', message: 'Restore failed. Check your connection.' });
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="bg-bg flex-1">
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            justifyContent: 'flex-end',
          }}
        >
          {onClose ? (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={closeAccessibilityLabel}
              hitSlop={12}
              className="h-9 w-9 items-center justify-center"
            >
              <Icon name="xmark" size={18} tintColor={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <ScrollView contentContainerClassName="px-6 pb-6" showsVerticalScrollIndicator={false}>
          <View className="items-center" style={{ marginTop: 8 }}>
            <Image
              source={require('@/assets/logo.png')}
              style={{ width: 56, height: 56, borderRadius: 14 }}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
            <Text
              className="text-text mt-3"
              style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4 }}
            >
              TRIP POCKET
            </Text>
          </View>

          <Text
            className="text-text mt-6 text-center"
            style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 }}
          >
            {headline}
          </Text>
          {subtitle ?? (
            <Text
              className="text-text-muted mt-2 text-center"
              style={{ fontSize: 15, lineHeight: 22 }}
            >
              Save it now. Find it when you actually need it.
            </Text>
          )}

          <View className="mt-6" style={{ gap: 10 }}>
            {PLANS.map((planCfg) => {
              const p = planCfg.id;
              const isPicked = plan === p;
              const pkg = pkgFor(p);
              const price = pkg?.product.priceString ?? FALLBACK_PRICES[p].price;
              const per = FALLBACK_PRICES[p].per;
              const planHasTrial =
                eligibility[p] === true && pkg != null && (trialDaysFromPackage(pkg) ?? 0) > 0;
              const note = pkg
                ? buildPlanNote(planCfg, planHasTrial, yearlyPerWeekString, discountPct)
                : planHasTrial
                  ? FALLBACK_PRICES[p].trialNote
                  : FALLBACK_PRICES[p].subNote;
              return (
                <Pressable
                  key={p}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setPlan(p);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isPicked }}
                  className="bg-surface flex-row items-center rounded-2xl px-4 py-4"
                  style={{
                    borderWidth: 2,
                    borderColor: isPicked ? colors.accent : colors.hairline,
                  }}
                >
                  <View
                    className="mr-3 h-6 w-6 items-center justify-center rounded-full"
                    style={{
                      borderWidth: 1.5,
                      borderColor: isPicked ? colors.accent : colors.hairline,
                      backgroundColor: isPicked ? colors.accent : 'transparent',
                    }}
                  >
                    {isPicked ? <Icon name="checkmark" size={12} tintColor="#ffffff" /> : null}
                  </View>
                  <View className="flex-1">
                    <View className="flex-row items-baseline">
                      <Text
                        className="text-text"
                        style={{ fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }}
                      >
                        {planCfg.label}
                      </Text>
                      <Text className="text-text ml-2" style={{ fontSize: 15, fontWeight: '600' }}>
                        {price}
                        <Text className="text-text-muted" style={{ fontSize: 13 }}>
                          {per}
                        </Text>
                      </Text>
                    </View>
                    <Text
                      className="text-text-muted mt-0.5"
                      style={{ fontSize: 12, lineHeight: 18 }}
                    >
                      {note}
                    </Text>
                  </View>
                  {planCfg.badge ? (
                    <View
                      className="ml-2 rounded-md px-2 py-1"
                      style={{ backgroundColor: colors.accent }}
                    >
                      <Text
                        style={{
                          color: '#ffffff',
                          fontSize: 10,
                          fontWeight: '800',
                          letterSpacing: 0.4,
                        }}
                      >
                        {planCfg.badge}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        <View
          className="border-hairline bg-bg border-t px-6 pt-3"
          style={{ paddingBottom: Math.max(16, insets.bottom) }}
        >
          <PrimaryButton label={ctaLabel} onPress={handleStartTrial} loading={busy} />
          <Text
            className="text-text-muted mt-2 text-center"
            style={{ fontSize: 11, lineHeight: 16 }}
          >
            {footerCopy}
          </Text>
          <View className="mt-2 flex-row items-center justify-center" style={{ gap: 14 }}>
            <Pressable
              onPress={handleRestore}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Restore purchases"
              style={{ opacity: busy ? 0.5 : 1 }}
            >
              <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
                Restore purchases
              </Text>
            </Pressable>
            <Text className="text-text-muted" style={{ fontSize: 12 }}>
              ·
            </Text>
            <Pressable
              onPress={() => void Linking.openURL(TERMS_URL)}
              accessibilityRole="link"
              accessibilityLabel="Terms"
            >
              <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
                Terms
              </Text>
            </Pressable>
            <Text className="text-text-muted" style={{ fontSize: 12 }}>
              ·
            </Text>
            <Pressable
              onPress={() => void Linking.openURL(PRIVACY_URL)}
              accessibilityRole="link"
              accessibilityLabel="Privacy"
            >
              <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
                Privacy
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </>
  );
}
