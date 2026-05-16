import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import type { CustomerInfo, PurchasesOfferings } from 'react-native-purchases';
import { Pressable, Text, View } from '@/tw';
import { useEntitlement } from '@/lib/entitlement/provider';
import { ENTITLEMENT_KEY } from '@/lib/entitlement/status';
import { PLANS, type PlanConfig, type PlanId } from '@/lib/entitlement/plans';
import { MANAGE_SUBSCRIPTION_URL } from '@/lib/links';
import { LAPSE_PAYWALL_ROUTE } from '@/lib/paywall/openLapsePaywall';
import { SectionHeader } from './SectionHeader';
import { SettingsRow } from './SettingsRow';

// Localized price fallbacks used while RC offerings are still loading or
// unavailable. Mirrors the table in PaywallBody so settings reads the same
// numbers on the rare frame before `offerings` resolves.
const FALLBACK_PRICE: Record<PlanId, string> = {
  yearly: '$39.99',
  weekly: '$3.99',
};

const PER_SUFFIX: Record<PlanId, string> = {
  yearly: '/yr',
  weekly: '/wk',
};

const FULL_PERIOD: Record<PlanId, string> = {
  yearly: 'year',
  weekly: 'week',
};

export function SubscriptionSection() {
  const router = useRouter();
  const { status, customerInfo, offerings, restore } = useEntitlement();

  const onRestore = async () => {
    const result = await restore();
    if (!result.ok) {
      Alert.alert('Couldn’t restore', 'Please check your connection and try again.');
      return;
    }
    if (result.entitled) {
      Alert.alert('Restored', 'Your subscription is active.');
    } else {
      Alert.alert('Nothing to restore', 'No active subscription was found on this Apple ID.');
    }
  };

  const openManage = async () => {
    try {
      await Linking.openURL(MANAGE_SUBSCRIPTION_URL);
    } catch {
      Alert.alert('Couldn’t open', 'Please try again.');
    }
  };

  const openPaywall = () => {
    router.push(LAPSE_PAYWALL_ROUTE);
  };

  return (
    <View>
      <SectionHeader label="SUBSCRIPTION" />

      {status === 'loading' ? (
        <StatusBanner label="Checking subscription…" tone="muted" />
      ) : status === 'inactive' ? (
        <InactiveState offerings={offerings} onChoose={openPaywall} />
      ) : (
        <ActiveState
          customerInfo={customerInfo}
          offerings={offerings}
          onManage={() => void openManage()}
        />
      )}

      <RestorePurchasesLink onPress={() => void onRestore()} />
    </View>
  );
}

function InactiveState({
  offerings,
  onChoose,
}: {
  offerings: PurchasesOfferings | null;
  onChoose: () => void;
}) {
  return (
    <View>
      <StatusBanner label="You’re on the free plan" tone="muted" />
      <View className="mt-2" style={{ gap: 8 }}>
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            price={priceFor(plan, offerings)}
            subtitle={subscribeSubtitle(plan)}
            onPress={onChoose}
            accessibilityLabel={`Subscribe ${plan.label.toLowerCase()}`}
          />
        ))}
      </View>
    </View>
  );
}

function ActiveState({
  customerInfo,
  offerings,
  onManage,
}: {
  customerInfo: CustomerInfo | null;
  offerings: PurchasesOfferings | null;
  onManage: () => void;
}) {
  const entitlement = customerInfo?.entitlements.active[ENTITLEMENT_KEY];
  const currentPlan = entitlement ? planFromProductId(entitlement.productIdentifier) : null;
  const isTrial = entitlement?.periodType === 'TRIAL';
  const willRenew = entitlement?.willRenew ?? true;
  const periodDate = entitlement?.expirationDate ?? null;

  if (!entitlement || !currentPlan) {
    // Cached active status without resolved customerInfo, or product ID we
    // don't recognise (legacy SKU). Keep things minimal and lean on the
    // manage sheet for anything specific.
    return (
      <View>
        <CurrentPlanCard title="Pro" subtitle="Subscription active." />
        <SettingsRow
          title="Manage subscription"
          subtitle="Opens your Apple ID subscription settings."
          onPress={onManage}
          accessibilityLabel="Manage subscription"
        />
      </View>
    );
  }

  if (isTrial) {
    return (
      <View>
        <CurrentPlanCard
          title={`Free trial · ${currentPlan.label} Pro`}
          subtitle={trialSubtitle(currentPlan, periodDate, priceFor(currentPlan, offerings))}
        />
        <SettingsRow
          title="Cancel trial"
          subtitle="Opens your Apple ID subscription settings."
          onPress={onManage}
          accessibilityLabel="Cancel trial"
        />
      </View>
    );
  }

  if (!willRenew) {
    return (
      <View>
        <CurrentPlanCard
          title={`${currentPlan.label} Pro · Won’t renew`}
          subtitle={accessUntilSubtitle(periodDate)}
        />
        <SettingsRow
          title="Resume subscription"
          subtitle="Opens your Apple ID subscription settings."
          onPress={onManage}
          accessibilityLabel="Resume subscription"
        />
      </View>
    );
  }

  const other = otherPlan(currentPlan.id);
  return (
    <View>
      <CurrentPlanCard
        title={`${currentPlan.label} Pro · ${priceFor(currentPlan, offerings)}${PER_SUFFIX[currentPlan.id]}`}
        subtitle={renewsSubtitle(periodDate)}
      />
      {other ? (
        <View className="mt-2">
          <PlanCard
            plan={other}
            price={priceFor(other, offerings)}
            subtitle={`Switch to ${other.label.toLowerCase()} in Apple Subscriptions.`}
            onPress={onManage}
            accessibilityLabel={`Switch to ${other.label.toLowerCase()}`}
          />
        </View>
      ) : null}
      <SettingsRow
        title="Cancel or change plan"
        subtitle="Opens your Apple ID subscription settings."
        onPress={onManage}
        accessibilityLabel="Cancel or change plan"
      />
    </View>
  );
}

function StatusBanner({ label, tone }: { label: string; tone: 'muted' | 'accent' }) {
  const bg = tone === 'accent' ? 'rgba(20, 184, 166, 0.1)' : 'rgba(100, 116, 139, 0.08)';
  return (
    <View className="mt-4 rounded-2xl px-4 py-3" style={{ backgroundColor: bg }}>
      <Text className="text-text" style={{ fontSize: 15, fontWeight: '600' }}>
        {label}
      </Text>
    </View>
  );
}

function CurrentPlanCard({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View
      className="mt-4 rounded-2xl px-4 py-4"
      style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
    >
      <Text className="text-text" style={{ fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }}>
        {title}
      </Text>
      {subtitle ? (
        <Text className="text-text-muted mt-1" style={{ fontSize: 12, lineHeight: 18 }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

function PlanCard({
  plan,
  price,
  subtitle,
  onPress,
  accessibilityLabel,
}: {
  plan: PlanConfig;
  price: string;
  subtitle: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className="rounded-2xl px-4 py-3"
      style={{ backgroundColor: 'rgba(20, 184, 166, 0.08)' }}
    >
      <View className="flex-row items-center">
        <View className="flex-1 pr-3">
          <View className="flex-row items-baseline">
            <Text className="text-text" style={{ fontSize: 16, fontWeight: '700' }}>
              {plan.label}
            </Text>
            <Text className="text-text ml-2" style={{ fontSize: 14, fontWeight: '600' }}>
              {price}
              <Text className="text-text-muted" style={{ fontSize: 12 }}>
                {PER_SUFFIX[plan.id]}
              </Text>
            </Text>
          </View>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12, lineHeight: 18 }}>
            {subtitle}
          </Text>
        </View>
        {plan.badge ? (
          <View className="ml-2 rounded-md px-2 py-1" style={{ backgroundColor: '#14b8a6' }}>
            <Text style={{ color: '#ffffff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 }}>
              {plan.badge}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function RestorePurchasesLink({ onPress }: { onPress: () => void }) {
  return (
    <View className="mt-4 items-center">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Restore purchases"
        hitSlop={12}
      >
        <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
          Restore purchases
        </Text>
      </Pressable>
    </View>
  );
}

function planFromProductId(productId: string): PlanConfig | null {
  return PLANS.find((p) => p.productId === productId) ?? null;
}

function otherPlan(currentId: PlanId): PlanConfig | null {
  return PLANS.find((p) => p.id !== currentId) ?? null;
}

function priceFor(plan: PlanConfig, offerings: PurchasesOfferings | null): string {
  const pkg = offerings?.current?.availablePackages.find(
    (p) => p.product.identifier === plan.productId,
  );
  return pkg?.product.priceString ?? FALLBACK_PRICE[plan.id];
}

function subscribeSubtitle(plan: PlanConfig): string {
  if (plan.id === 'yearly') return 'Best value · Cancel anytime.';
  return 'Billed weekly · Cancel anytime.';
}

function renewsSubtitle(iso: string | null): string {
  const date = formatDate(iso);
  return date ? `Renews ${date}.` : 'Auto-renews each period.';
}

function accessUntilSubtitle(iso: string | null): string {
  const date = formatDate(iso);
  return date ? `Access until ${date}.` : 'Your subscription won’t renew.';
}

function trialSubtitle(plan: PlanConfig, iso: string | null, price: string): string {
  const date = formatDate(iso);
  const trailer = `Then ${price}/${FULL_PERIOD[plan.id]}.`;
  return date ? `Trial ends ${date}. ${trailer}` : trailer;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
