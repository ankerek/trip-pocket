import { ActivityIndicator } from 'react-native';
import { Text, View } from '@/tw';
import { useThemeColors } from '@/tw/theme';

type StatusPillProps = {
  label: string;
  testID?: string;
};

/** Small inline chip: spinner + label. Used by Place Detail while
 * enrichment is in flight. */
export function StatusPill({ label, testID }: StatusPillProps) {
  const colors = useThemeColors();
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID ?? 'status-pill'}
      className="flex-row items-center gap-2 self-start rounded-full bg-info-bg px-3 py-1.5"
    >
      <ActivityIndicator size="small" color={colors.infoText} />
      <Text className="text-[12px] font-semibold text-info-text">{label}</Text>
    </View>
  );
}
