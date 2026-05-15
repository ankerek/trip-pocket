import { useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Image, Pressable, Text, View } from '@/tw';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';

type ThemeColors = ReturnType<typeof useThemeColors>;

// Screen 1 — Welcome. No back button, no progress bar. A casually fanned
// stack of five place cards drops in to preview the end state before the
// user opts in.

type FannedTile = {
  uri: string;
  name: string;
  city: string;
  /** Outer-wrapper absolute positioning. */
  position: Pick<ViewStyle, 'top' | 'bottom' | 'left' | 'right' | 'marginLeft'>;
  /** Static rotation applied to the inner card. */
  rotation: number;
  /** Stacking — only the centered foreground card overrides the default. */
  zIndex?: number;
  /** Drop-in delay, in ms. */
  delay: number;
};

// Two-level nesting (outer animated wrapper, inner rotated card) keeps
// the drop-in transform from fighting the static rotation. Positions and
// rotations follow the design spec.
const FANNED_TILES: FannedTile[] = [
  {
    uri: 'https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?w=600&q=70',
    name: 'Cappadocia',
    city: 'Göreme, Türkiye',
    position: { top: 30, left: 12 },
    rotation: -10,
    delay: 100,
  },
  {
    uri: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=600&q=70',
    name: 'Eiffel Tower',
    city: 'Paris, France',
    position: { top: 18, right: 18 },
    rotation: 6,
    delay: 250,
  },
  {
    uri: 'https://images.unsplash.com/photo-1583032015879-e5022cb87c3b?w=600&q=70',
    name: 'Maru Tonkatsu',
    city: 'Shibuya, Japan',
    position: { top: 70, left: '50%', marginLeft: -65 },
    rotation: -2,
    zIndex: 2,
    delay: 400,
  },
  {
    uri: 'https://images.unsplash.com/photo-1539037116277-4db20889f2d4?w=600&q=70',
    name: 'Cinque Terre',
    city: 'Vernazza, Italy',
    position: { bottom: 0, left: 32 },
    rotation: 8,
    delay: 550,
  },
  {
    uri: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=600&q=70',
    name: 'Oia',
    city: 'Santorini, Greece',
    position: { bottom: 14, right: 8 },
    rotation: -5,
    delay: 700,
  },
];

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="bg-bg flex-1">
        <View
          className="flex-1 items-center"
          style={{ paddingTop: insets.top + 24, paddingHorizontal: 24 }}
        >
          {/* App wordmark */}
          <View className="flex-row items-center">
            <Image
              source={require('@/assets/pocket-trip-icon-2.png')}
              style={{ width: 28, height: 28, borderRadius: 7 }}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
            <Text
              className="text-text ml-2"
              style={{ fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }}
            >
              Trip Pocket
            </Text>
          </View>

          {/* Fanned card stack */}
          <View
            style={{
              width: '100%',
              maxWidth: 360,
              height: 300,
              marginTop: 24,
              position: 'relative',
            }}
          >
            {FANNED_TILES.map((tile) => (
              <FannedTileCard key={tile.name} tile={tile} colors={colors} />
            ))}
          </View>

          {/* Headline */}
          <Text
            className="text-text text-center"
            style={{
              marginTop: 56,
              fontSize: 32,
              fontWeight: '700',
              letterSpacing: -0.5,
              lineHeight: 38,
            }}
          >
            Save travel inspiration{'\n'}before it gets lost.
          </Text>
          <Text
            className="text-text-muted mt-3 text-center"
            style={{ fontSize: 16, lineHeight: 22, maxWidth: 320 }}
          >
            Take a screenshot or share an Instagram or TikTok post. Our AI turns it into a place on
            a map you can actually use.
          </Text>
        </View>

        {/* CTA */}
        <View className="px-6" style={{ paddingBottom: Math.max(20, insets.bottom + 8) }}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push('/onboarding/destination');
            }}
            accessibilityRole="button"
            accessibilityLabel="Get started"
            className="items-center justify-center rounded-2xl"
            style={{ height: 54, backgroundColor: colors.accent }}
          >
            <Text
              style={{ fontSize: 17, fontWeight: '700', color: '#ffffff', letterSpacing: -0.2 }}
            >
              Get started
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

function FannedTileCard({ tile, colors }: { tile: FannedTile; colors: ThemeColors }) {
  const reducedMotion = useReducedMotion();
  // 0 → 1 drives the drop-in: opacity 0→1, translateY -180→0, scale 0.6→1.
  const progress = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      tile.delay,
      withTiming(1, {
        duration: 900,
        // CSS `ease` default — soft landing, not bouncy.
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      }),
    );
  }, [progress, reducedMotion, tile.delay]);

  const outerStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: -180 * (1 - progress.value) }, { scale: 0.6 + 0.4 * progress.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        outerStyle,
        {
          position: 'absolute',
          width: 130,
          zIndex: tile.zIndex,
          ...tile.position,
        },
      ]}
    >
      <View
        shouldRasterizeIOS
        renderToHardwareTextureAndroid
        style={{ transform: [{ rotate: `${tile.rotation}deg` }] }}
      >
        <View
          style={{
            backgroundColor: colors.bg,
            borderRadius: 16,
            padding: 1,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.16,
            shadowRadius: 14,
            elevation: 6,
          }}
        >
          <View
            style={{
              width: '100%',
              aspectRatio: 4 / 5,
              borderRadius: 15,
              overflow: 'hidden',
            }}
          >
            <Image
              source={{ uri: tile.uri }}
              style={{ position: 'absolute', inset: 0 }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
            />
            <LinearGradient
              colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.7)']}
              locations={[0, 0.5, 1]}
              style={{ position: 'absolute', inset: 0 }}
            />
            <View style={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: '#ffffff',
                  fontSize: 12,
                  fontWeight: '700',
                  letterSpacing: -0.1,
                  textShadowColor: 'rgba(0,0,0,0.45)',
                  textShadowOffset: { width: 0, height: 1 },
                  textShadowRadius: 2,
                }}
              >
                {tile.name}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: 'rgba(255,255,255,0.88)',
                  fontSize: 10,
                  fontWeight: '500',
                  marginTop: 1,
                }}
              >
                {tile.city}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
