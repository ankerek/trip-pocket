import { useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useReducedMotion,
  withRepeat,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { Image, Text, View } from '@/tw';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import type { DemoScreenshotFixture } from '@/lib/onboarding/demoFixtures';

// Example 1's "before" state — a tilted faux IG list-post card. The whole
// thing reads as a screenshot, not a UI: drop shadow, slight rotation,
// IG-style interaction row at the bottom. Spec section "Example 1 — From
// a screenshot" in 2026-05-13-onboarding-redesign-design.md.

const TILT_DEG = -4;

const IG_ICONS: { name: string; key: string }[] = [
  { name: 'heart', key: 'heart' },
  { name: 'bubble.right', key: 'bubble' },
  { name: 'paperplane', key: 'paperplane' },
  { name: 'bookmark', key: 'bookmark' },
];

export function DemoScreenshotMockup({
  fixture,
  pulsing,
}: {
  fixture: DemoScreenshotFixture;
  pulsing: boolean;
}) {
  const colors = useThemeColors();
  const ringOpacity = useSharedValue(0.3);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!pulsing || reducedMotion) {
      cancelAnimation(ringOpacity);
      ringOpacity.value = 0.3;
      return;
    }
    ringOpacity.value = withRepeat(
      withTiming(0.6, { duration: 1000, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(ringOpacity);
  }, [pulsing, reducedMotion, ringOpacity]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
  }));

  return (
    <View
      style={{
        transform: [{ rotate: `${TILT_DEG}deg` }],
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.18,
        shadowRadius: 24,
        elevation: 8,
      }}
    >
      {/* Accent ring overlay */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            top: -6,
            left: -6,
            right: -6,
            bottom: -6,
            borderRadius: 22,
            borderWidth: 2,
            borderColor: colors.accent,
          },
          ringStyle,
        ]}
      />
      <View
        className="overflow-hidden bg-bg"
        style={{ borderRadius: 18, borderWidth: 1, borderColor: colors.hairline }}
      >
        {/* IG-style header strip */}
        <View
          className="flex-row items-center px-3"
          style={{ height: 40, gap: 8 }}
        >
          <View
            className="h-7 w-7 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.accent }}
          >
            <Text
              style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}
            >
              T
            </Text>
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

        {/* Hero photo with title overlay */}
        <View style={{ height: 220, position: 'relative' }}>
          <Image
            source={{ uri: fixture.heroImageUrl }}
            style={{ position: 'absolute', inset: 0 }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
            accessibilityIgnoresInvertColors
          />
          <LinearGradient
            colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
            locations={[0, 0.45, 1]}
            style={{ position: 'absolute', inset: 0 }}
          />
          <Text
            style={{
              position: 'absolute',
              left: 14,
              right: 14,
              bottom: 12,
              color: '#ffffff',
              fontSize: 18,
              fontWeight: '800',
              letterSpacing: 0.6,
              textShadowColor: 'rgba(0,0,0,0.45)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 3,
            }}
          >
            {fixture.titleOverlay}
          </Text>
        </View>

        {/* Numbered caption */}
        <View className="px-3 py-3" style={{ gap: 4 }}>
          {fixture.captionLines.map((line) => (
            <Text
              key={line}
              className="text-text"
              style={{ fontSize: 13, lineHeight: 18 }}
            >
              {line}
            </Text>
          ))}
        </View>

        {/* IG interaction row */}
        <View
          className="flex-row items-center px-3"
          style={{ height: 36, gap: 14, borderTopWidth: 1, borderTopColor: colors.hairline }}
        >
          {IG_ICONS.map((icon) => (
            <Icon key={icon.key} name={icon.name} size={16} tintColor={colors.text} />
          ))}
        </View>
      </View>
    </View>
  );
}
