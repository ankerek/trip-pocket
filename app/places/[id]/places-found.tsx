import { Pressable, ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import { Linking } from 'react-native';
import { useLiveQuery } from '@/modules/storage';
import { Icon } from '@/components/Icon';

const PLACES_SQL = `SELECT id, name, city, category,
                           formatted_address, apple_maps_url
                      FROM extracted_places
                     WHERE screenshot_id = ? AND deleted_at IS NULL
                  ORDER BY created_at ASC`;

const STATUS_SQL = `SELECT extraction_status FROM screenshots
                     WHERE id = ? AND deleted_at IS NULL`;

type Place = {
  id: string;
  name: string;
  city: string;
  category: 'place' | 'food' | 'activity';
  formatted_address: string | null;
  apple_maps_url: string | null;
};

type StatusRow = { extraction_status: 'pending' | 'done' | 'failed' };

const CATEGORY_ICON: Record<Place['category'], string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

export default function PlacesFoundSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const places = useLiveQuery<Place>(
    PLACES_SQL,
    id ? [id] : [],
    ['extracted_places'],
  );
  const statusRows = useLiveQuery<StatusRow>(
    STATUS_SQL,
    id ? [id] : [],
    ['screenshots'],
  );

  if (places === null || statusRows === null) return null;
  const status = statusRows[0]?.extraction_status;

  if (status === 'pending') {
    return (
      <View className="flex-1 items-center justify-center bg-white px-8">
        <Text className="text-center text-base text-slate-500">
          Still processing — places will appear in a few seconds.
        </Text>
      </View>
    );
  }
  if (status === 'failed') {
    return (
      <View className="flex-1 items-center justify-center bg-white px-8">
        <Text className="text-center text-base text-slate-500">
          Couldn&apos;t extract places this time. We&apos;ll retry on the next app launch.
        </Text>
      </View>
    );
  }
  if (places.length === 0) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-8">
        <Text className="text-center text-base text-slate-500">
          No places detected.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-white" contentContainerClassName="py-2">
      {places.map((p) => (
        <PlaceRow key={p.id} place={p} />
      ))}
    </ScrollView>
  );
}

function PlaceRow({ place }: { place: Place }) {
  const url =
    place.apple_maps_url ||
    `https://maps.apple.com/?q=${encodeURIComponent(
      [place.name, place.city].filter(Boolean).join(', '),
    )}`;
  const subtitle = place.formatted_address || place.city || '';

  return (
    <Pressable
      onPress={() => {
        Linking.openURL(url).catch((err) =>
          console.warn('[places-found] open Maps failed', err),
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
