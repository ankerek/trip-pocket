import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
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
  | 'shareSheet2' // user must tap the Trip Pocket icon in the share sheet
  | 'waitingPick' // trip picker visible, user must tap the Japan pill
  | 'extracting2' // post-tap: scan-line over the IG card before reveal
  | 'revealed2';

const TIMINGS = {
  extracting1: 1400,
  extracting2: 1500,
};

export default function DemoScreen() {
  const router = useRouter();
  const colors = useThemeColors();

  const [phase, setPhase] = useState<Phase>('idle1');
  const finishedRef = useRef(false);

  // Cleanup any pending timers when the screen unmounts (back-nav etc).
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scheduleTimer = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timersRef.current.push(id);
  }, []);
  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    },
    [],
  );

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
    // Picker slides out and the scan-line plays over the IG card.
    // After the extraction window, flip to the reveal.
    setPhase('extracting2');
    scheduleTimer(() => {
      setPhase('revealed2');
    }, TIMINGS.extracting2);
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
        return <PrimaryButton label="Try it" onPress={startExtracting1} />;
      case 'extracting1':
        return null;
      case 'revealed1':
        return <PrimaryButton label="Next: from a share" onPress={nextToExample2} />;
      case 'idle2':
        return (
          <Text
            className="text-text-muted text-center"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap the highlighted share icon on the post.
          </Text>
        );
      case 'shareSheet2':
        return (
          <Text
            className="text-text-muted text-center"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap Trip Pocket in the share sheet.
          </Text>
        );
      case 'waitingPick':
        return (
          <Text
            className="text-text-muted text-center"
            style={{ fontSize: 12, lineHeight: 18, paddingVertical: 14 }}
          >
            Tap the highlighted trip to save it.
          </Text>
        );
      case 'extracting2':
        return null;
      case 'revealed2':
        return <PrimaryButton label="Continue" onPress={finishToPaywall} />;
    }
  })();

  // Hide the back chevron during the busy extraction phase — leaving
  // mid-animation would leak shared-value state. All other phases are
  // user-driven and safe to back out of.
  const showBack = phase !== 'extracting1' && phase !== 'extracting2' && phase !== 'revealed2';

  // Step-pill label updates with phase to reinforce which example you're on.
  const isExample1 = phase === 'idle1' || phase === 'extracting1' || phase === 'revealed1';
  const stepLabel = isExample1 ? '1 / 2 · FROM A SCREENSHOT' : '2 / 2 · FROM A SHARE';

  // Sub-mockup phase mapping for example 2.
  const sharePathPhase: SharePathPhase = (() => {
    if (phase === 'idle2') return 'idle';
    if (phase === 'shareSheet2') return 'sheet';
    if (phase === 'waitingPick') return 'picker';
    if (phase === 'extracting2') return 'extracting';
    if (phase === 'revealed2') return 'fading';
    return 'idle';
  })();

  return (
    <OnboardingScaffold step={4} showBack={showBack} scroll={false} footer={footer}>
      <ScrollView
        contentContainerClassName="items-center pb-4"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
      >
        <Text
          className="text-text mt-1 text-center"
          style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 }}
        >
          Watch it work.
        </Text>
        <Text
          className="text-text-muted mt-2 text-center"
          style={{ fontSize: 15, lineHeight: 22, paddingHorizontal: 8 }}
        >
          Two ways to add a place.
        </Text>
        <Text
          className="text-text-muted mt-3"
          style={{
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 0.6,
          }}
        >
          {stepLabel}
        </Text>

        <View style={{ width: '100%', marginTop: 40, alignItems: 'center' }}>
          {phase === 'idle1' || phase === 'extracting1' ? (
            <ExtractingFrame variant={phase === 'idle1' ? 'idle' : 'busy'} />
          ) : null}

          {phase === 'revealed1' ? <RevealedExample1 /> : null}

          {phase === 'idle2' ||
          phase === 'shareSheet2' ||
          phase === 'waitingPick' ||
          phase === 'extracting2' ? (
            <>
              <DemoSharePathMockup
                fixture={DEMO_SHARE}
                phase={sharePathPhase}
                onSharePressed={onSharePressed}
                onTripPocketPressed={onTripPocketPressed}
                onJapanPick={onJapanPick}
              />
              {phase === 'extracting2' ? (
                <View className="mt-3 flex-row items-center" style={{ gap: 6 }}>
                  <Icon name="sparkles" size={14} tintColor={colors.accent} />
                  <Text
                    className="text-text"
                    style={{ fontSize: 13, fontWeight: '600', letterSpacing: -0.1 }}
                  >
                    Extracting the place…
                  </Text>
                </View>
              ) : null}
            </>
          ) : null}

          {phase === 'revealed2' ? <RevealedExample2 /> : null}
        </View>
      </ScrollView>
    </OnboardingScaffold>
  );
}

// Height of the glowing scan band. The bright 2px line sits in the
// middle; the gradient on either side fakes a soft halo.
const SCAN_BAND_HEIGHT = 64;

function ExtractingFrame({ variant }: { variant: 'idle' | 'busy' }) {
  const colors = useThemeColors();
  const scale = useSharedValue(1);
  const scan = useSharedValue(0);
  const labelOpacity = useSharedValue(0);
  // Measured screenshot height — drives the scan-line travel distance so
  // the line lands exactly at the bottom edge of the card on each loop.
  const [cardHeight, setCardHeight] = useState(0);

  useEffect(() => {
    if (variant === 'busy') {
      scale.value = withTiming(0.97, {
        duration: 300,
        easing: Easing.out(Easing.cubic),
      });
      labelOpacity.value = withTiming(1, { duration: 280 });
      scan.value = 0;
      scan.value = withRepeat(
        withTiming(1, {
          duration: 1500,
          easing: Easing.inOut(Easing.cubic),
        }),
        -1,
        false,
      );
    } else {
      scale.value = withTiming(1, { duration: 200 });
      labelOpacity.value = withTiming(0, { duration: 200 });
      cancelAnimation(scan);
      scan.value = 0;
    }
  }, [variant, scale, scan, labelOpacity]);

  const stackStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: variant === 'busy' ? 0.92 : 1,
  }));
  // Travel from above the top edge to just past the bottom so the line
  // visibly enters and exits the card on each loop.
  const scanStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -SCAN_BAND_HEIGHT / 2 + scan.value * Math.max(cardHeight, 1),
      },
    ],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.value }));

  return (
    <View style={{ width: '100%', maxWidth: 300, alignItems: 'center' }}>
      <View
        style={{ position: 'relative', alignSelf: 'stretch' }}
        onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
      >
        <Animated.View style={stackStyle}>
          <DemoScreenshotMockup fixture={DEMO_SCREENSHOT} pulsing={variant === 'idle'} />
        </Animated.View>
        {variant === 'busy' && cardHeight > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: 18,
              overflow: 'hidden',
            }}
          >
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  height: SCAN_BAND_HEIGHT,
                  justifyContent: 'center',
                },
                scanStyle,
              ]}
            >
              <LinearGradient
                colors={[
                  'rgba(20, 184, 166, 0)',
                  'rgba(20, 184, 166, 0.35)',
                  'rgba(20, 184, 166, 0)',
                ]}
                locations={[0, 0.5, 1]}
                style={{ position: 'absolute', inset: 0 }}
              />
              <View
                style={{
                  height: 2,
                  backgroundColor: colors.accent,
                  shadowColor: colors.accent,
                  shadowOpacity: 0.9,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 0 },
                }}
              />
            </Animated.View>
          </View>
        ) : null}
      </View>
      <Animated.View style={labelStyle}>
        <View className="mt-3 flex-row items-center" style={{ gap: 6 }}>
          <Icon name="sparkles" size={14} tintColor={colors.accent} />
          <Text
            className="text-text"
            style={{ fontSize: 13, fontWeight: '600', letterSpacing: -0.1 }}
          >
            Extracting 3 places…
          </Text>
        </View>
      </Animated.View>
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
