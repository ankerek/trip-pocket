import { useCallback } from 'react';
import type { GestureResponderEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Pressable } from '@/tw';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';

type Props = {
  icon: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Fires a Light impact on press-in (iOS only). Default: true. */
  haptic?: boolean;
};

const SIZE = 38;
const ICON_SIZE = 19;

// Circular header affordance — matches DetailHeaderOverlay's back button:
// translucent disc on the theme surface, hairline border, glyph in primary
// text color, and a spring scale-up on press-in. Used by the Pocket and
// Trips title-row actions so the two tabs read as the same family.
export function HeaderActionButton({
  icon,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  haptic = true,
}: Props) {
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(1.08, { damping: 18, stiffness: 360, mass: 0.6 });
    opacity.value = withSpring(0.86, { damping: 18, stiffness: 360, mass: 0.6 });
    if (haptic && process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  }, [haptic, opacity, scale]);

  const handlePressOut = useCallback(
    (_e: GestureResponderEvent) => {
      scale.value = withSpring(1, { damping: 22, stiffness: 240, mass: 0.8 });
      opacity.value = withSpring(1, { damping: 22, stiffness: 240, mass: 0.8 });
    },
    [opacity, scale],
  );

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      hitSlop={8}
    >
      <Animated.View
        style={[
          {
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.hairline,
          },
          animatedStyle,
        ]}
      >
        <Icon name={icon} size={ICON_SIZE} tintColor={colors.text} />
      </Animated.View>
    </Pressable>
  );
}
