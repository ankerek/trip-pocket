import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getTrip,
  listScreenshotsByTrip,
  useLiveQuery,
  type Screenshot,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid } from '@/components/PlaceGrid';
import { SearchButton } from '@/components/SearchButton';

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'loaded'; trip: Trip | null; screenshots: Screenshot[] }
  >({ kind: 'loading' });

  const tick = useLiveQuery<{ v: number }>(
    `SELECT 0 AS v`,
    [],
    ['trips', 'screenshots'],
  );

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    (async () => {
      const t = await getTrip(db, id);
      const ss = await listScreenshotsByTrip(db, id);
      if (cancelled) return;
      setState({ kind: 'loaded', trip: t, screenshots: ss });
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  if (state.kind === 'loading') return null;

  if (state.trip === null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Stack.Screen options={{ title: '' }} />
        <Text className="text-base text-slate-500">Trip not found.</Text>
      </SafeAreaView>
    );
  }

  const trip = state.trip;
  const screenshots = state.screenshots;

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Stack.Screen
        options={{
          title: trip.name,
          headerRight: () => (
            <View className="flex-row items-center">
              <SearchButton />
              <Pressable
                onPress={() => router.push(`/trips/${trip.id}/edit`)}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="Edit trip"
              >
                <Text className="text-base text-slate-900">✏️</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {screenshots.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-slate-500">
            No places in this trip yet — add some from Inbox.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1">
          <PlaceGrid
            data={screenshots.map((s) => ({
              id: s.id,
              file_path: s.filePath,
              ocr_status: s.ocrStatus,
            }))}
          />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
