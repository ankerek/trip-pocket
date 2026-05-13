import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, Image } from '@/tw';
import { useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { Icon } from '@/components/Icon';
import { useThemeColors, durations } from '@/tw/theme';
import { useOnboarding, type DemoPlacePick } from '@/lib/onboarding/state';
import { pickDemoSeed } from '@/lib/onboarding/demoPlaces';

// Screen 10 — The demo. Users tap ✓ or ✗ on a stack of curated cards.
// Their kept picks become the starter trip on Screen 11.
//
// Design notes:
// - Buttons advance the deck. When the deck is exhausted we auto-navigate.
// - There's also an explicit "Done" CTA that's always tappable (it just
//   commits whatever has been picked so far, or none) — this is the
//   user's escape hatch and the primary reason the screen never "feels
//   stuck": there is always a forward affordance regardless of state.
// - Card-off animation uses a setTimeout to advance state rather than
//   relying on Reanimated's withTiming callback, which doesn't fire
//   reliably on all RN/Reanimated combinations.
// - State setters use the functional form so rapid taps can't race a
//   stale closure.

const CATEGORY_ICON: Record<DemoPlacePick['category'], string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

const CATEGORY_LABEL: Record<DemoPlacePick['category'], string> = {
  food: 'Food',
  activity: 'Activity',
  place: 'Place',
};

export default function DemoScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { answers, set } = useOnboarding();

  const seed = useMemo(
    () =>
      pickDemoSeed(
        answers.destination ?? 'bucket-list',
        answers.categories,
        5,
      ),
    [answers.destination, answers.categories],
  );

  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<DemoPlacePick[]>([]);
  const finishedRef = useRef(false);

  const tx = useSharedValue(0);
  const rotate = useSharedValue(0);
  const opacity = useSharedValue(1);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { rotate: `${rotate.value}deg` }],
    opacity: opacity.value,
  }));

  // Reset the card pose when the index advances. Runs after render so the
  // new card snaps to center (still invisible at opacity 0) before fading in.
  useEffect(() => {
    tx.value = 0;
    rotate.value = 0;
    opacity.value = withTiming(1, { duration: durations.short });
  }, [index, tx, rotate, opacity]);

  const total = seed.length;
  const done = index >= total;

  // Auto-finish once the deck is exhausted. finishedRef prevents the
  // navigation from running twice if React re-fires the effect during
  // the replace transition.
  useEffect(() => {
    if (!done) return;
    if (finishedRef.current) return;
    finishedRef.current = true;
    set('starterPlaces', picks);
    router.replace('/onboarding/value');
  }, [done, picks, set, router]);

  function advance(keep: boolean) {
    const card = seed[index];
    if (!card) return;
    void Haptics.impactAsync(
      keep ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
    );
    const direction = keep ? 1 : -1;
    tx.value = withTiming(direction * 420, { duration: durations.short });
    rotate.value = withTiming(direction * 14, { duration: durations.short });
    opacity.value = withTiming(0, { duration: durations.short });
    // setTimeout (instead of withTiming's completion callback) makes
    // advancement bullet-proof — the deck progresses even if the worklet
    // callback path is finicky on a given device/Reanimated version.
    setTimeout(() => {
      if (keep) setPicks((p) => [...p, card]);
      setIndex((i) => i + 1);
    }, durations.short);
  }

  function finishNow() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    set('starterPlaces', picks);
    router.replace('/onboarding/value');
  }

  const current = seed[index];
  const remaining = Math.max(0, total - index);
  const counterLabel =
    picks.length === 0
      ? `${remaining} CARD${remaining === 1 ? '' : 'S'} LEFT`
      : `${picks.length} SAVED · ${remaining} LEFT`;

  return (
    <OnboardingScaffold
      step={9}
      headline="Pick the places that look like you."
      sub="Tap ✓ to keep, ✗ to skip. We'll save them as your starter trip."
      scroll={false}
      footer={
        <PrimaryButton
          label={picks.length === 0 ? 'Skip — build empty trip' : 'Done — build my trip'}
          onPress={finishNow}
        />
      }
    >
      <View className="flex-1 items-center justify-between" style={{ paddingTop: 6 }}>
        <Text
          className="text-text-muted"
          style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.6 }}
        >
          {counterLabel}
        </Text>

        <View
          style={{
            width: '100%',
            maxWidth: 320,
            aspectRatio: 3 / 4,
            position: 'relative',
            marginVertical: 8,
          }}
        >
          {/* Next-card peek for stack depth */}
          {seed[index + 1] ? (
            <View
              className="overflow-hidden rounded-3xl border border-hairline bg-surface"
              style={{
                position: 'absolute',
                inset: 0,
                transform: [{ scale: 0.95 }, { translateY: 14 }],
                opacity: 0.55,
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
                  overflow: 'hidden',
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.hairline,
                },
                cardStyle,
              ]}
            >
              <Image
                source={{ uri: current.imageUrl }}
                style={{ position: 'absolute', inset: 0 }}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={200}
              />
              <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.6)']}
                locations={[0, 0.5, 1]}
                style={{ position: 'absolute', inset: 0 }}
              />
              <View
                style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}
              >
                <View
                  className="flex-row items-center self-start rounded-full px-2.5 py-1"
                  style={{ backgroundColor: 'rgba(255,255,255,0.18)' }}
                >
                  <Icon
                    name={CATEGORY_ICON[current.category]}
                    size={11}
                    tintColor="#ffffff"
                  />
                  <Text
                    style={{
                      marginLeft: 4,
                      color: '#ffffff',
                      fontSize: 11,
                      fontWeight: '700',
                      letterSpacing: 0.4,
                    }}
                  >
                    {CATEGORY_LABEL[current.category].toUpperCase()}
                  </Text>
                </View>
                <Text
                  style={{
                    color: '#ffffff',
                    fontSize: 22,
                    fontWeight: '700',
                    marginTop: 8,
                    letterSpacing: -0.3,
                    textShadowColor: 'rgba(0,0,0,0.45)',
                    textShadowOffset: { width: 0, height: 1 },
                    textShadowRadius: 3,
                  }}
                >
                  {current.name}
                </Text>
                <Text
                  style={{
                    color: 'rgba(255,255,255,0.92)',
                    fontSize: 13,
                    fontWeight: '500',
                    marginTop: 2,
                  }}
                >
                  {current.city}
                </Text>
              </View>
            </Animated.View>
          ) : null}
        </View>

        <View className="flex-row" style={{ gap: 24 }}>
          <Pressable
            onPress={() => advance(false)}
            disabled={!current}
            accessibilityRole="button"
            accessibilityLabel="Skip this place"
            className="h-16 w-16 items-center justify-center rounded-full"
            style={{
              backgroundColor: colors.surface,
              borderWidth: 1.5,
              borderColor: colors.hairline,
              opacity: current ? 1 : 0.4,
            }}
          >
            <Icon name="xmark" size={22} tintColor={colors.textMuted} />
          </Pressable>
          <Pressable
            onPress={() => advance(true)}
            disabled={!current}
            accessibilityRole="button"
            accessibilityLabel="Keep this place"
            className="h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.accent, opacity: current ? 1 : 0.4 }}
          >
            <Icon name="heart.fill" size={22} tintColor="#ffffff" />
          </Pressable>
        </View>
      </View>
    </OnboardingScaffold>
  );
}
