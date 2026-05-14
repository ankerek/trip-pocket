import { Pressable, Text, View } from '@/tw';
import { Icon } from './Icon';

type EmptyStateProps = {
  icon: string;
  title: string;
  body?: string;
  cta?: {
    label: string;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  };
};

export function EmptyState({ icon, title, body, cta }: EmptyStateProps) {
  return (
    <View className="bg-bg flex-1 items-center justify-center px-8">
      <View
        className="h-14 w-14 items-center justify-center rounded-full"
        style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
      >
        <Icon name={icon} size={26} tintColor="#14b8a6" />
      </View>
      <Text
        className="text-text mt-4 text-center"
        style={{ fontSize: 17, fontWeight: '600', letterSpacing: -0.2 }}
      >
        {title}
      </Text>
      {body ? (
        <Text
          className="text-text-muted mt-2 text-center"
          style={{ fontSize: 14, lineHeight: 20, maxWidth: 320 }}
        >
          {body}
        </Text>
      ) : null}
      {cta ? (
        <Pressable
          onPress={cta.onPress}
          accessibilityRole="button"
          accessibilityLabel={cta.accessibilityLabel ?? cta.label}
          accessibilityHint={cta.accessibilityHint}
          className="mt-5 rounded-2xl px-5 py-3"
          style={{ backgroundColor: '#14b8a6' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#ffffff' }}>{cta.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
