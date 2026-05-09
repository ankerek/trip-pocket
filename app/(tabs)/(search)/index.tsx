import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
} from '@/tw';
import { Stack } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import type { SearchBarCommands } from 'react-native-screens';
import { useLiveQuery } from '@/modules/storage';
import { buildFtsMatch } from '@/modules/search';
import { SearchResultRow, type SearchResultRowData } from '@/components/SearchResultRow';

const SEARCH_SQL = `
  SELECT p.id          AS id,
         p.name        AS name,
         p.city        AS city,
         p.category    AS category,
         p.photo_name  AS photo_name,
         p.trip_id     AS trip_id,
         t.name        AS trip_name
    FROM places_fts
    JOIN places p ON p.id = places_fts.place_id
    LEFT JOIN trips t ON t.id = p.trip_id AND t.deleted_at IS NULL
   WHERE places_fts MATCH ?
     AND p.deleted_at IS NULL
     AND (? IS NULL OR p.trip_id = ?)
ORDER BY rank
   LIMIT 50
`;

const TRIPS_SQL = `SELECT id, name FROM trips WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC`;

type TripChipRow = { id: string; name: string };

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
  const rows = useLiveQuery<SearchResultRowData>(
    SEARCH_SQL,
    queryParams,
    ['places', 'trips', 'place_sources'],
  );

  const trimmed = input.trim();
  const tooShort = match === null && trimmed.length > 0;

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

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        keyboardShouldPersistTaps="handled"
      >
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

        {trimmed.length === 0 ? (
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
        ) : rows === null ? null : rows.length === 0 ? (
          <View className="px-8 pt-12">
            <Text className="text-center text-base text-text-muted">
              No places match &ldquo;{trimmed}&rdquo;
            </Text>
          </View>
        ) : (
          <FlatList
            scrollEnabled={false}
            data={rows}
            keyExtractor={(r) => r.id}
            contentContainerClassName="px-4 py-2"
            ItemSeparatorComponent={() => <View className="h-px bg-hairline" />}
            renderItem={({ item }) => <SearchResultRow place={item} />}
          />
        )}
      </ScrollView>
    </View>
  );
}

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
