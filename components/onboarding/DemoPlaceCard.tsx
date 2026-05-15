import { Image, Text, View } from '@/tw';
import { Icon } from '@/components/Icon';
import { CATEGORY_ICON, CATEGORY_LABEL } from '@/components/PlaceTile';
import { useThemeColors } from '@/tw/theme';
import type { DemoPlaceFixture } from '@/lib/onboarding/demoFixtures';

// The reveal card in the onboarding demo. Mirrors the visual recipe of
// components/PlaceRow.tsx (44pt photo + name + city/category subtitle)
// but it's pure presentational — no DB lookup, no enrichment trigger,
// no routing. Spec: 2026-05-13-onboarding-redesign-design.md.

export function DemoPlaceCard({ place }: { place: DemoPlaceFixture }) {
  const colors = useThemeColors();
  return (
    <View
      className="bg-surface flex-row items-center rounded-2xl px-3 py-3"
      style={{ borderWidth: 1, borderColor: colors.hairline, gap: 12 }}
      accessibilityRole="text"
      accessibilityLabel={`${place.name}, ${place.city}, ${CATEGORY_LABEL[place.category]}`}
    >
      <Image
        source={{ uri: place.photoUrl }}
        style={{ width: 44, height: 44, borderRadius: 8 }}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
      />
      <View className="flex-1">
        <Text
          className="text-text"
          numberOfLines={1}
          style={{ fontSize: 15, fontWeight: '600', letterSpacing: -0.2 }}
        >
          {place.name}
        </Text>
        <Text className="text-text-muted" numberOfLines={1} style={{ fontSize: 13, marginTop: 1 }}>
          {place.city} · {CATEGORY_LABEL[place.category]}
        </Text>
      </View>
      <Icon name={CATEGORY_ICON[place.category]} size={16} tintColor={colors.textMuted} />
    </View>
  );
}
