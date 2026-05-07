import { useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Tabs, useRouter } from 'expo-router';
import {
  countByTrip,
  listScreenshotsByTrip,
  listTrips,
  useLiveQuery,
  type Screenshot,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/app/_components/useDatabase';

type TripRowData = {
  trip: Trip;
  count: number;
  previews: Screenshot[];
};

export default function Trips() {
  const router = useRouter();
  const db = useDatabase();

  // Live-trigger that refreshes when trips OR screenshots change.
  const tick = useLiveQuery<{ v: number }>(
    `SELECT 0 AS v`,
    [],
    ['trips', 'screenshots'],
  );

  const [rows, setRows] = useState<TripRowData[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!db) return;
    (async () => {
      const trips = await listTrips(db);
      const counts = await countByTrip(db);
      const previewsByTrip: Record<string, Screenshot[]> = {};
      await Promise.all(
        trips.map(async (t) => {
          previewsByTrip[t.id] = await listScreenshotsByTrip(db, t.id, 5);
        }),
      );
      if (cancelled) return;
      setRows(
        trips.map((trip) => ({
          trip,
          count: counts[trip.id] ?? 0,
          previews: previewsByTrip[trip.id] ?? [],
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [db, tick]);

  if (rows === null) return null;

  if (rows.length === 0) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Tabs.Screen options={{ headerRight: () => <HeaderPlusButton /> }} />
        <Text className="text-base text-slate-500">No trips yet — tap + to create one.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Tabs.Screen options={{ headerRight: () => <HeaderPlusButton /> }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.trip.id}
        contentContainerClassName="p-2"
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/trips/${item.trip.id}`)}
            className="mb-3 rounded-xl bg-slate-50 p-3"
            accessibilityRole="button"
            accessibilityLabel={item.trip.name}
          >
            <View className="flex-row items-baseline justify-between">
              <Text className="text-base font-semibold text-slate-900">{item.trip.name}</Text>
              <Text className="text-sm text-slate-500">{item.count}</Text>
            </View>
            <FlatList
              data={item.previews}
              horizontal
              keyExtractor={(p) => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="mt-2"
              renderItem={({ item: p }) => (
                <Pressable
                  onPress={() => router.push(`/places/${p.id}`)}
                  className="mr-2"
                  accessibilityRole="button"
                  accessibilityLabel="Screenshot"
                >
                  <Image
                    source={{ uri: p.filePath }}
                    className="h-20 w-16 rounded-md bg-slate-200"
                    resizeMode="cover"
                  />
                </Pressable>
              )}
              ListEmptyComponent={
                <Text className="mt-2 text-xs text-slate-400">No places yet</Text>
              }
            />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

function HeaderPlusButton() {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push('/trips/new')}
      className="px-3"
      accessibilityRole="button"
      accessibilityLabel="Add new trip"
    >
      <Text className="text-2xl font-semibold text-slate-900">＋</Text>
    </Pressable>
  );
}
