import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getTrip, useLiveQuery, type Trip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { PlaceTile, type PlaceTileData } from '@/components/PlaceTile';
import { SearchButton } from '@/components/SearchButton';
import { Icon } from '@/components/Icon';

const TRIP_SOURCES_SQL = `SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
                                 COALESCE(p.place_count, 0) AS place_count
                            FROM sources s
                       LEFT JOIN (
                              SELECT ps.source_id, COUNT(*) AS place_count
                                FROM place_sources ps
                               WHERE ps.deleted_at IS NULL
                            GROUP BY ps.source_id
                            ) p ON p.source_id = s.id
                           WHERE s.deleted_at IS NULL AND s.trip_id = ?
                        ORDER BY s.captured_at DESC`;

const TRIP_PLACES_SQL = `SELECT id, name, city, category, photo_name,
                                rating, price_level,
                                external_place_id, enrichment_status,
                                latitude, longitude, formatted_address
                           FROM places
                          WHERE trip_id = ? AND deleted_at IS NULL
                       ORDER BY enriched_at DESC NULLS LAST, created_at DESC`;

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [trip, setTrip] = useState<Trip | null | 'loading'>('loading');
  const [tab, setTab] = useState<'photos' | 'places'>('places');

  const sources = useLiveQuery<GridItem>(
    TRIP_SOURCES_SQL,
    id ? [id] : [],
    ['sources', 'place_sources'],
  );
  const places = useLiveQuery<PlaceTileData>(
    TRIP_PLACES_SQL,
    id ? [id] : [],
    ['places'],
  );

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    (async () => {
      const t = await getTrip(db, id);
      if (cancelled) return;
      setTrip(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (trip === 'loading' || sources === null || places === null) return null;

  if (trip === null) {
    return (
      <>
        <Stack.Screen options={{ title: '' }} />
        <View className="flex-1 items-center justify-center bg-white">
          <Text className="text-base text-slate-500">Trip not found.</Text>
        </View>
      </>
    );
  }

  const empty = sources.length === 0 && places.length === 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: trip.name,
          headerLargeTitle: true,
          headerRight: () => (
            <View className="flex-row items-center">
              <SearchButton />
              <Pressable
                onPress={() => router.push(`/trips/${trip.id}/edit`)}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="Edit trip"
              >
                <Icon name="pencil" size={22} tintColor="#0f172a" />
              </Pressable>
            </View>
          ),
        }}
      />
      {empty ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-white"
          contentContainerClassName="flex-1 items-center justify-center px-8"
        >
          <Text className="text-center text-base text-slate-500">
            No places in this trip yet — add some from the Places tab.
          </Text>
        </ScrollView>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-white"
        >
          <TabToggle
            tab={tab}
            onChange={setTab}
            placesCount={places.length}
            sourcesCount={sources.length}
          />
          {tab === 'places' ? (
            <View className="flex-row flex-wrap p-2">
              {places.map((p) => (
                <View key={p.id} className="w-1/2 p-1">
                  <PlaceTile place={p} />
                </View>
              ))}
            </View>
          ) : (
            <PlaceGrid data={sources} />
          )}
        </ScrollView>
      )}
    </>
  );
}

function TabToggle({
  tab,
  onChange,
  placesCount,
  sourcesCount,
}: {
  tab: 'photos' | 'places';
  onChange: (next: 'photos' | 'places') => void;
  placesCount: number;
  sourcesCount: number;
}) {
  return (
    <View className="flex-row gap-1 px-4 py-3">
      <TabButton
        label={`Places · ${placesCount}`}
        active={tab === 'places'}
        onPress={() => onChange('places')}
      />
      <TabButton
        label={`Sources · ${sourcesCount}`}
        active={tab === 'photos'}
        onPress={() => onChange('photos')}
      />
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-1 items-center rounded-full px-4 py-2 ${
        active ? 'bg-slate-900' : 'bg-slate-100'
      }`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text className={`text-sm font-medium ${active ? 'text-white' : 'text-slate-700'}`}>
        {label}
      </Text>
    </Pressable>
  );
}
