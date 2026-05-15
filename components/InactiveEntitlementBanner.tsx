import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, Text, View } from '@/tw';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import { LAPSE_PAYWALL_ROUTE, openLapsePaywall } from '@/lib/paywall/openLapsePaywall';
import type { EntitlementStatus } from '@/lib/entitlement/status';

export type InactiveEntitlementBannerProps = {
  status: 'loading' | EntitlementStatus;
  needsOnboarding: boolean;
  pathname: string;
};

function shouldShow(props: InactiveEntitlementBannerProps): boolean {
  if (props.status !== 'inactive') return false;
  // Don't show during first-run onboarding — the paywall is the gate.
  if (props.needsOnboarding) return false;
  if (props.pathname.startsWith('/onboarding')) return false;
  // Don't shadow the paywall itself.
  if (props.pathname.startsWith(LAPSE_PAYWALL_ROUTE)) return false;
  return true;
}

/**
 * Persistent top banner shown across the app when the user's subscription is
 * inactive. Tapping it opens the lapse paywall as a dismissible modal — the
 * banner remains the single entry point for resume so the user is never
 * surprised by an autopop.
 */
export function InactiveEntitlementBanner(props: InactiveEntitlementBannerProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  if (!shouldShow(props)) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        // Slot below the status bar / notch.
        paddingTop: insets.top,
        paddingHorizontal: 12,
      }}
      testID="inactive-entitlement-banner"
    >
      <Pressable
        onPress={() => openLapsePaywall(router, props.pathname)}
        accessibilityRole="button"
        accessibilityLabel="Subscription inactive. Tap to resume."
        className="bg-warning-bg mt-1 flex-row items-center gap-2 rounded-2xl px-3 py-2"
        style={{ borderWidth: 1, borderColor: 'rgba(146, 64, 14, 0.18)' }}
      >
        <Icon name="exclamationmark.circle.fill" size={16} tintColor={colors.warningText} />
        <Text className="text-warning-text flex-1 text-[13px] font-semibold">
          Subscription inactive — tap to resume
        </Text>
        <Icon name="chevron.right" size={12} tintColor={colors.warningText} />
      </Pressable>
    </View>
  );
}
