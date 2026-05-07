import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getTrip, useLiveQuery, type Trip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { SearchButton } from '@/components/SearchButton';
import { Icon } from '@/components/Icon';

type GridRow = GridItem;

const TRIP_GRID_SQL = `SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
                              COALESCE(p.place_count, 0) AS place_count
                         FROM screenshots s
                    LEFT JOIN (
                           SELECT screenshot_id, COUNT(*) AS place_count
                             FROM extracted_places
                            WHERE deleted_at IS NULL
                         GROUP BY screenshot_id
                         ) p ON p.screenshot_id = s.id
                        WHERE s.deleted_at IS NULL AND s.trip_id = ?
                     ORDER BY s.captured_at DESC`;

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [trip, setTrip] = useState<Trip | null | 'loading'>('loading');

  // The screenshot grid is reactive: places committed by extraction
  // notifyChange('extracted_places'), which re-fires this query so the
  // pin badge appears live when extraction finishes.
  const screenshots = useLiveQuery<GridRow>(
    TRIP_GRID_SQL,
    id ? [id] : [],
    ['screenshots', 'extracted_places'],
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

  if (trip === 'loading' || screenshots === null) return null;

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
      {screenshots.length === 0 ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-white"
          contentContainerClassName="flex-1 items-center justify-center px-8"
        >
          <Text className="text-center text-base text-slate-500">
            No places in this trip yet — add some from Inbox.
          </Text>
        </ScrollView>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-white"
        >
          <PlaceGrid data={screenshots} />
        </ScrollView>
      )}
    </>
  );
}
