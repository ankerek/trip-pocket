import { Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';
import { useDatabase } from '@/components/useDatabase';
import { showCaptureActionSheet } from '@/components/CaptureActionSheet';
import { springs } from '@/tw/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Center capture button that lives in the new tab bar.
// Spec §4.6 + §5: scale 0.92 on press-in, spring back on release.
// Reduced-motion fallback (spec §9.4): linear timing, no overshoot.
export function CaptureFAB() {
  const db = useDatabase();
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = reducedMotion
          ? withTiming(0.96, { duration: 120 })
          : withSpring(0.92, springs.default);
      }}
      onPressOut={() => {
        scale.value = reducedMotion
          ? withTiming(1, { duration: 120 })
          : withSpring(1, springs.overshoot);
      }}
      onPress={() => {
        if (!db) return;
        if (process.env.EXPO_OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
        showCaptureActionSheet(db);
      }}
      accessibilityRole="button"
      accessibilityLabel="Capture"
      accessibilityHint="Add screenshots from Photos or take a new photo"
      style={[
        {
          width: 56,
          height: 56,
          borderRadius: 18,
          backgroundColor: '#0c4a6e',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#0c4a6e',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.3,
          shadowRadius: 16,
        },
        style,
      ]}
    >
      <Icon name="plus" size={26} tintColor="#ffffff" />
    </AnimatedPressable>
  );
}
