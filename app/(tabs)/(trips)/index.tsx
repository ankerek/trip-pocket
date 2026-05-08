import { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from '@/tw';
import { FlatList } from 'react-native';
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

  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['trips', 'places']);

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
        <View className="flex-1 items-center justify-center bg-bg">
          <Text className="text-base text-text-muted">
            No trips yet — tap + to create one.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <HeaderPlusButton /> }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: '#ffffff' }}
        data={rows}
        keyExtractor={(r) => r.trip.id}
        contentContainerStyle={{ padding: 14, paddingBottom: 96 }}
        windowSize={10}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/trips/${item.trip.id}`)}
            className="mb-3 overflow-hidden rounded-2xl"
            style={{
              backgroundColor: '#f8fafc',
              borderWidth: 1,
              borderColor: 'rgba(15,23,42,0.06)',
            }}
            accessibilityRole="button"
            accessibilityLabel={`${item.trip.name}, ${item.count} place${item.count === 1 ? '' : 's'}`}
          >
            <View className="px-4 pt-3 pb-2 flex-row items-baseline justify-between">
              <Text
                className="flex-1 pr-2"
                numberOfLines={1}
                style={{ fontSize: 17, fontWeight: '600', color: '#0c4a6e' }}
              >
                {item.trip.name}
              </Text>
              <Text
                style={{ fontSize: 13, color: '#94a3b8', fontVariant: ['tabular-nums'] }}
              >
                {item.count} place{item.count === 1 ? '' : 's'}
              </Text>
            </View>
            <FlatList
              data={item.previews}
              horizontal
              keyExtractor={(p) => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 14, gap: 6 }}
              renderItem={({ item: p }) => (
                <Pressable
                  onPress={() => router.push(`/places/${p.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={p.name}
                >
                  <PreviewThumb place={p} />
                </Pressable>
              )}
              ListEmptyComponent={
                <Text
                  className="px-4 pb-3"
                  style={{ fontSize: 12, color: '#94a3b8' }}
                >
                  No places yet
                </Text>
              }
            />
          </Pressable>
        )}
      />
    </>
  );
}

function PreviewThumb({ place }: { place: TripPreviewPlace }) {
  const photoUri = buildPhotoUri(place.photo_name);
  if (photoUri) {
    return (
      <Image
        source={{ uri: photoUri }}
        style={{
          width: 72,
          height: 90,
          borderRadius: 10,
          backgroundColor: '#e2e8f0',
        }}
        contentFit="cover"
        cachePolicy="memory-disk"
      />
    );
  }
  return (
    <View
      style={{
        width: 72,
        height: 90,
        borderRadius: 10,
        backgroundColor: '#e2e8f0',
      }}
      className="items-center justify-center"
    >
      <Text style={{ fontSize: 16, fontWeight: '600', color: '#94a3b8' }}>
        {place.name?.charAt(0)?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

function buildPhotoUri(photoName: string | null): string | null {
  if (!photoName) return null;
  const Constants = require('expo-constants').default;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=144&h=180`;
}

function HeaderPlusButton() {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push('/trips/new')}
      className="px-3"
      accessibilityRole="button"
      accessibilityLabel="Add new trip"
      hitSlop={8}
    >
      <Icon name="plus" size={22} tintColor="#0c4a6e" />
    </Pressable>
  );
}
