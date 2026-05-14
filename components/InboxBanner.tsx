import { Pressable, Text, View } from '@/tw';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';

type InboxBannerProps = {
  count: number;
  onPress: () => void;
};

/**
 * Banner shown at the top of Pocket when there are untriaged sources.
 * Spec §4.1 — Mint background, Sea text, dismissible chevron.
 *
 * The triage flow it routes to is built in phase 5; until then the
 * caller can route to the existing /sources/[id] flow per item or
 * stub a placeholder.
 */
export function InboxBanner({ count, onPress }: InboxBannerProps) {
  const colors = useThemeColors();
  if (count === 0) return null;
  const label = `${count} new source${count === 1 ? '' : 's'} to triage`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the triage flow"
      className="bg-info-bg mx-3.5 mt-1 mb-2 flex-row items-center gap-3 rounded-2xl px-3 py-3"
      style={{
        borderWidth: 1,
        borderColor: 'rgba(17, 94, 89, 0.10)',
      }}
    >
      <View className="bg-accent-strong h-8 min-w-[32px] items-center justify-center rounded-lg px-2">
        <Text className="text-sm font-bold text-white" style={{ fontVariant: ['tabular-nums'] }}>
          {count}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-info-text text-[15px] font-semibold">New sources</Text>
        <Text className="text-info-text text-xs" style={{ opacity: 0.85 }}>
          Tap to triage
        </Text>
      </View>
      <Icon name="chevron.right" size={18} tintColor={colors.infoText} />
    </Pressable>
  );
}
