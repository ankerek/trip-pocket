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

// Distinct places across the trip's screenshots. Venue-aware GROUP BY:
//   COALESCE(external_place_id, OCR-key)
// Resolved rows (post-enrichment) collapse by their Google Places venue.
// Unresolved rows fall back to the OCR-key (name | city | address) used
// pre-enrichment. The two coexist while a trip is being enriched.
//
// LEFT JOIN against place_enrichments brings in the venue-level data
// (photo, blurb, rating, lat/lng, etc.) — NULL for unresolved rows.
// MAX() on per-row fields picks an arbitrary representative within the
// group; on enrichment fields it's a no-op (PK join → constant within group).
const TRIP_PLACES_SQL = `SELECT
                           MIN(ep.id) AS id,
                           MAX(ep.name) AS name,
                           MAX(ep.city) AS city,
                           MAX(ep.address) AS address,
                           MAX(ep.category) AS category,
                           MAX(ep.external_place_id) AS external_place_id,
                           MAX(ep.enrichment_status) AS enrichment_status,
                           MAX(pe.formatted_address) AS formatted_address,
                           MAX(pe.latitude) AS latitude,
                           MAX(pe.longitude) AS longitude,
                           MAX(pe.photo_name) AS photo_name,
                           MAX(pe.description) AS description,
                           MAX(pe.rating) AS rating,
                           MAX(pe.price_level) AS price_level,
                           MAX(pe.external_url) AS external_url,
                           COUNT(DISTINCT ep.screenshot_id) AS source_count,
                           MAX(ep.created_at) AS last_seen
                         FROM extracted_places ep
                         JOIN screenshots s ON s.id = ep.screenshot_id
                    LEFT JOIN place_enrichments pe
                              ON pe.external_place_id = ep.external_place_id
                         WHERE s.trip_id = ?
                           AND s.deleted_at IS NULL
                           AND ep.deleted_at IS NULL
                         GROUP BY COALESCE(
                                    ep.external_place_id,
                                    LOWER(ep.name) || '|' ||
                                    LOWER(TRIM(ep.city)) || '|' ||
                                    LOWER(TRIM(COALESCE(ep.address, '')))
                                  )
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
