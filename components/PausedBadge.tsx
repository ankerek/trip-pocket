import { Text, View } from '@/tw';
import { Icon } from './Icon';
import { useThemeColors } from '@/tw/theme';

/**
 * Entitlement-paused state badge for a thumbnail: "the pipeline stopped on
 * this row because the subscription is inactive." Bottom-edge chip with the
 * subscription-required copy so the user understands cause at a glance. The
 * parent tile is responsible for routing taps to the lapse paywall.
 */
export function PausedBadge() {
  const colors = useThemeColors();
  return (
    <View
      pointerEvents="none"
      testID="paused-badge"
      className="bg-warning-bg absolute right-1.5 bottom-1.5 left-1.5 flex-row items-center gap-1 rounded-md px-2 py-1"
    >
      <Icon name="lock.fill" size={11} tintColor={colors.warningText} />
      <Text className="text-warning-text flex-1 text-[11px] font-semibold" numberOfLines={1}>
        Subscription required
      </Text>
    </View>
  );
}
