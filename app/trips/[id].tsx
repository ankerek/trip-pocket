import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getTrip, useLiveQuery, type Trip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { PlaceRow, type PlaceRowData } from '@/components/PlaceRow';
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

// Distinct places across the trip's screenshots. The GROUP BY key:
//   (LOWER(name), LOWER(TRIM(city)), COALESCE(apple_maps_url, ''))
//
// Including apple_maps_url is the codex-flagged P2 fix: without it, two
// distinct branches of a chain (e.g. two different Starbucks in Tokyo)
// collapse into a single row, and tapping it can only open one of them.
// With apple_maps_url in the key, geocoded distinct branches stay
// distinct (their URLs differ); non-geocoded duplicates of the same
// name+city still merge (both have NULL → COALESCE → '' → same group),
// which is the correct behavior when we have no location signal.
//
// MIN(id), MAX(formatted_address) etc. are arbitrary picks — within a
// group all rows share the same canonical apple_maps_url (it's part of
// the key), so the formatted_address from any one of them is fine.
const TRIP_PLACES_SQL = `SELECT
                           MIN(ep.id) AS id,
                           ep.name,
                           ep.city,
                           ep.category,
                           MAX(ep.formatted_address) AS formatted_address,
                           ep.apple_maps_url,
                           COUNT(DISTINCT ep.screenshot_id) AS source_count,
                           MAX(ep.created_at) AS last_seen
                         FROM extracted_places ep
                         JOIN screenshots s ON s.id = ep.screenshot_id
                         WHERE s.trip_id = ?
                           AND s.deleted_at IS NULL
                           AND ep.deleted_at IS NULL
                         GROUP BY LOWER(ep.name),
                                  LOWER(TRIM(ep.city)),
                                  COALESCE(ep.apple_maps_url, '')
                         ORDER BY last_seen DESC`;

type TripPlaceRow = PlaceRowData & { last_seen: string };

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [trip, setTrip] = useState<Trip | null | 'loading'>('loading');
  const [tab, setTab] = useState<'photos' | 'places'>('photos');

  const screenshots = useLiveQuery<GridRow>(
    TRIP_GRID_SQL,
    id ? [id] : [],
    ['screenshots', 'extracted_places'],
  );
  const places = useLiveQuery<TripPlaceRow>(
    TRIP_PLACES_SQL,
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

  if (trip === 'loading' || screenshots === null || places === null) return null;

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

  const showTabs = places.length > 0;
  const activeTab = showTabs ? tab : 'photos';

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
          {showTabs ? (
            <TabToggle tab={activeTab} onChange={setTab} placesCount={places.length} />
          ) : null}
          {activeTab === 'photos' ? (
            <PlaceGrid data={screenshots} />
          ) : (
            <View className="bg-white">
              {places.map((p) => (
                <PlaceRow key={p.id} place={p} />
              ))}
            </View>
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
}: {
  tab: 'photos' | 'places';
  onChange: (next: 'photos' | 'places') => void;
  placesCount: number;
}) {
  return (
    <View className="flex-row gap-1 px-4 py-3">
      <TabButton label="Photos" active={tab === 'photos'} onPress={() => onChange('photos')} />
      <TabButton
        label={`Places · ${placesCount}`}
        active={tab === 'places'}
        onPress={() => onChange('places')}
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
