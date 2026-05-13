import { useEffect, useState } from 'react';
import { Pressable, Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { Icon } from '@/components/Icon';
import { useThemeColors, durations } from '@/tw/theme';
import { useOnboarding } from '@/lib/onboarding/state';

// Screen 5 — Pain-amplification tinder cards. Tap-confirm rather than
// gesture-swipe to stay accessible without pulling in gesture-handler
// boilerplate; the card animates off in the matching direction so the
// feedback still feels physical.

const CARDS = [
  'I have 100+ travel screenshots in my camera roll right now.',
  "I've forgotten where at least one place I saved actually is.",
  'I plan trips by Googling the same spots I already screenshotted.',
  "When friends ask for recs, I can't find what I saved.",
];

export default function TinderScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { set } = useOnboarding();
  const [index, setIndex] = useState(0);
  const [agreed, setAgreed] = useState<string[]>([]);

  const tx = useSharedValue(0);
  const rotate = useSharedValue(0);
  const opacity = useSharedValue(1);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { rotate: `${rotate.value}deg` }],
    opacity: opacity.value,
  }));

  useEffect(() => {
    // Reset animation when a new card mounts.
    tx.value = 0;
    rotate.value = 0;
    opacity.value = withTiming(1, { duration: durations.micro });
  }, [index, tx, rotate, opacity]);

  function advance(card: string, didAgree: boolean) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const direction = didAgree ? 1 : -1;
    const next = didAgree ? [...agreed, card] : agreed;
    tx.value = withTiming(direction * 400, { duration: durations.short });
    rotate.value = withTiming(direction * 18, { duration: durations.short });
    opacity.value = withTiming(0, { duration: durations.short }, (finished) => {
      if (!finished) return;
      runOnJS(setAgreed)(next);
      runOnJS(setIndex)(index + 1);
    });
  }

  // Once every card has been judged, save and advance to the next screen.
  useEffect(() => {
    if (index >= CARDS.length) {
      set('agreedPains', agreed);
      router.replace('/onboarding/solution');
    }
  }, [index, agreed, router, set]);

  const current = CARDS[index];
  const remaining = CARDS.length - index;

  return (
    <OnboardingScaffold
      step={4}
      headline="Tap if this is you."
      sub="Agree or skip. We're not keeping score."
    >
      <View className="items-center" style={{ marginTop: 8 }}>
        <Text className="text-text-muted" style={{ fontSize: 12, fontWeight: '600' }}>
          {remaining} {remaining === 1 ? 'card' : 'cards'} left
        </Text>

        <View
          style={{
            width: '100%',
            maxWidth: 360,
            height: 260,
            marginTop: 16,
            position: 'relative',
          }}
        >
          {/* Back card peek for stack depth */}
          {index + 1 < CARDS.length ? (
            <View
              className="rounded-3xl border border-hairline bg-surface"
              style={{
                position: 'absolute',
                inset: 0,
                transform: [{ scale: 0.95 }, { translateY: 12 }],
                opacity: 0.6,
              }}
            />
          ) : null}

          {current ? (
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 24,
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.hairline,
                  padding: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                cardStyle,
              ]}
            >
              <Text
                className="text-center text-text"
                style={{ fontSize: 22, fontWeight: '600', lineHeight: 30, letterSpacing: -0.3 }}
              >
                “{current}”
              </Text>
            </Animated.View>
          ) : null}
        </View>

        {/* Action buttons */}
        <View className="mt-8 flex-row" style={{ gap: 24 }}>
          <Pressable
            onPress={() => current && advance(current, false)}
            accessibilityRole="button"
            accessibilityLabel="Skip — that's not me"
            className="h-16 w-16 items-center justify-center rounded-full"
            style={{
              backgroundColor: colors.surface,
              borderWidth: 1.5,
              borderColor: colors.hairline,
            }}
          >
            <Icon name="xmark" size={22} tintColor={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => current && advance(current, true)}
            accessibilityRole="button"
            accessibilityLabel="That's me"
            className="h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.accent }}
          >
            <Icon name="checkmark" size={22} tintColor="#ffffff" />
          </Pressable>
        </View>
      </View>
    </OnboardingScaffold>
  );
}
