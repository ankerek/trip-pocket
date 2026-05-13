import { Pressable, Text, View, Image } from '@/tw';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Share } from 'react-native';
import * as Haptics from 'expo-haptics';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import { useOnboarding, DESTINATION_LABEL, type DemoPlacePick } from '@/lib/onboarding/state';

// Screen 11 — Value delivery. Renders the user's picks as a 2-column tile
// grid using the same visual recipe as components/PlaceTile.tsx so the
// onboarding output is visually consistent with what they'll see post-
// paywall. A "Share" affordance opens the iOS share sheet; the eventual
// image-render of the grid is a follow-up (TODO below).

const CATEGORY_ICON: Record<DemoPlacePick['category'], string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

export default function ValueScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { answers } = useOnboarding();

  const destLabel = answers.destination
    ? DESTINATION_LABEL[answers.destination]
    : 'next trip';
  const places = answers.starterPlaces;

  async function handleShare() {
    void Haptics.selectionAsync();
    // TODO render a branded image of the grid (per docs/MARKETING.md §2)
    // before launch. For MVP we share a plaintext promo so the iOS share
    // sheet works correctly without an image pipeline.
    try {
      await Share.share({
        message: `My starter ${destLabel} trip — built with Trip Pocket. https://trippocket.app`,
      });
    } catch {
      // User cancelled or share failed — nothing to do.
    }
  }

  return (
    <OnboardingScaffold
      step={10}
      headline={`Your ${destLabel} trip — ready.`}
      sub="Tap any place to see how it'll look in the app."
      footer={
        <View>
          <PrimaryButton
            label="Continue"
            onPress={() => router.push('/onboarding/paywall')}
          />
          <View style={{ height: 4 }} />
          <Pressable
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share my trip"
            className="flex-row items-center justify-center"
            style={{ height: 44 }}
          >
            <Icon name="square.and.arrow.up" size={16} tintColor={colors.textMuted} />
            <Text
              className="ml-2 text-text-muted"
              style={{ fontSize: 14, fontWeight: '500' }}
            >
              Share my trip
            </Text>
          </Pressable>
        </View>
      }
    >
      {places.length === 0 ? (
        <View
          className="items-center justify-center rounded-3xl border border-hairline bg-surface px-6 py-10"
        >
          <Icon name="tray" size={32} tintColor={colors.textMuted} />
          <Text
            className="mt-3 text-center text-text-muted"
            style={{ fontSize: 14, lineHeight: 20 }}
          >
            No places saved yet — that&apos;s fine, your real trips start when you
            share your first screenshot.
          </Text>
        </View>
      ) : (
        <View className="flex-row flex-wrap" style={{ gap: 6 }}>
          {places.map((p) => (
            <DemoTile key={p.id} place={p} />
          ))}
        </View>
      )}

      <View
        className="mt-5 flex-row items-center justify-center rounded-2xl bg-info-bg px-4 py-3"
      >
        <Icon name="checkmark.seal.fill" size={16} tintColor={colors.accent} />
        <Text className="ml-2 text-info-text" style={{ fontSize: 13, fontWeight: '600' }}>
          Saved by Trip Pocket · {destLabel}
        </Text>
      </View>
    </OnboardingScaffold>
  );
}

function DemoTile({ place }: { place: DemoPlacePick }) {
  return (
    <View
      style={{ width: '48%', aspectRatio: 3 / 4, borderRadius: 12, overflow: 'hidden' }}
    >
      <Image
        source={{ uri: place.imageUrl }}
        style={{ position: 'absolute', inset: 0 }}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={200}
      />
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.55)']}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <View style={{ position: 'absolute', left: 10, right: 10, bottom: 10 }}>
        <View
          className="self-start flex-row items-center rounded-full px-2 py-0.5"
          style={{ backgroundColor: 'rgba(255,255,255,0.18)' }}
        >
          <Icon name={CATEGORY_ICON[place.category]} size={9} tintColor="#ffffff" />
        </View>
        <Text
          numberOfLines={1}
          style={{
            color: '#ffffff',
            fontSize: 14,
            fontWeight: '700',
            marginTop: 4,
            textShadowColor: 'rgba(0,0,0,0.45)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 2,
          }}
        >
          {place.name}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            color: 'rgba(255,255,255,0.85)',
            fontSize: 11,
            fontWeight: '500',
            marginTop: 1,
          }}
        >
          {place.city}
        </Text>
      </View>
    </View>
  );
}
