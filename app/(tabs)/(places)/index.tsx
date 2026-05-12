import { memo, useCallback, useMemo, useState } from 'react';
import {
  PixelRatio,
  RefreshControl,
  useWindowDimensions,
} from 'react-native';
import { FlatList, Text, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import { useLiveQuery, PROCESSING_SOURCES_WHERE } from '@/modules/storage';
import { PlaceTile, type PlaceTileData } from '@/components/PlaceTile';
import { HeaderCaptureButton } from '@/components/HeaderCaptureButton';
import { InboxBanner } from '@/components/InboxBanner';
import { ProcessingBanner } from '@/components/ProcessingBanner';
import { FilterPills, type FilterOption } from '@/components/FilterPills';
import { EmptyState } from '@/components/EmptyState';
import { pickPhotosForImport } from '@/components/pickPhotos';
import { useDatabase } from '@/components/useDatabase';
import { runForegroundIngest } from '@/modules/capture';
import { useThemeColors } from '@/tw/theme';

// Global places feed: every live place, regardless of trip. Tiles render
// photo + name overlay (PlaceTile). Untriaged sources surface as the
// Inbox banner — the count comes from a separate query so the header
// stays stable while places stream in.
const PLACES_SQL = `SELECT p.id, p.name, p.city, p.category, p.photo_name,
                           p.rating, p.price_level,
                           p.external_place_id, p.enrichment_status,
                           p.latitude, p.longitude, p.formatted_address,
                           t.name AS trip_name, p.trip_id
                      FROM places p
                 LEFT JOIN trips t ON t.id = p.trip_id
                  ORDER BY p.enriched_at DESC NULLS LAST, p.created_at DESC`;

// "Untriaged" means the user hasn't decided which trip the source
// belongs to yet — it's independent of whether AI extraction has
// produced a place. We keep the screenshot in the Inbox until the user
// explicitly assigns a trip (or until they explicitly skip and we
// surface a "you have N skipped items" follow-up — future work).
const INBOX_COUNT_SQL = `SELECT COUNT(*) AS n
                           FROM sources s
                          WHERE s.trip_id IS NULL`;

// Source-level in-flight count for the ProcessingBanner. Enrichment is
// surfaced per-tile (PlaceTile shimmer), not aggregated here.
const PROCESSING_COUNT_SQL = `SELECT COUNT(*) AS n
                                FROM sources
                               WHERE ${PROCESSING_SOURCES_WHERE}`;

const TRIPS_SQL = `SELECT t.id, t.name,
                          COUNT(p.id) AS place_count
                     FROM trips t
                LEFT JOIN places p ON p.trip_id = t.id
                 GROUP BY t.id
                 ORDER BY t.created_at DESC`;

type PlaceRow = PlaceTileData & { trip_id: string | null };
type InboxCount = { n: number };
type TripRow = { id: string; name: string; place_count: number };

const ALL_FILTER_ID = '__all__';
const UNTRIAGED_FILTER_ID = '__untriaged__';

export default function Pocket() {
  const db = useDatabase();
  const router = useRouter();
  const colors = useThemeColors();
  const places = useLiveQuery<PlaceRow>(PLACES_SQL, [], ['places', 'trips']);
  const inboxCountRows = useLiveQuery<InboxCount>(
    INBOX_COUNT_SQL,
    [],
    ['sources'],
  );
  const processingRows = useLiveQuery<InboxCount>(
    PROCESSING_COUNT_SQL,
    [],
    ['sources'],
  );
  const tripRows = useLiveQuery<TripRow>(TRIPS_SQL, [], ['trips', 'places']);

  const [filter, setFilter] = useState<string>(ALL_FILTER_ID);
  const [refreshing, setRefreshing] = useState(false);

  // Dynamic Type reflow — at body XL+ collapse to 1 column with 4:5 tiles
  // (spec §9.5).
  const { width } = useWindowDimensions();
  const fontScale = PixelRatio.getFontScale();
  const numColumns = fontScale >= 1.35 ? 1 : 2;

  const inboxCount = inboxCountRows?.[0]?.n ?? 0;
  const processingCount = processingRows?.[0]?.n ?? 0;

  const filterOptions = useMemo<FilterOption[]>(() => {
    const opts: FilterOption[] = [{ id: ALL_FILTER_ID, label: 'All' }];
    if (inboxCount > 0) {
      opts.push({ id: UNTRIAGED_FILTER_ID, label: 'Untriaged', count: inboxCount });
    }
    for (const t of tripRows ?? []) {
      opts.push({ id: t.id, label: t.name, count: t.place_count });
    }
    return opts;
  }, [tripRows, inboxCount]);

  const filteredPlaces = useMemo(() => {
    if (!places) return null;
    if (filter === ALL_FILTER_ID) return places;
    if (filter === UNTRIAGED_FILTER_ID) {
      return places.filter((p) => !p.trip_id);
    }
    return places.filter((p) => p.trip_id === filter);
  }, [places, filter]);

  const headerRight = () => <HeaderCaptureButton />;

  const cellStyle = useMemo(
    () => ({
      flex: 1 / numColumns,
      maxWidth: numColumns === 1 ? width - 28 : undefined,
      paddingHorizontal: numColumns === 1 ? 14 : 0,
    }),
    [numColumns, width],
  );

  const renderItem = useCallback(
    ({ item }: { item: PlaceRow }) => (
      <GridCell place={item} style={cellStyle} />
    ),
    [cellStyle],
  );

  const onRefresh = async () => {
    if (!db) return;
    setRefreshing(true);
    try {
      await runForegroundIngest(db);
    } finally {
      setRefreshing(false);
    }
  };

  if (filteredPlaces === null || inboxCountRows === null || processingRows === null) {
    return null;
  }

  if (
    filteredPlaces.length === 0 &&
    inboxCount === 0 &&
    processingCount === 0 &&
    filter === ALL_FILTER_ID
  ) {
    return (
      <>
        <Stack.Screen options={{ headerRight }} />
        <EmptyState
          icon="square.and.arrow.down"
          title="No places yet"
          body="Share an image or an Instagram / TikTok link to Trip Pocket — or pull some in from your Photos library."
          cta={{
            label: 'Add from Photos',
            onPress: () => {
              if (db) void pickPhotosForImport(db);
            },
            accessibilityHint: 'Opens Photos to import images into the inbox',
          }}
        />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerRight }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        className="bg-bg"
        data={filteredPlaces}
        keyExtractor={keyExtractor}
        numColumns={numColumns}
        // Force a re-mount when columns change; FlatList disallows toggling
        // numColumns without a key change.
        key={`grid-${numColumns}`}
        // Spec §13: removeClippedSubviews OFF on the grid so source tiles
        // remain mounted during shared-element transitions (phase 4).
        removeClippedSubviews={false}
        windowSize={5}
        contentContainerClassName="pb-24"
        columnWrapperStyle={
          numColumns > 1 ? { paddingHorizontal: 11, gap: 6 } : undefined
        }
        ItemSeparatorComponent={GridGap}
        ListHeaderComponent={
          <View>
            <ProcessingBanner count={processingCount} />
            <FilterPills options={filterOptions} selectedId={filter} onSelect={setFilter} />
            {/* InboxBanner only on the Untriaged filter — keeps the All
                feed visually quiet for users who already have a queue
                they're ignoring. */}
            {filter === UNTRIAGED_FILTER_ID ? (
              <InboxBanner
                count={inboxCount}
                onPress={() => router.push('/triage' as never)}
              />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View className="px-8 pt-12">
            <Text className="text-center text-base text-text-muted">
              {filter === UNTRIAGED_FILTER_ID
                ? 'Nothing to triage.'
                : 'No places yet for this filter.'}
            </Text>
          </View>
        }
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      />
    </>
  );
}

function keyExtractor(item: PlaceRow): string {
  return item.id;
}

function GridGap() {
  return <View style={{ height: 6 }} />;
}

type GridCellStyle = {
  flex: number;
  maxWidth: number | undefined;
  paddingHorizontal: number;
};

const GridCell = memo(function GridCell({
  place,
  style,
}: {
  place: PlaceRow;
  style: GridCellStyle;
}) {
  return (
    <View style={style}>
      <PlaceTile place={place} />
    </View>
  );
});
