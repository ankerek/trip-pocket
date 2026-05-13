import { Image, Pressable, Text, View } from '@/tw';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';

// Screen 1 — Welcome. No back button, no progress bar. Shows a stylized
// device-frame preview of the Pocket grid so the user sees the end state
// before opting in.

const PREVIEW_TILES: { uri: string; name: string; city: string }[] = [
  {
    uri: 'https://images.unsplash.com/photo-1583032015879-e5022cb87c3b?w=600&q=70',
    name: 'Maru Tonkatsu',
    city: 'Shibuya',
  },
  {
    uri: 'https://images.unsplash.com/photo-1545569310-c3d35dbecf61?w=600&q=70',
    name: 'Fushimi Inari',
    city: 'Kyoto',
  },
  {
    uri: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600&q=70',
    name: 'Blue Bottle',
    city: 'Kiyosumi',
  },
  {
    uri: 'https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=600&q=70',
    name: 'Shibuya Sky',
    city: 'Shibuya',
  },
];

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-bg">
        <View
          className="flex-1 items-center"
          style={{ paddingTop: insets.top + 24, paddingHorizontal: 24 }}
        >
          {/* App wordmark */}
          <View className="flex-row items-center">
            <View
              className="h-7 w-7 items-center justify-center rounded-md"
              style={{ backgroundColor: colors.accent }}
            >
              <Icon name="tray.full" size={16} tintColor="#ffffff" />
            </View>
            <Text
              className="ml-2 text-text"
              style={{ fontSize: 17, fontWeight: '700', letterSpacing: -0.2 }}
            >
              Trip Pocket
            </Text>
          </View>

          {/* Preview grid (faux device frame) */}
          <View
            className="mt-6 overflow-hidden"
            style={{
              width: '100%',
              maxWidth: 360,
              aspectRatio: 0.85,
              borderRadius: 28,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.hairline,
              padding: 12,
            }}
          >
            <View className="flex-row" style={{ gap: 6 }}>
              {PREVIEW_TILES.slice(0, 2).map((t) => (
                <PreviewTile key={t.uri} tile={t} />
              ))}
            </View>
            <View className="mt-1.5 flex-row" style={{ gap: 6 }}>
              {PREVIEW_TILES.slice(2, 4).map((t) => (
                <PreviewTile key={t.uri} tile={t} />
              ))}
            </View>
          </View>

          {/* Headline */}
          <Text
            className="mt-8 text-center text-text"
            style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.5, lineHeight: 38 }}
          >
            Save travel inspiration{'\n'}before it gets lost.
          </Text>
          <Text
            className="mt-3 text-center text-text-muted"
            style={{ fontSize: 16, lineHeight: 22, maxWidth: 320 }}
          >
            Trip Pocket turns the screenshots you already take into places you can actually use.
          </Text>
        </View>

        {/* CTA */}
        <View
          className="px-6"
          style={{ paddingBottom: Math.max(20, insets.bottom + 8) }}
        >
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
            <Text style={{ fontSize: 17, fontWeight: '700', color: '#ffffff', letterSpacing: -0.2 }}>
              Get started
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

function PreviewTile({ tile }: { tile: { uri: string; name: string; city: string } }) {
  return (
    <View className="flex-1 overflow-hidden" style={{ borderRadius: 12, aspectRatio: 3 / 4 }}>
      <Image
        source={{ uri: tile.uri }}
        style={{ position: 'absolute', inset: 0 }}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
      />
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
        <Text
          numberOfLines={1}
          style={{
            color: '#ffffff',
            fontSize: 13,
            fontWeight: '700',
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
            color: 'rgba(255,255,255,0.85)',
            fontSize: 10,
            fontWeight: '500',
            marginTop: 1,
          }}
        >
          {tile.city}
        </Text>
      </View>
    </View>
  );
}
