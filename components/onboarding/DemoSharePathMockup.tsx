import { useEffect, useState } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useReducedMotion,
  withRepeat,
  withTiming,
  cancelAnimation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, Pressable, Text, View } from '@/tw';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import type { DemoShareFixture } from '@/lib/onboarding/demoFixtures';

// Example 2's mockup. Renders the live IG screen and the share-sheet /
// trip-picker overlays driven by the parent's `phase` prop. The user has
// two real tap targets in sequence:
//   1. The pulsing share icon on the IG card  → idle      → sheet
//   2. The pulsing Trip Pocket icon in the sheet → sheet → picker
//   3. The pulsing Japan pill in the trip picker → picker → revealed (parent)
//
// We deliberately do NOT wrap the IG card in a single Pressable — passing
// undefined onPress through the @/tw Pressable while also nesting it in
// an Animated.View triggered a layout regression that hid the hero image
// on some RN/Reanimated builds. Per-element Pressables sidestep that.

const IG_ICONS_LEFT: string[] = ['heart', 'bubble.right'];

export type SharePathPhase = 'idle' | 'sheet' | 'picker' | 'extracting' | 'fading';

// Height of the glowing scan band that sweeps the card during the
// 'extracting' phase. Matches the value used by ExtractingFrame in
// app/onboarding/demo.tsx so the two examples read as the same effect.
const SCAN_BAND_HEIGHT = 64;

type Props = {
  fixture: DemoShareFixture;
  phase: SharePathPhase;
  /** Called when the user taps the IG share icon. Active in `idle`. */
  onSharePressed: () => void;
  /** Called when the user taps the Trip Pocket icon in the share sheet.
   *  Active in `sheet`. */
  onTripPocketPressed: () => void;
  /** Called when the user taps the highlighted Japan pill. Active in
   *  `picker`. */
  onJapanPick: () => void;
};

export function DemoSharePathMockup({
  fixture,
  phase,
  onSharePressed,
  onTripPocketPressed,
  onJapanPick,
}: Props) {
  const colors = useThemeColors();
  const reducedMotion = useReducedMotion();

  const sharePulse = useSharedValue(0.5);
  const tpPulse = useSharedValue(0.5);
  const japanPulse = useSharedValue(0.7);

  // Sheet & picker positions: 0 = on-screen, 1 = below.
  const sheetY = useSharedValue(1);
  const pickerY = useSharedValue(1);
  const cardOpacity = useSharedValue(1);
  // Scan-line progress 0 → 1 during the 'extracting' phase.
  const scan = useSharedValue(0);
  // Measured card height so the scan line lands exactly at the bottom
  // edge before looping back to the top.
  const [cardHeight, setCardHeight] = useState(0);

  // --- Phase-driven pulses on the relevant tap target. ---

  useEffect(() => {
    if (phase !== 'idle' || reducedMotion) {
      cancelAnimation(sharePulse);
      sharePulse.value = 1;
      return;
    }
    sharePulse.value = withRepeat(
      withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(sharePulse);
  }, [phase, reducedMotion, sharePulse]);

  useEffect(() => {
    if (phase !== 'sheet' || reducedMotion) {
      cancelAnimation(tpPulse);
      tpPulse.value = 1;
      return;
    }
    tpPulse.value = withRepeat(
      withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(tpPulse);
  }, [phase, reducedMotion, tpPulse]);

  useEffect(() => {
    if (phase !== 'picker' || reducedMotion) {
      cancelAnimation(japanPulse);
      japanPulse.value = 1;
      return;
    }
    japanPulse.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(japanPulse);
  }, [phase, reducedMotion, japanPulse]);

  // --- Sheet & picker slide animations driven by phase. ---

  useEffect(() => {
    const target = phase === 'sheet' ? 0 : 1;
    sheetY.value = withTiming(target, { duration: 340, easing: Easing.out(Easing.cubic) });
  }, [phase, sheetY]);

  useEffect(() => {
    const target = phase === 'picker' ? 0 : 1;
    pickerY.value = withTiming(target, { duration: 340, easing: Easing.out(Easing.cubic) });
  }, [phase, pickerY]);

  useEffect(() => {
    const target = phase === 'fading' ? 0 : 1;
    cardOpacity.value = withTiming(target, { duration: 380, easing: Easing.in(Easing.quad) });
  }, [phase, cardOpacity]);

  // Scan-line loop runs only while 'extracting' is active. Reset on
  // entry so each pass starts at the top of the card.
  useEffect(() => {
    if (phase !== 'extracting' || reducedMotion) {
      cancelAnimation(scan);
      scan.value = 0;
      return;
    }
    scan.value = 0;
    scan.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.cubic) }),
      -1,
      false,
    );
    return () => cancelAnimation(scan);
  }, [phase, reducedMotion, scan]);

  // Slight dim + tiny scale-down while extracting reads as "being read".
  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value * (phase === 'extracting' ? 0.92 : 1),
    transform: [{ scale: phase === 'extracting' ? 0.98 : 1 }],
  }));
  const scanStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          -SCAN_BAND_HEIGHT / 2 + scan.value * Math.max(cardHeight, 1),
      },
    ],
  }));
  const shareIconStyle = useAnimatedStyle(() => ({ opacity: sharePulse.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: 320 * sheetY.value }],
    opacity: 1 - sheetY.value * 0.5,
  }));
  const pickerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: 240 * pickerY.value }],
    opacity: 1 - pickerY.value * 0.5,
  }));
  const japanPillStyle = useAnimatedStyle(() => ({ opacity: japanPulse.value }));

  return (
    <View
      style={{ width: '100%', maxWidth: 360, alignSelf: 'center', position: 'relative' }}
    >
      <Animated.View style={cardStyle}>
        <View
          className="overflow-hidden bg-bg"
          style={{ borderRadius: 18, borderWidth: 1, borderColor: colors.hairline }}
          onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
        >
          {/* Header strip */}
          <View
            className="flex-row items-center px-3"
            style={{ height: 40, gap: 8, width: '100%' }}
          >
            <View
              className="h-7 w-7 items-center justify-center rounded-full"
              style={{ backgroundColor: colors.accent }}
            >
              <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}>K</Text>
            </View>
            <Text
              className="flex-1 text-text"
              style={{ fontSize: 13, fontWeight: '600' }}
              numberOfLines={1}
            >
              {fixture.handle}
            </Text>
            <Icon name="ellipsis" size={16} tintColor={colors.textMuted} />
          </View>

          {/* Hero photo. Explicit width: '100%' so absolute children
              resolve dimensions deterministically even when an ancestor
              wraps the tree in Animated.View. */}
          <View style={{ width: '100%', height: 280, backgroundColor: colors.surface }}>
            <Image
              source={{ uri: fixture.heroImageUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              accessibilityIgnoresInvertColors
            />
          </View>

          {/* Caption */}
          <View className="px-3 py-3" style={{ width: '100%' }}>
            <Text className="text-text" style={{ fontSize: 13, lineHeight: 18 }}>
              {fixture.caption}
            </Text>
          </View>

          {/* Interaction row — share icon is the call-out and a Pressable. */}
          <View
            className="flex-row items-center px-3"
            style={{
              height: 44,
              gap: 14,
              width: '100%',
              borderTopWidth: 1,
              borderTopColor: colors.hairline,
            }}
          >
            {IG_ICONS_LEFT.map((name) => (
              <Icon key={name} name={name} size={16} tintColor={colors.text} />
            ))}
            <Pressable
              onPress={phase === 'idle' ? onSharePressed : undefined}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Share"
              accessibilityHint="Opens the share sheet."
              accessibilityState={{ disabled: phase !== 'idle' }}
            >
              <Animated.View style={shareIconStyle}>
                <Icon
                  name="paperplane.fill"
                  size={22}
                  tintColor={phase === 'idle' ? colors.accent : colors.text}
                />
              </Animated.View>
            </Pressable>
            <View className="flex-1" />
            <Icon name="bookmark" size={16} tintColor={colors.text} />
          </View>

          {/* Scan-line overlay — sweeps top → bottom over the post during
              the 'extracting' phase. Sits inside the overflow:hidden
              wrapper so the glow clips to the card's rounded edges. */}
          {phase === 'extracting' && cardHeight > 0 ? (
            <Animated.View
              pointerEvents="none"
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
          ) : null}
        </View>
      </Animated.View>

      {/* Share-sheet overlay — anchored to the IG card stack so it
          appears to rise from the bottom of the post. */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -16,
            overflow: 'hidden',
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
          },
          sheetStyle,
        ]}
      >
        <BlurView intensity={75} tint="systemMaterial">
          <View className="px-4 py-5" style={{ paddingBottom: 26, width: '100%' }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.hairline,
                alignSelf: 'center',
                marginBottom: 12,
              }}
            />
            <Text
              className="text-text-muted"
              style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}
            >
              SHARE TO
            </Text>
            <View className="flex-row mt-3" style={{ gap: 18 }}>
              <ShareSheetIconStatic symbol="square.grid.2x2" label="Messages" />
              <ShareSheetIconTripPocket
                pressable={phase === 'sheet'}
                onPress={onTripPocketPressed}
                pulse={tpPulse}
              />
              <ShareSheetIconStatic symbol="envelope" label="Mail" />
            </View>
            {phase === 'sheet' ? (
              <Text
                className="mt-3 text-text-muted"
                style={{ fontSize: 11, lineHeight: 16 }}
              >
                Tap Trip Pocket to save this post.
              </Text>
            ) : null}
          </View>
        </BlurView>
      </Animated.View>

      {/* Trip picker overlay — same anchor as the share sheet. */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -16,
            overflow: 'hidden',
            borderTopLeftRadius: 22,
            borderTopRightRadius: 22,
          },
          pickerStyle,
        ]}
      >
        <BlurView intensity={75} tint="systemMaterial">
          <View className="px-4 py-5" style={{ paddingBottom: 26, width: '100%' }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: colors.hairline,
                alignSelf: 'center',
                marginBottom: 12,
              }}
            />
            <Text
              className="text-text-muted"
              style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}
            >
              SAVE TO
            </Text>
            <View className="mt-3 flex-row flex-wrap" style={{ gap: 8 }}>
              <Animated.View style={japanPillStyle}>
                <Pressable
                  onPress={
                    phase === 'picker'
                      ? () => {
                          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          onJapanPick();
                        }
                      : undefined
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Save to ${fixture.tripPickerLabel}`}
                  accessibilityHint={`Saves the place to your ${fixture.tripPickerLabel} trip.`}
                  className="rounded-full px-4 py-2 flex-row items-center"
                  style={{
                    backgroundColor: colors.accent,
                    borderWidth: 2,
                    borderColor: colors.accent,
                    gap: 6,
                  }}
                >
                  <Icon name="mappin.circle.fill" size={14} tintColor="#ffffff" />
                  <Text
                    style={{
                      color: '#ffffff',
                      fontSize: 14,
                      fontWeight: '700',
                      letterSpacing: -0.1,
                    }}
                  >
                    {fixture.tripPickerLabel}
                  </Text>
                </Pressable>
              </Animated.View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New trip"
                accessibilityHint="Only used inside the app after the trial starts."
                onPress={undefined}
                className="rounded-full px-4 py-2 flex-row items-center"
                style={{
                  borderWidth: 1.5,
                  borderColor: colors.hairline,
                  gap: 6,
                  opacity: 0.6,
                }}
              >
                <Icon name="plus" size={14} tintColor={colors.textMuted} />
                <Text
                  className="text-text-muted"
                  style={{ fontSize: 14, fontWeight: '600' }}
                >
                  New trip
                </Text>
              </Pressable>
            </View>
            {phase === 'picker' ? (
              <Text
                className="mt-3 text-text-muted"
                style={{ fontSize: 11, lineHeight: 16 }}
              >
                Tap {fixture.tripPickerLabel} to save.
              </Text>
            ) : null}
          </View>
        </BlurView>
      </Animated.View>
    </View>
  );
}

function ShareSheetIconStatic({ symbol, label }: { symbol: string; label: string }) {
  const colors = useThemeColors();
  return (
    <View style={{ alignItems: 'center' }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.hairline,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={symbol} size={22} tintColor={colors.textMuted} />
      </View>
      <Text
        className="text-text-muted"
        style={{ marginTop: 4, fontSize: 10, fontWeight: '500', opacity: 0.7 }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

function ShareSheetIconTripPocket({
  pressable,
  onPress,
  pulse,
}: {
  pressable: boolean;
  onPress: () => void;
  pulse: SharedValue<number>;
}) {
  const colors = useThemeColors();
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: 0.95 + 0.05 * pulse.value }],
  }));
  return (
    <View style={{ alignItems: 'center' }}>
      <Pressable
        onPress={
          pressable
            ? () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onPress();
              }
            : undefined
        }
        accessibilityRole="button"
        accessibilityLabel="Share to Trip Pocket"
        accessibilityHint="Opens the Trip Pocket share extension."
        accessibilityState={{ disabled: !pressable }}
      >
        <Animated.View
          style={[
            {
              width: 56,
              height: 56,
              borderRadius: 14,
              overflow: 'hidden',
              shadowColor: colors.accent,
              shadowOpacity: pressable ? 0.5 : 0.2,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 0 },
            },
            pulseStyle,
          ]}
        >
          <LinearGradient
            colors={[colors.accent, colors.accentStrong]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ position: 'absolute', inset: 0 }}
          />
          <View
            style={{
              position: 'absolute',
              inset: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="tray.full.fill" size={24} tintColor="#ffffff" />
          </View>
        </Animated.View>
      </Pressable>
      <Text
        className="text-text"
        style={{
          marginTop: 4,
          fontSize: 10,
          fontWeight: '600',
          color: pressable ? colors.text : colors.textMuted,
        }}
        numberOfLines={1}
      >
        Trip Pocket
      </Text>
    </View>
  );
}
