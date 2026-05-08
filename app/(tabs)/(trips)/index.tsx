import { useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';
import {
  listTrips,
  useLiveQuery,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';

type TripPreviewPlace = {
  id: string;
  name: string;
  photo_name: string | null;
  external_place_id: string | null;
};

type TripRowData = {
  trip: Trip;
  count: number;
  previews: TripPreviewPlace[];
};

const COUNT_SQL = `SELECT trip_id, COUNT(*) AS n
                     FROM places
                    WHERE trip_id IS NOT NULL AND deleted_at IS NULL
                 GROUP BY trip_id`;

const PREVIEWS_SQL = `SELECT id, name, photo_name, external_place_id
                        FROM places
                       WHERE trip_id = ? AND deleted_at IS NULL
                    ORDER BY enriched_at DESC NULLS LAST, created_at DESC
                       LIMIT 5`;

export default function Trips() {
  const router = useRouter();
  const db = useDatabase();

  const tick = useLiveQuery<{ v: number }>(
    `SELECT 0 AS v`,
    [],
    ['trips', 'places'],
  );

  const [rows, setRows] = useState<TripRowData[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!db) return;
    (async () => {
      const trips = await listTrips(db);
      const countRows = await db.getAllAsync<{ trip_id: string; n: number }>(COUNT_SQL);
      const counts: Record<string, number> = {};
      for (const r of countRows) counts[r.trip_id] = r.n;

      const previewsByTrip: Record<string, TripPreviewPlace[]> = {};
      await Promise.all(
        trips.map(async (t) => {
          previewsByTrip[t.id] = await db.getAllAsync<TripPreviewPlace>(PREVIEWS_SQL, t.id);
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
      <>
        <Stack.Screen options={{ headerRight: () => <HeaderPlusButton /> }} />
        <View className="flex-1 items-center justify-center bg-white">
          <Text className="text-base text-slate-500">No trips yet — tap + to create one.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <HeaderPlusButton /> }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        className="bg-white"
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
              <Text
                className="flex-1 pr-2 text-base font-semibold text-slate-900"
                numberOfLines={1}
              >
                {item.trip.name}
              </Text>
              <Text
                className="text-sm text-slate-500"
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {item.count}
              </Text>
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
                  accessibilityLabel={p.name}
                >
                  <PreviewThumb place={p} />
                </Pressable>
              )}
              ListEmptyComponent={
                <Text className="mt-2 text-xs text-slate-400">No places yet</Text>
              }
            />
          </Pressable>
        )}
      />
    </>
  );
}

function PreviewThumb({ place }: { place: TripPreviewPlace }) {
  // Built lazily so we can fall back gracefully when photo_name is null
  // (pre-enrichment) — show a soft tile with the place initial.
  const photoUri = buildPhotoUri(place.photo_name);
  if (photoUri) {
    return (
      <Image
        source={{ uri: photoUri }}
        className="h-20 w-16 rounded-md bg-slate-200"
        contentFit="cover"
      />
    );
  }
  return (
    <View className="h-20 w-16 items-center justify-center rounded-md bg-slate-200">
      <Text className="text-base font-semibold text-slate-500">
        {place.name?.charAt(0)?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

function buildPhotoUri(photoName: string | null): string | null {
  if (!photoName) return null;
  // Lazy require keeps this file zero-cost on platforms without expo-constants.
  const Constants = require('expo-constants').default;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=128&h=160`;
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
      <Icon name="plus" size={22} tintColor="#0f172a" />
    </Pressable>
  );
}
