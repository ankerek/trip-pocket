import Constants from 'expo-constants';
import { Image, Pressable, Text, View } from '@/tw';
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { Icon } from './Icon';
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
 * 2-column tile used in trip detail and the global Places feed. Photo (when
 * enriched) with a name overlay; pre-enrichment falls back to a category-tinted
 * card with the name.
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
      className="overflow-hidden rounded-lg bg-slate-100"
      accessibilityRole="button"
      accessibilityLabel={place.name}
    >
      <View className="relative aspect-[3/4] w-full">
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="h-full w-full"
            contentFit="cover"
            transition={150}
          />
        ) : (
          <View className="h-full w-full items-center justify-center bg-slate-100">
            <Icon
              name={place.category ? CATEGORY_ICON[place.category] : 'mappin.circle'}
              size={36}
              tintColor="#94a3b8"
            />
          </View>
        )}
        {place.trip_name ? (
          <View
            className="absolute left-2 top-2 rounded-full px-2 py-0.5"
            style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)' }}
          >
            <Text className="text-[11px] font-medium text-white" numberOfLines={1}>
              {place.trip_name}
            </Text>
          </View>
        ) : null}
        {/* Bottom-aligned dark scrim with the place name. */}
        <View className="absolute inset-x-0 bottom-0 px-2 py-2"
              style={{ backgroundColor: 'rgba(15, 23, 42, 0.55)' }}>
          <Text className="text-sm font-semibold text-white" numberOfLines={2}>
            {place.name}
          </Text>
          {place.rating !== null ? (
            <Text className="text-[11px] text-white/80">
              ★ {place.rating.toFixed(1)}
              {place.price_level !== null && place.price_level > 0
                ? ' · '.concat('$'.repeat(place.price_level))
                : ''}
            </Text>
          ) : place.city ? (
            <Text className="text-[11px] text-white/80" numberOfLines={1}>
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
