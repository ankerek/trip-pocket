import { Pressable, Text } from '@/tw';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
};

export function PrimaryButton({ label, onPress, disabled, accessibilityHint }: Props) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        void Haptics.selectionAsync();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      className="items-center justify-center rounded-2xl"
      style={{
        height: 52,
        backgroundColor: disabled ? colors.hairline : colors.accent,
        opacity: disabled ? 0.7 : 1,
      }}
    >
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
