import type { ReactNode } from 'react';
import { ActivityIndicator } from 'react-native';
import { Pressable, Text, View } from '@/tw';
import { cn } from '@/tw/cn';

export type SettingsRowTone = 'default' | 'danger';

type Props = {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  right?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  tone?: SettingsRowTone;
  accessibilityLabel?: string;
  className?: string;
};

// The visual contract for every row in the settings sheet. Mirrors the
// rounded-2xl pressable already used by the diagnostics rows so the sheet
// stays consistent before and after this refactor.
export function SettingsRow({
  title,
  subtitle,
  onPress,
  right,
  loading,
  disabled,
  tone = 'default',
  accessibilityLabel,
  className,
}: Props) {
  const isInteractive = !!onPress;
  const titleColor = tone === 'danger' ? '#dc2626' : '#14b8a6';
  const bg = tone === 'danger' ? 'rgba(220, 38, 38, 0.08)' : 'rgba(20, 184, 166, 0.1)';

  const inner = (
    <View className="flex-row items-center">
      <View className="flex-1 pr-3">
        <Text
          style={{
            fontSize: 15,
            fontWeight: '600',
            color: isInteractive ? titleColor : undefined,
          }}
          className={cn(!isInteractive && 'text-text')}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {loading ? <ActivityIndicator /> : right}
    </View>
  );

  if (!isInteractive) {
    return (
      <View
        className={cn('mt-2 rounded-2xl px-4 py-3', className)}
        style={{ backgroundColor: 'rgba(20, 184, 166, 0.05)' }}
      >
        {inner}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      className={cn('mt-2 rounded-2xl px-4 py-3', className)}
      style={{ backgroundColor: bg, opacity: disabled || loading ? 0.5 : 1 }}
    >
      {inner}
    </Pressable>
  );
}
