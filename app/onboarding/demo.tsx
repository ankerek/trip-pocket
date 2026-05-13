import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { ScrollView, Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { DemoPlaceCard } from '@/components/onboarding/DemoPlaceCard';
import { DemoScreenshotMockup } from '@/components/onboarding/DemoScreenshotMockup';
import {
  DemoSharePathMockup,
  type SharePathPhase,
} from '@/components/onboarding/DemoSharePathMockup';
import { DEMO_SCREENSHOT, DEMO_SHARE } from '@/lib/onboarding/demoFixtures';
import * as Haptics from 'expo-haptics';

// Screen 5 — The demo. Two-example sequence:
//   Ex 1: tap the tilted screenshot → "extracting…" pulse → 3 place cards
//   Ex 2: tap the live IG card → share-sheet → trip-picker → user taps
//         "Japan" → 1 place card with "Saved to Japan" header
//
// State machine and rationale documented in
// docs/superpowers/specs/2026-05-13-onboarding-redesign-design.md.

type Phase =
  | 'idle1'
  | 'extracting1'
  | 'revealed1'
  | 'idle2'
  | 'shareSheet2'   // user must tap the Trip Pocket icon in the share sheet
  | 'waitingPick'   // trip picker visible, user must tap the Japan pill
  | 'revealed2';

const TIMINGS = {
  extracting1: 1400,
};

export default function DemoScreen() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('idle1');
  const finishedRef = useRef(false);

  // Cleanup any pending timers when the screen unmounts (back-nav etc).
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scheduleTimer = useCallback(
    (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      timersRef.current.push(id);
    },
    [],
  );
  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  // --- Example 1 transitions ---

  function startExtracting1() {
    void Haptics.selectionAsync();
    setPhase('extracting1');
    scheduleTimer(() => {
      setPhase('revealed1');
    }, TIMINGS.extracting1);
  }

  function nextToExample2() {
    void Haptics.selectionAsync();
    setPhase('idle2');
  }

  // --- Example 2 transitions (all user-driven). ---

  function onSharePressed() {
    void Haptics.selectionAsync();
    setPhase('shareSheet2');
  }

  function onTripPocketPressed() {
    // Trip Pocket icon tapped — share sheet animates out, trip picker
    // animates in. Both are driven by the mockup's phase prop.
    setPhase('waitingPick');
  }

  function onJapanPick() {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setPhase('revealed2');
  }

  function finishToPaywall() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    router.push('/onboarding/paywall');
  }

  // --- Footer CTA derivation ---

  const footer = (() => {
    switch (phase) {
      case 'idle1':
        return <PrimaryButton label="See it extract" onPress={startExtracting1} />;
      case 'extracting1':
        return null;
      case 'revealed1':
        return <PrimaryButton label="Next: from a share" onPress={nextToExample2} />;
      case 'idle2':
        return (
          <Text
            className="text-center text-text-muted"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap the highlighted share icon on the post.
          </Text>
        );
      case 'shareSheet2':
        return (
          <Text
            className="text-center text-text-muted"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap Trip Pocket in the share sheet.
          </Text>
        );
      case 'waitingPick':
        return (
          <Text
            className="text-center text-text-muted"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap the highlighted trip to save it.
          </Text>
        );
      case 'revealed2':
        return <PrimaryButton label="Continue" onPress={finishToPaywall} />;
    }
  })();

  // Hide the back chevron during the busy extraction phase — leaving
  // mid-animation would leak shared-value state. All other phases are
  // user-driven and safe to back out of.
  const showBack = phase !== 'extracting1' && phase !== 'revealed2';

  // Step-pill label updates with phase to reinforce which example you're on.
  const isExample1 =
    phase === 'idle1' || phase === 'extracting1' || phase === 'revealed1';
  const stepLabel = isExample1
    ? '1 / 2 · FROM A SCREENSHOT'
    : '2 / 2 · FROM A SHARE';

  // Sub-mockup phase mapping for example 2.
  const sharePathPhase: SharePathPhase = (() => {
    if (phase === 'idle2') return 'idle';
    if (phase === 'shareSheet2') return 'sheet';
    if (phase === 'waitingPick') return 'picker';
    if (phase === 'revealed2') return 'fading';
    return 'idle';
  })();

  return (
    <OnboardingScaffold
      step={4}
      showBack={showBack}
      scroll={false}
      footer={footer}
    >
      <ScrollView
        contentContainerClassName="items-center pb-4"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
      >
        <Text
          className="text-text-muted"
          style={{
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 0.6,
            marginTop: 4,
          }}
        >
          {stepLabel}
        </Text>

        <Text
          className="mt-3 text-center text-text"
          style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 }}
        >
          Watch it work.
        </Text>
        <Text
          className="mt-2 text-center text-text-muted"
          style={{ fontSize: 15, lineHeight: 22, paddingHorizontal: 8 }}
        >
          Two ways places land in Trip Pocket.
        </Text>

        <View style={{ width: '100%', marginTop: 18, alignItems: 'center' }}>
          {(phase === 'idle1' || phase === 'extracting1') ? (
            <ExtractingFrame
              variant={phase === 'idle1' ? 'idle' : 'busy'}
            />
          ) : null}

          {phase === 'revealed1' ? <RevealedExample1 /> : null}

          {(phase === 'idle2' || phase === 'shareSheet2' || phase === 'waitingPick') ? (
            <DemoSharePathMockup
              fixture={DEMO_SHARE}
              phase={sharePathPhase}
              onSharePressed={onSharePressed}
              onTripPocketPressed={onTripPocketPressed}
              onJapanPick={onJapanPick}
            />
          ) : null}

          {phase === 'revealed2' ? <RevealedExample2 /> : null}
        </View>
      </ScrollView>
    </OnboardingScaffold>
  );
}

function ExtractingFrame({ variant }: { variant: 'idle' | 'busy' }) {
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const sparkleOpacity = useSharedValue(0);

  useEffect(() => {
    if (variant === 'busy') {
      scale.value = withTiming(0.95, { duration: 300, easing: Easing.out(Easing.cubic) });
      sparkleOpacity.value = withTiming(1, {
        duration: 400,
        easing: Easing.in(Easing.quad),
      });
    } else {
      scale.value = withTiming(1, { duration: 200 });
      sparkleOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [variant, scale, sparkleOpacity]);

  const stackStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const sparkleStyle = useAnimatedStyle(() => ({ opacity: sparkleOpacity.value }));

  return (
    <View style={{ width: '100%', maxWidth: 320, alignItems: 'center' }}>
      <Animated.View style={[stackStyle, { opacity: variant === 'busy' ? 0.65 : 1 }]}>
        <DemoScreenshotMockup fixture={DEMO_SCREENSHOT} pulsing={variant === 'idle'} />
      </Animated.View>
      {variant === 'busy' ? (
        <Animated.View
          style={[
            sparkleStyle,
            {
              position: 'absolute',
              top: '50%',
              left: 0,
              right: 0,
              alignItems: 'center',
              marginTop: -36,
            },
          ]}
        >
          <View
            className="h-14 w-14 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(20, 184, 166, 0.18)' }}
          >
            <Icon name="sparkles" size={28} tintColor={colors.accent} />
          </View>
          <Text
            className="mt-2 text-text"
            style={{ fontSize: 13, fontWeight: '600', letterSpacing: -0.1 }}
          >
            Extracting 3 places…
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function RevealedExample1() {
  const colors = useThemeColors();
  return (
    <View style={{ width: '100%' }}>
      <View
        className="flex-row items-center"
        style={{ gap: 8, marginBottom: 10, paddingHorizontal: 4 }}
      >
        <Icon name="checkmark.seal.fill" size={16} tintColor={colors.accent} />
        <Text className="text-text" style={{ fontSize: 15, fontWeight: '700' }}>
          3 places found
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        {DEMO_SCREENSHOT.reveals.map((place) => (
          <DemoPlaceCard key={place.name} place={place} />
        ))}
      </View>
    </View>
  );
}

function RevealedExample2() {
  const colors = useThemeColors();
  return (
    <View style={{ width: '100%' }}>
      <View
        className="flex-row items-center"
        style={{ gap: 8, marginBottom: 10, paddingHorizontal: 4 }}
      >
        <Icon name="checkmark.seal.fill" size={16} tintColor={colors.accent} />
        <Text className="text-text" style={{ fontSize: 15, fontWeight: '700' }}>
          Saved to {DEMO_SHARE.tripPickerLabel}
        </Text>
      </View>
      <DemoPlaceCard place={DEMO_SHARE.reveal} />
    </View>
  );
}
