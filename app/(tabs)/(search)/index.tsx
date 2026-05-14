import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
} from '@/tw';
import { PixelRatio, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import type { SearchBarCommands } from 'react-native-screens';
import { useLiveQuery } from '@/modules/storage';
import { buildFtsMatch } from '@/modules/search';
import { PlaceTile, type PlaceTileData } from '@/components/PlaceTile';

const SEARCH_SQL = `
  SELECT p.id                  AS id,
         p.name                AS name,
         p.city                AS city,
         p.country_code        AS country_code,
         p.category            AS category,
         p.photo_name          AS photo_name,
         p.rating              AS rating,
         p.price_level         AS price_level,
         p.external_place_id   AS external_place_id,
         p.enrichment_status   AS enrichment_status,
         p.latitude            AS latitude,
         p.longitude           AS longitude,
         p.formatted_address   AS formatted_address,
         p.trip_id             AS trip_id,
         t.name                AS trip_name
    FROM places_fts
    JOIN places p ON p.id = places_fts.place_id
    LEFT JOIN trips t ON t.id = p.trip_id
   WHERE places_fts MATCH ?
     AND (? IS NULL OR p.trip_id = ?)
ORDER BY rank
   LIMIT 50
`;

const TRIPS_SQL = `SELECT id, name FROM trips ORDER BY name COLLATE NOCASE ASC`;

type TripChipRow = { id: string; name: string };

type SearchPlaceRow = PlaceTileData & { trip_id: string | null };

// Sentinel match expression for when the user's input is below the trigram
// minimum. The hook still runs (Rules of Hooks) but with a phrase guaranteed
// not to appear in real FTS content.
const NEVER_MATCH = '"___trippocket_no_match_sentinel___"';

export default function Search() {
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tripFilter, setTripFilter] = useState<string | null>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(input), 200);
    return () => clearTimeout(t);
  }, [input]);

  // headerSearchBarOptions.autoFocus is Android-only — iOS needs an
  // imperative focus call. useFocusEffect fires every time the search tab
  // gains focus (initial mount + every tab re-entry), and the small delay
  // lets iOS finish wiring the search bar into the nav header before we
  // ask it to become first responder.
  useFocusEffect(
    useCallback(() => {
      const t = setTimeout(() => searchBarRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }, []),
  );

  const match = useMemo(() => buildFtsMatch(debounced), [debounced]);
  const queryParams = useMemo(
    () => [match ?? NEVER_MATCH, tripFilter, tripFilter] as (string | null)[],
    [match, tripFilter],
  );

  const trips = useLiveQuery<TripChipRow>(TRIPS_SQL, [], ['trips']);
  const rows = useLiveQuery<SearchPlaceRow>(
    SEARCH_SQL,
    queryParams,
    ['places', 'trips', 'place_sources'],
  );

  const trimmed = input.trim();
  const tooShort = match === null && trimmed.length > 0;

  // Mirror Pocket's Dynamic Type reflow: 1 column at body XL+, 2 columns
  // otherwise. Keeps the grid visually identical across screens.
  const { width } = useWindowDimensions();
  const fontScale = PixelRatio.getFontScale();
  const numColumns = fontScale >= 1.35 ? 1 : 2;

  const cellStyle = useMemo(
    () => ({
      flex: 1 / numColumns,
      maxWidth: numColumns === 1 ? width - 28 : undefined,
      paddingHorizontal: numColumns === 1 ? 14 : 0,
    }),
    [numColumns, width],
  );

  const renderItem = useCallback(
    ({ item }: { item: SearchPlaceRow }) => (
      <GridCell place={item} style={cellStyle} />
    ),
    [cellStyle],
  );

  const showResults = trimmed.length > 0 && !tooShort && rows !== null && rows.length > 0;

  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen
        options={{
          title: 'Search',
          headerLargeTitle: true,
          headerSearchBarOptions: {
            ref: searchBarRef,
            placeholder: 'Search places',
            onChangeText: (e) => setInput(e.nativeEvent.text),
            hideWhenScrolling: false,
            autoFocus: true, // Android only; iOS focus is driven by the ref above.
          },
        }}
      />

      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        className="bg-bg"
        data={showResults ? rows! : []}
        keyExtractor={keyExtractor}
        numColumns={numColumns}
        // FlatList disallows toggling numColumns without a key change.
        key={`grid-${numColumns}`}
        // Source tiles stay mounted during shared-element transitions
        // (matches Pocket's grid).
        removeClippedSubviews={false}
        windowSize={5}
        contentContainerClassName="pb-24"
        columnWrapperStyle={
          numColumns > 1 ? { paddingHorizontal: 11, gap: 6 } : undefined
        }
        ItemSeparatorComponent={GridGap}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View>
            {trips && trips.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2 px-4 py-2"
              >
                <FilterChip
                  label="All trips"
                  selected={tripFilter === null}
                  onPress={() => setTripFilter(null)}
                />
                {trips.map((t) => (
                  <FilterChip
                    key={t.id}
                    label={t.name}
                    selected={tripFilter === t.id}
                    onPress={() => setTripFilter(t.id)}
                  />
                ))}
              </ScrollView>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          trimmed.length === 0 ? (
            <View className="px-8 pt-12">
              <Text className="text-center text-base text-text-muted">
                Search your places
              </Text>
            </View>
          ) : tooShort ? (
            <View className="px-8 pt-12">
              <Text className="text-center text-base text-text-muted">
                Type at least 3 characters
              </Text>
            </View>
          ) : rows === null ? null : (
            <View className="px-8 pt-12">
              <Text className="text-center text-base text-text-muted">
                No places match &ldquo;{trimmed}&rdquo;
              </Text>
            </View>
          )
        }
        renderItem={renderItem}
      />
    </View>
  );
}

function keyExtractor(item: SearchPlaceRow): string {
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
  place: SearchPlaceRow;
  style: GridCellStyle;
}) {
  return (
    <View style={style}>
      <PlaceTile place={place} />
    </View>
  );
});

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={
        selected
          ? 'rounded-pill bg-accent px-3 py-1.5'
          : 'rounded-pill bg-surface px-3 py-1.5'
      }
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Filter: ${label}`}
    >
      <Text
        className={
          selected
            ? 'text-sm font-medium text-bg'
            : 'text-sm text-text-muted'
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
