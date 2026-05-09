import Constants from 'expo-constants';
import { Image, Pressable, Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { Icon } from './Icon';
import { TripChip } from './TripChip';
import { CategoryChip } from './CategoryChip';

export type SearchResultRowData = {
  id: string;
  name: string;
  city: string | null;
  category: string | null;
  photo_name: string | null;
  trip_id: string | null;
  trip_name: string | null;
};

const CATEGORY_ICON: Record<string, string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
};

export function SearchResultRow({ place }: { place: SearchResultRowData }) {
  const router = useRouter();
  const photoUrl = buildPhotoUrl(place.photo_name);

  return (
    <Pressable
      onPress={() => router.push(`/places/${place.id}`)}
      className="flex-row items-center gap-3 py-2"
      accessibilityRole="button"
      accessibilityLabel={`Open ${place.name}${place.trip_name ? ` in ${place.trip_name}` : ''}`}
    >
      <View className="h-16 w-16 overflow-hidden rounded-tile bg-surface">
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="h-full w-full"
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={120}
          />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <Icon
              name={place.category ? CATEGORY_ICON[place.category] ?? 'mappin.circle' : 'mappin.circle'}
              size={22}
              tintColor="#94a3b8"
            />
          </View>
        )}
      </View>

      <View className="flex-1">
        <Text className="text-base font-semibold text-text" numberOfLines={1}>
          {place.name}
        </Text>
        <View className="mt-1 flex-row items-center gap-1.5">
          <TripChip name={place.trip_name ?? 'Inbox'} variant="inline" />
          {place.category ? <CategoryChip category={place.category} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=160&h=160`;
}
