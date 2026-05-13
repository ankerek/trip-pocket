import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { useRouter, Stack } from 'expo-router';
import { Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useThemeColors } from '@/tw/theme';
import { markOnboardingComplete } from '@/lib/onboarding/storage';

// Screen 12 — Paywall. PLACEHOLDER. PRODUCT.md specifies 7-day free trial,
// then auto-renewing monthly or yearly. Wire this to RevenueCat (or
// StoreKit + expo-iap) before App Store submission.
//
// Tap-flow:
//   "Start your 7-day free trial" → TODO: kick off StoreKit purchase →
//   mark onboarding complete → navigate to /(tabs).
// "Restore purchases" → TODO: query existing entitlement →
//   mark onboarding complete → navigate to /(tabs).

type Plan = 'yearly' | 'monthly';

const PLANS: Record<Plan, { price: string; per: string; note: string; badge?: string }> = {
  // TODO replace with real App Store SKU pricing pulled from StoreKit
  yearly: { price: '$39.99', per: '/yr', note: 'Save 50% — billed yearly after trial', badge: 'BEST VALUE' },
  monthly: { price: '$6.99', per: '/mo', note: 'Billed monthly after trial' },
};

export default function PaywallScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [plan, setPlan] = useState<Plan>('yearly');

  function handleStartTrial() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // TODO(@cong): wire to RevenueCat / expo-iap. The placeholder below
    // simulates a successful purchase so the rest of the flow is
    // exercisable end-to-end during dev. Replace before launch.
    markOnboardingComplete();
    router.replace('/(tabs)/(places)');
  }

  function handleRestore() {
    void Haptics.selectionAsync();
    // TODO(@cong): query StoreKit for an existing entitlement, mark
    // complete and navigate on success; otherwise show a "no purchases
    // found" message. For dev, treat restore as a successful unlock so
    // QA can iterate on the post-onboarding app.
    markOnboardingComplete();
    router.replace('/(tabs)/(places)');
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
          {/* "x" lets developers exit without paying during dev; the
               markOnboardingComplete keeps QA un-blocked. The "x" stays in
               the App Store build but reads as "Maybe later" — Apple
               requires a visible decline path on subscription paywalls. */}
          <Pressable
            onPress={() => {
              markOnboardingComplete();
              router.replace('/(tabs)/(places)');
            }}
            accessibilityRole="button"
            accessibilityLabel="Close paywall"
            hitSlop={12}
            className="h-9 w-9 items-center justify-center"
          >
            <Icon name="xmark" size={18} tintColor={colors.textMuted} />
          </Pressable>
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
            Your pocket for{'\n'}travel ideas.
          </Text>
          <Text
            className="mt-2 text-center text-text-muted"
            style={{ fontSize: 15, lineHeight: 22 }}
          >
            Capture screenshots. The AI finds the place. One tap opens Maps when you arrive.
          </Text>

          {/* Featured testimonial — replace with a real App Store review */}
          <View
            className="mt-6 rounded-2xl border border-hairline bg-surface px-4 py-4"
          >
            <View className="flex-row" style={{ gap: 2 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <Icon key={i} name="star.fill" size={13} tintColor={colors.accent} />
              ))}
            </View>
            <Text
              className="mt-2 text-text"
              style={{ fontSize: 15, lineHeight: 22, fontWeight: '500' }}
            >
              “I finally stopped re-Googling the same cafés. It&apos;s just there.”
            </Text>
            <Text className="mt-2 text-text-muted" style={{ fontSize: 12 }}>
              — Maya, Tokyo five times in two years
            </Text>
          </View>

          {/* Plan pills */}
          <View className="mt-6" style={{ gap: 10 }}>
            {(['yearly', 'monthly'] as Plan[]).map((p) => {
              const isPicked = plan === p;
              const cfg = PLANS[p];
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
                        {p === 'yearly' ? 'Yearly' : 'Monthly'}
                      </Text>
                      <Text className="ml-2 text-text" style={{ fontSize: 15, fontWeight: '600' }}>
                        {cfg.price}
                        <Text className="text-text-muted" style={{ fontSize: 13 }}>{cfg.per}</Text>
                      </Text>
                    </View>
                    <Text className="mt-0.5 text-text-muted" style={{ fontSize: 12, lineHeight: 18 }}>
                      {cfg.note}
                    </Text>
                  </View>
                  {cfg.badge ? (
                    <View
                      className="ml-2 rounded-md px-2 py-1"
                      style={{ backgroundColor: colors.accent }}
                    >
                      <Text
                        style={{ color: '#ffffff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 }}
                      >
                        {cfg.badge}
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
            label="Start your 7-day free trial"
            onPress={handleStartTrial}
          />
          <Text
            className="mt-2 text-center text-text-muted"
            style={{ fontSize: 11, lineHeight: 16 }}
          >
            Cancel anytime. No charge for 7 days. Then your plan auto-renews.
          </Text>
          <View
            className="mt-2 flex-row items-center justify-center"
            style={{ gap: 14 }}
          >
            <Pressable
              onPress={handleRestore}
              accessibilityRole="button"
              accessibilityLabel="Restore purchases"
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
