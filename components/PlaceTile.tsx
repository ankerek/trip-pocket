import Constants from 'expo-constants';
import { Image, Pressable, Text, View } from '@/tw';
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { Icon } from './Icon';
import { TripChip } from './TripChip';
import { getEnricher } from '@/modules/enrichment';

export type PlaceTileData = {
  id: string;
  name: string;
  city: string | null;
  category: 'place' | 'food' | 'activity' | null;
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

const CATEGORY_ICON: Record<NonNullable<PlaceTileData['category']>, string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
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
  const photoUrl = buildPhotoUrl(place.photo_name);

  // Trigger enrichment on mount when warranted; runner dedups internally.
  useEffect(() => {
    if (place.enrichment_status === 'pending' || place.enrichment_status === 'failed') {
      getEnricher()?.enqueueEnrichment(place.id);
    }
  }, [place.id, place.enrichment_status]);

  return (
    <Pressable
      onPress={() => router.push(`/places/${place.id}`)}
      className="overflow-hidden rounded-xl"
      style={{ backgroundColor: '#e2e8f0' }}
      accessibilityRole="button"
      accessibilityLabel={place.name}
      accessibilityHint={place.city ? `In ${place.city}. Opens place detail.` : 'Opens place detail.'}
    >
      <View className="relative aspect-[3/4] w-full">
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="h-full w-full"
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View className="h-full w-full items-center justify-center" style={{ backgroundColor: '#e2e8f0' }}>
            <Icon
              name={place.category ? CATEGORY_ICON[place.category] : 'mappin.circle'}
              size={36}
              tintColor="#94a3b8"
            />
          </View>
        )}

        {place.trip_name ? (
          <View className="absolute left-2 top-2">
            <TripChip name={place.trip_name} variant="overlay" />
          </View>
        ) : null}

        {/*
          Spec §9.2 — single overlay recipe. Bottom 45% of the tile
          fades from transparent to rgba(0,0,0,0.55). White name with a
          1px text shadow holds 4.5:1 even on high-luminance photos.
        */}
        <View
          pointerEvents="none"
          className="absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-8"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
        >
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
          {place.rating !== null ? (
            <Text
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.85)',
                fontVariant: ['tabular-nums'],
              }}
            >
              ★ {place.rating.toFixed(1)}
              {place.price_level !== null && place.price_level > 0
                ? ' · '.concat('$'.repeat(place.price_level))
                : ''}
            </Text>
          ) : place.city ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}
            >
              {place.city}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=400&h=520`;
}
