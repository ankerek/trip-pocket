import { Pressable, Text, View } from '@/tw';
import { Linking } from 'react-native';
import { Icon } from './Icon';

export type PlaceRowData = {
  id: string;
  name: string;
  city: string;
  category: 'place' | 'food' | 'activity';
  formatted_address: string | null;
  apple_maps_url: string | null;
  /** Optional source-screenshot count, shown when > 1 in the trip Places tab. */
  source_count?: number;
};

const CATEGORY_ICON: Record<PlaceRowData['category'], string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

/**
 * Single place row used in both:
 *   - the screenshot detail's places-found sheet (one screenshot's places)
 *   - the trip detail's Places tab (distinct places across the trip)
 *
 * Tapping always tries the geocoded apple_maps_url first, then falls back
 * to a `?q=name+city` query-string deep link when the geocoder missed.
 */
export function PlaceRow({ place }: { place: PlaceRowData }) {
  const url =
    place.apple_maps_url ||
    `https://maps.apple.com/?q=${encodeURIComponent(
      [place.name, place.city].filter(Boolean).join(', '),
    )}`;
  const subtitle = buildSubtitle(place);

  return (
    <Pressable
      onPress={() => {
        Linking.openURL(url).catch((err) =>
          console.warn('[place-row] open Maps failed', err),
        );
      }}
      className="flex-row items-center gap-3 border-b border-slate-100 px-4 py-3"
      accessibilityRole="button"
      accessibilityLabel={`Open ${place.name} in Apple Maps`}
    >
      <View className="h-9 w-9 items-center justify-center rounded-full bg-slate-100">
        <Icon name={CATEGORY_ICON[place.category]} size={18} tintColor="#0f172a" />
      </View>
      <View className="flex-1">
        <Text className="text-base font-medium text-slate-900">{place.name}</Text>
        {subtitle ? (
          <Text className="text-sm text-slate-500" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Icon name="arrow.up.right.square" size={18} tintColor="#64748b" />
    </Pressable>
  );
}

function buildSubtitle(place: PlaceRowData): string {
  const sourceFragment =
    place.source_count !== undefined && place.source_count > 1
      ? `${place.source_count} screenshots`
      : null;
  const locationFragment = place.formatted_address || place.city || null;
  return [locationFragment, sourceFragment].filter(Boolean).join(' · ');
}
