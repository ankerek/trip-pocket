import Constants from 'expo-constants';
import { Image, Text, View } from '@/tw';
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from './Icon';
import { TripChip } from './TripChip';
import { PressableScale } from './PressableScale';
import { SkeletonBlock } from './Skeleton';
import { getEnricher } from '@/modules/enrichment';
import { useThemeColors } from '@/tw/theme';

export type PlaceCategory = 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';

export type PlaceTileData = {
  id: string;
  name: string;
  city: string | null;
  country_code: string | null;
  category: PlaceCategory | null;
  photo_name: string | null;
  rating: number | null;
  price_level: number | null;
  external_place_id: string | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  latitude: number | null;
  longitude: number | null;
  formatted_address: string | null;
  /** Trip name. Optional — only the global feed surfaces it; trip detail
   *  filters by trip_id and would just show the same chip on every tile. */
  trip_name?: string | null;
};

export const CATEGORY_ICON: Record<PlaceCategory, string> = {
  food: 'fork.knife',
  drinks: 'wineglass',
  stays: 'bed.double',
  sights: 'binoculars',
  activities: 'figure.hiking',
  shops: 'bag',
};

/** Singular instance label, used wherever a single place is described
 *  (triage card, demo card, accessibilityHint). Plural-noun storage keys
 *  → singular display labels for instance contexts. */
export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  food: 'Food',
  drinks: 'Drink',
  stays: 'Stay',
  sights: 'Sight',
  activities: 'Activity',
  shops: 'Shop',
};

/**
 * Photo-led 2-col tile used in Pocket and trip detail. Spec §4.1, §9.2.
 *
 * Overlay recipe is fixed (single 0.55 alpha gradient stop + text shadow)
 * so contrast holds against high-luminance photos. The trip chip is on a
 * translucent material that reads in both light and dark mode.
 */
export function PlaceTile({ place }: { place: PlaceTileData }) {
  const router = useRouter();
  const colors = useThemeColors();
  const photoUrl = buildPhotoUrl(place.photo_name);

  // Trigger enrichment on mount when warranted; runner dedups internally.
  useEffect(() => {
    if (place.enrichment_status === 'pending' || place.enrichment_status === 'failed') {
      getEnricher()?.enqueueEnrichment(place.id);
    }
  }, [place.id, place.enrichment_status]);

  return (
    <PressableScale
      onPress={() => router.push(`/places/${place.id}`)}
      className="bg-surface overflow-hidden rounded-xl"
      haptic={false}
      accessibilityRole="button"
      accessibilityLabel={place.name}
      accessibilityHint={buildAccessibilityHint(place)}
    >
      <View className="relative aspect-square w-full">
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="h-full w-full"
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={place.id}
            transition={150}
            accessibilityIgnoresInvertColors
          />
        ) : place.enrichment_status === 'pending' ? (
          // Pending enrichment — shimmer reads as "still loading", not
          // visually identical to the not-found / no-photo fallback below.
          <SkeletonBlock testID={`place-tile-skeleton-${place.id}`} />
        ) : (
          <View className="bg-surface h-full w-full items-center justify-center">
            <Icon
              name={place.category ? CATEGORY_ICON[place.category] : 'mappin.circle'}
              size={36}
              tintColor={colors.textMuted}
            />
          </View>
        )}

        {place.trip_name ? (
          <View className="absolute top-2 left-2">
            <TripChip name={place.trip_name} variant="overlay" />
          </View>
        ) : null}

        {/*
          Spec §9.2 — overlay recipe upgraded from a solid alpha to a real
          LinearGradient (transparent → 0.65). The gradient + text shadow
          keep the white title at 4.5:1 against high-luminance photos
          while fading cleanly into the image instead of leaving a hard
          edge. Same recipe as the place-detail hero.
        */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.65)']}
          locations={[0, 1]}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '55%',
          }}
        />
        <View pointerEvents="none" className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
          <Text
            numberOfLines={2}
            style={{
              fontSize: 13,
              fontWeight: '600',
              color: '#ffffff',
              textShadowColor: 'rgba(0,0,0,0.45)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 2,
            }}
          >
            {place.name}
          </Text>
          {place.category || place.city || place.rating !== null ? (
            <SecondaryLine category={place.category} city={place.city} rating={place.rating} />
          ) : null}
        </View>
      </View>
    </PressableScale>
  );
}

function SecondaryLine({
  category,
  city,
  rating,
}: {
  category: PlaceCategory | null;
  city: string | null;
  rating: number | null;
}) {
  const text = [city ?? '', rating !== null ? `★ ${rating.toFixed(1)}` : '']
    .filter(Boolean)
    .join(' · ');
  // Icon + text share the same 11pt visual weight. Icon goes through a
  // wrapping View so its shadow plays nicely with the surrounding gradient.
  return (
    <View className="flex-row items-center" style={{ gap: 4 }}>
      {category ? (
        <View
          style={{
            shadowColor: 'rgba(0,0,0,0.45)',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 1,
            shadowRadius: 2,
          }}
        >
          <Icon name={CATEGORY_ICON[category]} size={11} tintColor="rgba(255,255,255,0.85)" />
        </View>
      ) : null}
      {text ? (
        <Text
          numberOfLines={1}
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.85)',
            fontVariant: ['tabular-nums'],
            textShadowColor: 'rgba(0,0,0,0.45)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 2,
          }}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}

function buildAccessibilityHint(place: PlaceTileData): string {
  const parts: string[] = [];
  if (place.category) parts.push(CATEGORY_LABEL[place.category]);
  if (place.city) parts.push(`in ${place.city}`);
  const lead = parts.length > 0 ? parts.join(' ') + '. ' : '';
  return `${lead}Opens place detail.`;
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=400&h=400`;
}
