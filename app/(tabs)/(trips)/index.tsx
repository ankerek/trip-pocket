import { useEffect, useState } from 'react';
import { Image, Text, View, useCSSVariable } from '@/tw';
import { FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { EmptyState } from '@/components/EmptyState';
import { HeaderActionButton } from '@/components/HeaderActionButton';
import { PressableScale } from '@/components/PressableScale';
import { listTrips, useLiveQuery, type Trip } from '@/modules/storage';
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
                    WHERE trip_id IS NOT NULL
                 GROUP BY trip_id`;

const PREVIEWS_SQL = `SELECT id, name, photo_name, external_place_id
                        FROM places
                       WHERE trip_id = ?
                    ORDER BY COALESCE(enriched_at, created_at) DESC, created_at DESC
                       LIMIT 5`;

export default function Trips() {
  const router = useRouter();
  const db = useDatabase();
  const insets = useSafeAreaInsets();

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
      <View className="bg-bg flex-1">
        {/* Float the title over the EmptyState so the body centers in the
            viewport, not in the post-title flex region. */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            paddingTop: insets.top,
            zIndex: 1,
          }}
        >
          <TripsTitleRow />
        </View>
        <EmptyState
          icon="folder.badge.plus"
          title="No trips yet"
          body="Trips group your sources together — like “Japan” or “Lisbon weekend”."
          cta={{
            label: 'Create your first trip',
            onPress: () => router.push('/trips/new'),
            accessibilityHint: 'Opens the new-trip screen',
          }}
        />
      </View>
    );
  }

  return (
    <FlatList
      // No native header on this screen — see (trips)/_layout.tsx. The
      // inline title row is rendered as the first element below so it sits
      // just under the status bar.
      contentInsetAdjustmentBehavior="never"
      className="bg-bg flex-1"
      style={{ paddingTop: insets.top }}
      data={rows}
      keyExtractor={(r) => r.trip.id}
      contentContainerStyle={{ padding: 14, paddingBottom: 96 }}
      windowSize={10}
      ListHeaderComponent={<TripsTitleRow />}
      renderItem={({ item }) => (
        <PressableScale
          onPress={() => router.push(`/trips/${item.trip.id}`)}
          className="border-hairline bg-surface mb-3 overflow-hidden rounded-2xl border"
          haptic={false}
          accessibilityRole="button"
          accessibilityLabel={`${item.trip.name}, ${item.count} place${item.count === 1 ? '' : 's'}`}
        >
          <View className="flex-row items-baseline justify-between px-4 pt-3 pb-2">
            <Text
              className="text-text flex-1 pr-2"
              numberOfLines={1}
              style={{ fontSize: 17, fontWeight: '600' }}
            >
              {item.trip.name}
            </Text>
            <Text
              className="text-text-muted"
              style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}
            >
              {item.count} place{item.count === 1 ? '' : 's'}
            </Text>
          </View>
          {item.previews.length === 0 ? (
            <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
              <Text className="text-text-muted" style={{ fontSize: 12 }}>
                No places yet
              </Text>
            </View>
          ) : (
            <View
              style={{
                flexDirection: 'row',
                paddingHorizontal: 14,
                paddingBottom: 14,
                gap: 6,
              }}
            >
              {item.previews.map((p) => (
                <PreviewThumb key={p.id} place={p} />
              ))}
            </View>
          )}
        </PressableScale>
      )}
    />
  );
}

// Inline large-title row — mirrors PocketTitleRow so the two tabs share
// the same visual rhythm (34pt bold title with a HeaderActionButton on
// the trailing edge).
function TripsTitleRow() {
  const router = useRouter();
  return (
    <View className="flex-row items-center justify-between px-4 pt-2 pb-2">
      <Text
        className="text-text"
        style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.4 }}
        accessibilityRole="header"
      >
        Trips
      </Text>
      <HeaderActionButton
        icon="plus"
        accessibilityLabel="Add new trip"
        onPress={() => router.push('/trips/new')}
      />
    </View>
  );
}

function PreviewThumb({ place }: { place: TripPreviewPlace }) {
  const photoUri = buildPhotoUri(place.photo_name);
  const placeholderBg = useCSSVariable('--color-hairline');
  if (photoUri) {
    return (
      <Image
        source={{ uri: photoUri }}
        style={{
          width: 72,
          height: 90,
          borderRadius: 10,
          backgroundColor: placeholderBg,
        }}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={place.id}
      />
    );
  }
  return (
    <View
      style={{
        width: 72,
        height: 90,
        borderRadius: 10,
        backgroundColor: placeholderBg,
      }}
      className="items-center justify-center"
    >
      <Text className="text-text-muted" style={{ fontSize: 16, fontWeight: '600' }}>
        {place.name?.charAt(0)?.toUpperCase() ?? '?'}
      </Text>
    </View>
  );
}

function buildPhotoUri(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=144&h=180`;
}
