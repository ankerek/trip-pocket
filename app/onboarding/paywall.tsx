import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { PurchasesPackage } from 'react-native-purchases';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useThemeColors } from '@/tw/theme';
import { markOnboardingComplete } from '@/lib/onboarding/storage';
import { useOnboarding, type Destination } from '@/lib/onboarding/state';
import { PLANS, DEFAULT_SELECTED_PLAN, type PlanId, type PlanConfig } from '@/lib/entitlement/plans';
import { useEntitlement } from '@/lib/entitlement/provider';
import { showToast } from '@/lib/toast/toast';

// Screen 6 — Paywall.
//
// Tap-flow:
//   "Start your N-day free trial" → purchasePlan() via RevenueCat →
//   mark onboarding complete → navigate to /(tabs).
// "Restore purchases" → restore() via RevenueCat →
//   mark onboarding complete → navigate to /(tabs).

const FALLBACK_PRICES: Record<PlanId, { price: string; per: string; note: string }> = {
  yearly: { price: '$39.99', per: '/yr', note: 'Save 83%. Billed yearly after the trial.' },
  weekly: { price: '$4.49', per: '/wk', note: 'Billed weekly after the trial.' },
};

function deriveNoteFromPackage(pkg: PurchasesPackage, plan: PlanConfig): string {
  // priceString is localized by RC. Compose the same human note we had before.
  return `Billed ${plan.label.toLowerCase()} after the trial.`;
}

function trialDaysFromPackage(pkg: PurchasesPackage | undefined): number | null {
  const period = pkg?.product.introPrice?.periodNumberOfUnits;
  const unit = pkg?.product.introPrice?.periodUnit;
  if (period == null || unit == null) return null;
  switch (unit) {
    case 'DAY':   return period;
    case 'WEEK':  return period * 7;
    case 'MONTH': return period * 30;
    case 'YEAR':  return period * 365;
    default:      return null;
  }
}

// Hand-written per-destination headline. DESTINATION_LABEL alone produces
// awkward strings ("Your US road trip trip starts here.") so each value is
// authored individually. Spec: 2026-05-13-onboarding-redesign-design.md.
const PAYWALL_HEADLINE: Record<Destination, string> = {
  japan: 'Your Japan trip starts here.',
  sea: 'Your Southeast Asia trip starts here.',
  europe: 'Your Europe trip starts here.',
  'us-roadtrip': 'Your US road trip starts here.',
  'city-break': 'Your city break starts here.',
  'bucket-list': 'Your bucket list starts here.',
  general: 'Your next trip starts here.',
};
const FALLBACK_HEADLINE = 'Your next trip starts here.';

export default function PaywallScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: 'first-run' | 'lapse' }>();
  const isLapseMode = params.mode === 'lapse';
  const [plan, setPlan] = useState<PlanId>(DEFAULT_SELECTED_PLAN);
  const [busy, setBusy] = useState(false);
  const { answers } = useOnboarding();
  const { offerings, purchasePlan, restore } = useEntitlement();
  const headline = isLapseMode
    ? 'Welcome back to Trip Pocket'
    : (answers.destination ? PAYWALL_HEADLINE[answers.destination] : FALLBACK_HEADLINE);

  const selectedPlanCfg = PLANS.find((pl) => pl.id === plan);
  const selectedPkg = offerings?.current?.availablePackages.find(
    (p) => p.product.identifier === selectedPlanCfg?.productId,
  );
  const trialDays = trialDaysFromPackage(selectedPkg);
  const trialCtaLabel = trialDays
    ? `Start your ${trialDays}-day free trial`
    : 'Start your free trial';
  const trialFooterCopy = trialDays
    ? `Cancel anytime. No charge for ${trialDays} days. Then your plan auto-renews.`
    : 'Cancel anytime during the free trial. Then your plan auto-renews.';

  function exitOnboarding() {
    // The paywall sits inside two nested Stacks:
    //   root Stack [ (tabs), onboarding (fullScreenModal) ]
    //     └── onboarding Stack [ index, destination, …, paywall ]
    // router.dismissAll() only targets the *closest* Stack, so on its
    // own it pops the inner Stack back to /onboarding (Welcome) and
    // leaves the modal mounted — the user lands on the start of
    // onboarding again. We follow it with router.dismiss() to pop the
    // modal off the root Stack so (tabs) becomes visible underneath.
    router.dismissAll();
    router.dismiss();
  }

  async function handleStartTrial() {
    if (busy) return;
    setBusy(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const result = await purchasePlan(plan);
    setBusy(false);
    if (result.ok) {
      markOnboardingComplete();
      exitOnboarding();
      return;
    }
    if (result.reason === 'user-cancelled') return;       // silent
    showToast({ kind: 'error', message: "Couldn't start your trial. Try again." });
  }

  async function handleRestore() {
    if (busy) return;
    setBusy(true);
    void Haptics.selectionAsync();
    const result = await restore();
    setBusy(false);
    if (result.ok && result.entitled) {
      markOnboardingComplete();
      exitOnboarding();
      return;
    }
    if (result.ok) {
      showToast({ kind: 'success', message: 'No purchases to restore.' });
      return;
    }
    showToast({ kind: 'error', message: 'Restore failed. Check your connection.' });
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-bg">
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            flexDirection: 'row',
            justifyContent: 'flex-end',
          }}
        >
          {/* Dev-only escape hatch. App Store builds must complete the paywall. */}
          {__DEV__ && (
            <Pressable
              onPress={() => {
                markOnboardingComplete();
                exitOnboarding();
              }}
              accessibilityRole="button"
              accessibilityLabel="Close paywall"
              hitSlop={12}
              className="h-9 w-9 items-center justify-center"
            >
              <Icon name="xmark" size={18} tintColor={colors.textMuted} />
            </Pressable>
          )}
        </View>

        <ScrollView
          contentContainerClassName="px-6 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {/* App lockup */}
          <View className="items-center" style={{ marginTop: 8 }}>
            <View
              className="h-12 w-12 items-center justify-center rounded-2xl"
              style={{ backgroundColor: colors.accent }}
            >
              <Icon name="tray.full" size={26} tintColor="#ffffff" />
            </View>
            <Text
              className="mt-3 text-text"
              style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4 }}
            >
              TRIP POCKET
            </Text>
          </View>

          <Text
            className="mt-6 text-center text-text"
            style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 }}
          >
            {headline}
          </Text>
          <Text
            className="mt-2 text-center text-text-muted"
            style={{ fontSize: 15, lineHeight: 22 }}
          >
            Save it now. Find it when you actually need it.
          </Text>

          {/* Plan pills */}
          <View className="mt-6" style={{ gap: 10 }}>
            {PLANS.map((planCfg) => {
              const p = planCfg.id;
              const isPicked = plan === p;
              const pkg = offerings?.current?.availablePackages.find(
                (pkg) => pkg.product.identifier === planCfg.productId,
              );
              const price = pkg?.product.priceString ?? FALLBACK_PRICES[p].price;
              const per = FALLBACK_PRICES[p].per;
              const note = pkg ? deriveNoteFromPackage(pkg, planCfg) : FALLBACK_PRICES[p].note;
              return (
                <Pressable
                  key={p}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setPlan(p);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isPicked }}
                  className="rounded-2xl bg-surface px-4 py-4 flex-row items-center"
                  style={{
                    borderWidth: isPicked ? 2 : 1,
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
                      <Text className="ml-2 text-text" style={{ fontSize: 15, fontWeight: '600' }}>
                        {price}
                        <Text className="text-text-muted" style={{ fontSize: 13 }}>{per}</Text>
                      </Text>
                    </View>
                    <Text className="mt-0.5 text-text-muted" style={{ fontSize: 12, lineHeight: 18 }}>
                      {note}
                    </Text>
                  </View>
                  {planCfg.badge ? (
                    <View
                      className="ml-2 rounded-md px-2 py-1"
                      style={{ backgroundColor: colors.accent }}
                    >
                      <Text
                        style={{ color: '#ffffff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 }}
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
          className="border-t border-hairline bg-bg px-6 pt-3"
          style={{ paddingBottom: Math.max(16, insets.bottom) }}
        >
          <PrimaryButton
            label={trialCtaLabel}
            onPress={handleStartTrial}
            disabled={busy}
          />
          <Text
            className="mt-2 text-center text-text-muted"
            style={{ fontSize: 11, lineHeight: 16 }}
          >
            {trialFooterCopy}
          </Text>
          <View
            className="mt-2 flex-row items-center justify-center"
            style={{ gap: 14 }}
          >
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
            <Text className="text-text-muted" style={{ fontSize: 12 }}>·</Text>
            <Pressable
              onPress={() => void Linking.openURL('https://trippocket.app/terms')}
              accessibilityRole="link"
              accessibilityLabel="Terms"
            >
              <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
                Terms
              </Text>
            </Pressable>
            <Text className="text-text-muted" style={{ fontSize: 12 }}>·</Text>
            <Pressable
              onPress={() => void Linking.openURL('https://trippocket.app/privacy')}
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
