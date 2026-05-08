import { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from '@/tw';
import { Stack, useRouter } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { buildFtsMatch } from '@/modules/search';
import { SearchSnippet } from '@/components/SearchSnippet';

type ResultRow = {
  id: string;
  file_path: string;
  trip_id: string | null;
  trip_name: string | null;
  snippet: string;
};

type TripChipRow = { id: string; name: string };

const SEARCH_SQL = `
  SELECT s.id          AS id,
         s.file_path   AS file_path,
         s.trip_id     AS trip_id,
         t.name        AS trip_name,
         snippet(sources_fts, 1, char(2), char(3), '...', 16) AS snippet
    FROM sources_fts
    JOIN sources s ON s.id = sources_fts.source_id
    LEFT JOIN trips t ON t.id = s.trip_id AND t.deleted_at IS NULL
   WHERE sources_fts MATCH ?
     AND s.deleted_at IS NULL
     AND (? IS NULL OR s.trip_id = ?)
ORDER BY rank
   LIMIT 50
`;

const TRIPS_SQL = `SELECT id, name FROM trips WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC`;

// Sentinel match expression for when the user's input is below the trigram
// minimum. The hook still runs (Rules of Hooks) but with a phrase guaranteed
// not to appear in real OCR text. The phrase must produce real trigrams —
// expo-sqlite's FTS5 rejects whitespace-only or empty phrases (the parser
// surfaces this as "unterminated string"), and a literal NUL byte triggers
// the same error because FTS5 treats it as end-of-string.
const NEVER_MATCH = "\"___trippocket_no_match_sentinel___\"";

export default function Search() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tripFilter, setTripFilter] = useState<string | null>(null);

  // 200ms debounce on the input before issuing the FTS query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input), 200);
    return () => clearTimeout(t);
  }, [input]);

  const match = useMemo(() => buildFtsMatch(debounced), [debounced]);
  const params = useMemo(
    () => [match ?? NEVER_MATCH, tripFilter, tripFilter] as (string | null)[],
    [match, tripFilter],
  );

  const trips = useLiveQuery<TripChipRow>(TRIPS_SQL, [], ['trips']);
  const rows = useLiveQuery<ResultRow>(SEARCH_SQL, params, ['sources', 'trips']);

  const trimmed = input.trim();
  const tooShort = match === null && trimmed.length > 0;

  return (
    <View className="flex-1 bg-white">
      <Stack.Screen
        options={{
          title: '',
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Cancel search"
            >
              <Text className="text-base text-slate-900">Cancel</Text>
            </Pressable>
          ),
          headerTitle: () => (
            <View className="w-full flex-row items-center">
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Search screenshots"
                autoFocus
                returnKeyType="search"
                clearButtonMode="while-editing"
                className="flex-1 rounded-md bg-slate-100 px-3 py-2 text-base text-slate-900"
                accessibilityLabel="Search input"
              />
            </View>
          ),
        }}
      />

      {trips && trips.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 py-2"
        >
          <Chip
            label="All trips"
            selected={tripFilter === null}
            onPress={() => setTripFilter(null)}
          />
          {trips.map((t) => (
            <Chip
              key={t.id}
              label={t.name}
              selected={tripFilter === t.id}
              onPress={() => setTripFilter(t.id)}
            />
          ))}
        </ScrollView>
      ) : null}

      {trimmed.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-slate-500">
            Search your screenshots
          </Text>
        </View>
      ) : tooShort ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-slate-500">
            Type at least 3 characters
          </Text>
        </View>
      ) : rows === null ? null : rows.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-slate-500">
            No matches for &ldquo;{trimmed}&rdquo;
          </Text>
        </View>
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerClassName="px-4 py-2"
          ItemSeparatorComponent={() => <View className="h-px bg-slate-100" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/sources/${item.id}`)}
              className="flex-row items-center gap-3 py-2"
              accessibilityRole="button"
              accessibilityLabel={`Open source${item.trip_name ? ` in ${item.trip_name}` : ''}`}
            >
              <Image
                source={item.file_path}
                className="h-16 w-16 rounded-md bg-slate-100"
                contentFit="cover"
              />
              <View className="flex-1">
                <View className="mb-1 self-start rounded-full bg-slate-100 px-2 py-0.5">
                  <Text className="text-xs font-medium text-slate-700">
                    {item.trip_name ?? 'Inbox'}
                  </Text>
                </View>
                <SearchSnippet
                  raw={item.snippet}
                  className="text-sm leading-5 text-slate-600"
                />
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function Chip({
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
          ? 'rounded-full bg-slate-900 px-3 py-1.5'
          : 'rounded-full bg-slate-100 px-3 py-1.5'
      }
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Filter: ${label}`}
    >
      <Text
        className={selected ? 'text-sm font-medium text-white' : 'text-sm text-slate-700'}
      >
        {label}
      </Text>
    </Pressable>
  );
}
