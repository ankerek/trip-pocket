import { View } from '@/tw';
import { Icon } from './Icon';

/**
 * Neutral-state badge for a thumbnail: "we processed this and didn't
 * find anything to save." Subordinate to PinBadge — same position, but
 * reduced opacity and system-gray tint so the positive signal stands
 * out and "no places" reads as informational. Lets the user spot junk
 * imports and confidently delete.
 *
 * Failures (ocr_status='failed' or extraction_status='failed') do NOT
 * render this badge — failure could be transient (recoverable on next
 * launch via runStartupRecovery), so any "no places" cue would be a
 * false signal.
 */
export function NoPlacesBadge() {
  return (
    <View
      pointerEvents="none"
      testID="no-places-badge"
      className="absolute right-1.5 bottom-1.5 h-6 w-6 items-center justify-center rounded-full bg-slate-500/60"
    >
      <Icon name="mappin.slash" size={14} tintColor="#ffffff" />
    </View>
  );
}
