import { ActivityIndicator } from 'react-native';
import { Pressable, Text } from '@/tw';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
};

export function PrimaryButton({ label, onPress, disabled, loading, accessibilityHint }: Props) {
  const colors = useThemeColors();
  const isBlocked = disabled || loading;
  return (
    <Pressable
      onPress={() => {
        if (isBlocked) return;
        void Haptics.selectionAsync();
        onPress();
      }}
      disabled={isBlocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isBlocked, busy: !!loading }}
      className="items-center justify-center rounded-2xl"
      style={{
        height: 52,
        // While loading we keep the accent fill so it reads as "working on it",
        // not "you can't tap this".
        backgroundColor: loading ? colors.accent : disabled ? colors.hairline : colors.accent,
        opacity: disabled && !loading ? 0.7 : 1,
      }}
    >
      {loading ? (
        <ActivityIndicator color="#ffffff" />
      ) : (
        <Text
          style={{
            fontSize: 17,
            fontWeight: '700',
            color: disabled ? colors.textMuted : '#ffffff',
            letterSpacing: -0.2,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      className="items-center justify-center"
      style={{ height: 44 }}
    >
      <Text style={{ fontSize: 15, fontWeight: '500', color: colors.textMuted }}>{label}</Text>
    </Pressable>
  );
}
