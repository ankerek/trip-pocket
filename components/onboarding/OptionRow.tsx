import { Pressable, Text, View } from '@/tw';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';

type Props = {
  label: string;
  /** SF Symbol name for the leading icon. Optional. */
  icon?: string;
  /** Emoji rendered in a circle, used in the categories grid. Mutually exclusive with `icon`. */
  emoji?: string;
  /** Helper line under the label. */
  description?: string;
  selected: boolean;
  /** Multi-select shows a checkbox; single-select shows a radio (with checkmark). */
  variant?: 'single' | 'multi';
  onPress: () => void;
};

// Generic selectable row used by destination / pain-points / categories /
// preferences screens. Selection toggles tint the row border + show the
// state indicator on the right.
export function OptionRow({
  label,
  icon,
  emoji,
  description,
  selected,
  variant = 'single',
  onPress,
}: Props) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole={variant === 'multi' ? 'checkbox' : 'radio'}
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      className="mb-2 flex-row items-center rounded-2xl bg-surface px-4"
      style={{
        minHeight: 56,
        paddingVertical: 12,
        borderColor: selected ? colors.accent : colors.hairline,
        // Keep the border width constant so the row's inner box doesn't
        // shift by 1px when the selection state flips.
        borderWidth: 2,
      }}
    >
      {icon ? (
        <View
          className="mr-3 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)' }}
        >
          <Icon name={icon} size={20} tintColor={colors.accent} />
        </View>
      ) : null}
      {emoji ? (
        <View
          className="mr-3 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)' }}
        >
          <Text style={{ fontSize: 18 }}>{emoji}</Text>
        </View>
      ) : null}
      <View className="flex-1">
        <Text
          className="text-text"
          style={{ fontSize: 16, fontWeight: '600', letterSpacing: -0.2 }}
        >
          {label}
        </Text>
        {description ? (
          <Text
            className="mt-0.5 text-text-muted"
            style={{ fontSize: 13, lineHeight: 18 }}
          >
            {description}
          </Text>
        ) : null}
      </View>
      <View
        className="ml-3 h-6 w-6 items-center justify-center rounded-full"
        style={{
          backgroundColor: selected ? colors.accent : 'transparent',
          borderColor: selected ? colors.accent : colors.hairline,
          borderWidth: 1.5,
        }}
      >
        {selected ? <Icon name="checkmark" size={12} tintColor="#ffffff" /> : null}
      </View>
    </Pressable>
  );
}
