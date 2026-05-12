import { ActivityIndicator } from 'react-native';
import { Text, View } from '@/tw';
import { useThemeColors } from '@/tw/theme';

type ProcessingBannerProps = {
  count: number;
};

/**
 * Banner shown on screens that host an "add screenshots" entry point (Pocket,
 * Trip Detail) while OCR or AI extraction is still running on any source.
 *
 * Renders `null` at count=0 so it can be dropped into a list header without
 * conditional layout work. The count comes from a live query over `sources`
 * using the `PROCESSING_SOURCES_WHERE` fragment.
 */
export function ProcessingBanner({ count }: ProcessingBannerProps) {
  const colors = useThemeColors();
  if (count === 0) return null;
  const label = `Processing ${count} source${count === 1 ? '' : 's'}…`;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      testID="processing-banner"
      className="mx-3.5 mb-2 mt-1 flex-row items-center gap-3 rounded-2xl bg-info-bg px-3 py-3"
      style={{ borderWidth: 1, borderColor: 'rgba(17, 94, 89, 0.10)' }}
    >
      <ActivityIndicator size="small" color={colors.infoText} />
      <Text className="flex-1 text-[14px] font-semibold text-info-text">{label}</Text>
    </View>
  );
}
