import { Text, View } from '@/tw';

type Variant = 'overlay' | 'inline';

/**
 * Single source of truth for trip-name pills.
 *
 * - `overlay` sits on top of a photo (PlaceTile). Colors are photo-aware,
 *   not theme-aware: a translucent-white pill with dark-blue text reads
 *   against any image and stays the same in light + dark mode.
 * - `inline` sits on a themed surface (search results). Uses the info-bg /
 *   info-text token pair so it flips with the system theme.
 */
export function TripChip({ name, variant = 'inline' }: { name: string; variant?: Variant }) {
  if (variant === 'overlay') {
    return (
      <View
        className="rounded-full px-2 py-0.5"
        style={{ backgroundColor: 'rgba(255,255,255,0.85)' }}
      >
        <Text className="text-[11px] font-semibold" numberOfLines={1} style={{ color: '#0c4a6e' }}>
          {name}
        </Text>
      </View>
    );
  }
  return (
    <View className="bg-info-bg rounded-full px-2.5 py-1">
      <Text className="text-info-text text-xs font-medium" numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}
