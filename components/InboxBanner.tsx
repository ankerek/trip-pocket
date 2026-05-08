import { Pressable, Text, View } from '@/tw';
import { Icon } from '@/components/Icon';

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
  if (count === 0) return null;
  const label = `${count} new screenshot${count === 1 ? '' : 's'} to triage`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the triage flow"
      className="mx-3.5 mb-2 mt-1 flex-row items-center gap-3 rounded-2xl px-3 py-3"
      style={{
        backgroundColor: '#ccfbf1',
        borderWidth: 1,
        borderColor: 'rgba(17, 94, 89, 0.10)',
      }}
    >
      <View
        className="h-8 min-w-[32px] items-center justify-center rounded-lg px-2"
        style={{ backgroundColor: '#0f766e' }}
      >
        <Text className="text-sm font-bold text-white" style={{ fontVariant: ['tabular-nums'] }}>
          {count}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-[15px] font-semibold" style={{ color: '#115e59' }}>
          New screenshots
        </Text>
        <Text className="text-xs" style={{ color: '#0f766e' }}>
          Tap to triage
        </Text>
      </View>
      <Icon name="chevron.right" size={18} tintColor="#115e59" />
    </Pressable>
  );
}
