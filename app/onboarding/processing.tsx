import { useEffect } from 'react';
import { Text, View } from '@/tw';
import { useRouter, Stack } from 'expo-router';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { OnboardingProgressBar } from '@/components/onboarding/OnboardingProgressBar';
import { useThemeColors } from '@/tw/theme';
import { useOnboarding, DESTINATION_LABEL } from '@/lib/onboarding/state';

// Screen 9 — Processing moment. 1.5s anticipation pause (per skill spec).
// Auto-advances to the demo. No CTA, no back affordance (the demo is the
// reveal — letting the user back out here is just friction).

export default function ProcessingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const { answers } = useOnboarding();

  const destinationLabel = answers.destination
    ? DESTINATION_LABEL[answers.destination]
    : 'your next trip';

  const rotate = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    rotate.value = withRepeat(
      withTiming(360, { duration: 1800, easing: Easing.linear }),
      -1,
      false,
    );
    scale.value = withRepeat(
      withSequence(
        withTiming(1.1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
        withTiming(1.0, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [rotate, scale]);

  useEffect(() => {
    const t = setTimeout(() => {
      router.replace('/onboarding/demo');
    }, 1800);
    return () => clearTimeout(t);
  }, [router]);

  const sparkleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }, { scale: scale.value }],
  }));

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
        <View className="h-11" />
        <OnboardingProgressBar step={8} />
        <View className="flex-1 items-center justify-center px-6">
          <Animated.View
            style={[
              {
                height: 72,
                width: 72,
                borderRadius: 36,
                backgroundColor: 'rgba(20, 184, 166, 0.10)',
                alignItems: 'center',
                justifyContent: 'center',
              },
              sparkleStyle,
            ]}
          >
            <Icon name="sparkles" size={36} tintColor={colors.accent} />
          </Animated.View>
          <Text
            className="mt-6 text-center text-text"
            style={{ fontSize: 22, fontWeight: '700', letterSpacing: -0.3 }}
          >
            Building your starter trip…
          </Text>
          <Text
            className="mt-2 text-center text-text-muted"
            style={{ fontSize: 14, lineHeight: 20 }}
          >
            Picking places for {destinationLabel}.
          </Text>
        </View>
      </View>
    </>
  );
}
