import { useEffect } from 'react';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from '@/tw';
import { Icon } from './Icon';
import { buildMapUrl, type MapTarget } from '@/lib/openInMaps';
import { getEnricher } from '@/modules/enrichment';
import { useThemeColors } from '@/tw/theme';

export type PlaceRowData = {
  id: string;
  name: string;
  city: string;
  /** OCR-extracted street address. NULL when the source text didn't include one. */
  address: string | null;
  category: 'place' | 'food' | 'activity';
  /** Per-row enrichment state. Drives whether to fire /enrich on mount. */
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  external_place_id: string | null;
  /**
   * Venue-level enrichment fields, joined from place_enrichments. NULL
   * pre-enrichment. When present, the maps deep link upgrades from a
   * search-string URL to a pinned URL, and the card gets photo + blurb.
   */
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  photo_name: string | null;
  description: string | null;
  rating: number | null;
  price_level: number | null;
  external_url: string | null;
  /** Optional source-screenshot count, shown when > 1 in the trip Places tab. */
  source_count?: number;
};

const CATEGORY_ICON: Record<PlaceRowData['category'], string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

// Inputs to the Maps URL builder. Narrow subset of PlaceRowData so debug
// surfaces (OCR debug sheet) can compute the same URL without faking the
// rest of the row shape.
export type MapsUrlInput = Pick<
  PlaceRowData,
  'name' | 'city' | 'address' | 'latitude' | 'longitude' | 'external_place_id'
>;

export function getMapsUrl(place: MapsUrlInput): string {
  return buildMapUrl(toMapTarget(place));
}

export function PlaceRow({ place }: { place: PlaceRowData }) {
  const router = useRouter();
  const colors = useThemeColors();
  const subtitle = buildSubtitle(place);
  const photoUrl = buildPhotoUrl(place.photo_name);

  // Trigger enrichment on row mount when the row is in a state that
  // wants a /enrich call. The runner dedups internally, so it's safe
  // to fire from every visible row — and that's the point: the user
  // is *looking* at this place card, that's the engagement signal.
  useEffect(() => {
    if (place.enrichment_status === 'pending' || place.enrichment_status === 'failed') {
      getEnricher()?.enqueueEnrichment(place.id);
    }
  }, [place.id, place.enrichment_status]);

  return (
    <Pressable
      onPress={() => router.push(`/places/${place.id}`)}
      className="flex-row items-center gap-3 border-hairline px-4 py-3"
      style={{ borderBottomWidth: 1 }}
      accessibilityRole="button"
      accessibilityLabel={`Open ${place.name}`}
    >
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={{ width: 44, height: 44, borderRadius: 8 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View className="h-11 w-11 items-center justify-center rounded-lg bg-surface">
          <Icon name={CATEGORY_ICON[place.category]} size={20} tintColor={colors.text} />
        </View>
      )}
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="flex-shrink text-base font-medium text-text" numberOfLines={1}>
            {place.name}
          </Text>
          {place.rating !== null ? (
            <RatingBadge rating={place.rating} priceLevel={place.price_level} />
          ) : null}
        </View>
        {place.description ? (
          <Text className="text-sm text-text-muted" numberOfLines={2}>
            {place.description}
          </Text>
        ) : subtitle ? (
          <Text className="text-sm text-text-muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron.right" size={14} tintColor={colors.textMuted} />
    </Pressable>
  );
}

function RatingBadge({
  rating,
  priceLevel,
}: {
  rating: number;
  priceLevel: number | null;
}) {
  const priceStr = priceLevel !== null && priceLevel > 0 ? ' · '.concat('$'.repeat(priceLevel)) : '';
  return (
    <Text className="text-xs text-text-muted" numberOfLines={1}>
      ★ {rating.toFixed(1)}
      {priceStr}
    </Text>
  );
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  // photoName is "places/<placeId>/photos/<photoId>" — already URL-safe.
  return `${base.replace(/\/$/, '')}/${photoName}?w=88&h=88`;
}

function toMapTarget(place: MapsUrlInput): MapTarget {
  return {
    name: place.name,
    city: place.city,
    address: place.address,
    latitude: place.latitude,
    longitude: place.longitude,
    externalPlaceId: place.external_place_id,
  };
}

function buildSubtitle(place: PlaceRowData): string {
  const sourceFragment =
    place.source_count !== undefined && place.source_count > 1
      ? `${place.source_count} screenshots`
      : null;
  // Preference order: enriched formatted_address (filled by enrichment),
  // OCR-extracted street address, plain city. The first non-empty wins.
  const locationFragment =
    place.formatted_address || place.address?.trim() || place.city || null;
  return [locationFragment, sourceFragment].filter(Boolean).join(' · ');
}
