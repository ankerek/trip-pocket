import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack } from 'expo-router';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { PurchasesPackage } from 'react-native-purchases';
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
import { showToast } from '@/lib/toast/toast';

const FALLBACK_PRICES: Record<PlanId, { price: string; per: string; note: string }> = {
  yearly: { price: '$39.99', per: '/yr', note: 'Save 83%. Billed yearly after the trial.' },
  weekly: { price: '$4.49', per: '/wk', note: 'Billed weekly after the trial.' },
};

function deriveNoteFromPackage(_pkg: PurchasesPackage, plan: PlanConfig): string {
  return `Billed ${plan.label.toLowerCase()} after the trial.`;
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
  const { offerings, purchasePlan, restore } = useEntitlement();

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
    showToast({ kind: 'error', message: "Couldn't start your trial. Try again." });
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
            <View
              className="h-12 w-12 items-center justify-center rounded-2xl"
              style={{ backgroundColor: colors.accent }}
            >
              <Icon name="tray.full" size={26} tintColor="#ffffff" />
            </View>
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
                  className="bg-surface flex-row items-center rounded-2xl px-4 py-4"
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
          <PrimaryButton label={trialCtaLabel} onPress={handleStartTrial} loading={busy} />
          <Text
            className="text-text-muted mt-2 text-center"
            style={{ fontSize: 11, lineHeight: 16 }}
          >
            {trialFooterCopy}
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
              onPress={() => void Linking.openURL('https://trippocket.app/terms')}
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
