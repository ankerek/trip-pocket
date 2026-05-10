import { useCallback, type ComponentProps, type ReactNode } from 'react';
import type {
  GestureResponderEvent,
  PressableProps as RNPressableProps,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Pressable, View } from '@/tw';

type Props = ComponentProps<typeof Pressable> & {
  children: ReactNode;
  /** Fires a Light impact on press-in (iOS only). Default: true. */
  haptic?: boolean;
};

/**
 * Pressable variant with a quick scale-down on press-in and Light iOS haptic.
 * Layout/visual className still goes on this component — internally it wraps
 * the children in an Animated.View so the transform applies to the visible
 * tile while the Pressable's hit area stays put.
 */
export function PressableScale({
  children,
  className,
  style,
  onPressIn,
  onPressOut,
  haptic = true,
  ...rest
}: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withSpring(0.96, {
        damping: 18,
        stiffness: 360,
        mass: 0.6,
      });
      if (haptic && process.env.EXPO_OS === 'ios') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      onPressIn?.(e);
    },
    [haptic, onPressIn, scale],
  );

  const handlePressOut = useCallback(
    (e: GestureResponderEvent) => {
      scale.value = withSpring(1, {
        damping: 22,
        stiffness: 240,
        mass: 0.8,
      });
      onPressOut?.(e);
    },
    [onPressOut, scale],
  );

  return (
    <Pressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      {...(rest as RNPressableProps)}
    >
      <Animated.View style={[style as object, animatedStyle]}>
        <View className={className}>{children}</View>
      </Animated.View>
    </Pressable>
  );
}
