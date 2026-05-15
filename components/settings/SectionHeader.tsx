import { Text, View } from '@/tw';

type Props = {
  label: string;
  hint?: string;
};

export function SectionHeader({ label, hint }: Props) {
  return (
    <View className="mt-8">
      <Text
        className="text-text-muted"
        style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}
      >
        {label}
      </Text>
      {hint ? <Text className="text-text-muted mt-1 text-xs">{hint}</Text> : null}
    </View>
  );
}
