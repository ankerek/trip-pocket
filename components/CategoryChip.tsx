import { Text, View } from '@/tw';
import { Icon } from './Icon';
import { useThemeColors } from '@/tw/theme';

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  food: { icon: 'fork.knife', label: 'Food' },
  activity: { icon: 'figure.walk', label: 'Activity' },
  place: { icon: 'mappin.circle', label: 'Place' },
};

export function CategoryChip({ category }: { category: string }) {
  const meta = CATEGORY_META[category];
  const colors = useThemeColors();
  if (!meta) return null;
  return (
    <View className="flex-row items-center gap-1 rounded-full bg-hairline px-2.5 py-1">
      <Icon name={meta.icon} size={12} tintColor={colors.textMuted} />
      <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '500' }}>
        {meta.label}
      </Text>
    </View>
  );
}
