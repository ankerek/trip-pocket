import { Text, View } from '@/tw';
import { Icon } from './Icon';

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  food: { icon: 'fork.knife', label: 'Food' },
  activity: { icon: 'figure.walk', label: 'Activity' },
  place: { icon: 'mappin.circle', label: 'Place' },
};

export function CategoryChip({ category }: { category: string }) {
  const meta = CATEGORY_META[category];
  if (!meta) return null;
  return (
    <View
      className="flex-row items-center gap-1 rounded-full px-2.5 py-1"
      style={{ backgroundColor: 'rgba(15,23,42,0.06)' }}
    >
      <Icon name={meta.icon} size={12} tintColor="#475569" />
      <Text style={{ fontSize: 12, fontWeight: '500', color: '#475569' }}>
        {meta.label}
      </Text>
    </View>
  );
}
