import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getTrip,
  listScreenshotsByTrip,
  useLiveQuery,
  type Screenshot,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/app/_components/useDatabase';
import { PlaceGrid } from '@/app/_components/PlaceGrid';

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[] | null>(null);

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
      setTrip(t);
      setScreenshots(ss);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  if (!trip || screenshots === null) return null;

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Stack.Screen
        options={{
          title: trip.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/trips/${trip.id}/edit`)}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Edit trip"
            >
              <Text className="text-base text-slate-900">✏️</Text>
            </Pressable>
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
        <PlaceGrid
          data={screenshots.map((s) => ({ id: s.id, file_path: s.filePath }))}
        />
      )}
    </SafeAreaView>
  );
}
