import { View } from '@/tw';
import { Icon } from './Icon';

/**
 * Positive-state badge for a thumbnail: "we extracted at least one place
 * from this screenshot." Bottom-right corner overlay, full opacity,
 * system-blue. Visually dominant — this is the signal a user is looking
 * for when scanning the grid.
 */
export function PinBadge() {
  return (
    <View
      pointerEvents="none"
      testID="pin-badge"
      className="absolute bottom-1.5 right-1.5 h-6 w-6 items-center justify-center rounded-full bg-blue-500/90"
    >
      <Icon name="mappin" size={14} tintColor="#ffffff" />
    </View>
  );
}
