import { Alert } from 'react-native';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { PlaceTile, type PlaceTileData } from '@/components/PlaceTile';
import { SearchButton } from '@/components/SearchButton';
import { Icon } from '@/components/Icon';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import {
  createImportFs,
  getOrCreateOwnerId,
  getStorageDirectory,
  importImage,
} from '@/modules/capture';
import { useDatabase } from '@/components/useDatabase';

// Global places feed: every live place, regardless of trip. Tiles render
// photo + name overlay (PlaceTile). Untriaged places live alongside trip
// places — the trip-detail screen filters by trip_id. The LEFT JOIN brings
// in the trip name so the tile can show a top-left trip chip; soft-deleted
// trips collapse to NULL (chip hidden), which is the right outcome.
const PLACES_SQL = `SELECT p.id, p.name, p.city, p.category, p.photo_name,
                           p.rating, p.price_level,
                           p.external_place_id, p.enrichment_status,
                           p.latitude, p.longitude, p.formatted_address,
                           t.name AS trip_name
                      FROM places p
                 LEFT JOIN trips t ON t.id = p.trip_id AND t.deleted_at IS NULL
                     WHERE p.deleted_at IS NULL
                  ORDER BY p.enriched_at DESC NULLS LAST, p.created_at DESC`;

// Inbox: sources with no trip and not yet attached to any place. These are
// the "no-place yet" tiles — manual sources the user chose, plus
// in-flight pipeline rows. Slice 1 keeps them in a separate Inbox section
// to match the share-flow expectation; slice 2 blends them into the main
// feed with a "no-place" visual treatment.
const INBOX_SQL = `SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
                          COALESCE(p.place_count, 0) AS place_count
                     FROM sources s
                LEFT JOIN (
                       SELECT ps.source_id, COUNT(*) AS place_count
                         FROM place_sources ps
                        WHERE ps.deleted_at IS NULL
                     GROUP BY ps.source_id
                     ) p ON p.source_id = s.id
                    WHERE s.deleted_at IS NULL AND s.trip_id IS NULL
                 ORDER BY s.captured_at DESC`;

export default function Places() {
  // Subscribed to 'trips' too: rename a trip and the chips refresh in place.
  const places = useLiveQuery<PlaceTileData>(PLACES_SQL, [], ['places', 'trips']);
  const inbox = useLiveQuery<GridItem>(INBOX_SQL, [], ['sources', 'place_sources']);

  const headerRight = () => (
    <View className="flex-row items-center">
      <SearchButton />
      <HeaderPlusButton />
    </View>
  );

  if (places === null || inbox === null) return null;

  if (places.length === 0 && inbox.length === 0) {
    return (
      <>
        <Stack.Screen options={{ headerRight }} />
        <View className="flex-1 items-center justify-center bg-white">
          <Text className="px-8 text-center text-base text-slate-500">
            No places yet — share a screenshot from Photos.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerRight }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="bg-white"
      >
        {inbox.length > 0 ? (
          <View>
            <Text className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Inbox · {inbox.length}
            </Text>
            <PlaceGrid data={inbox} />
          </View>
        ) : null}
        {places.length > 0 ? (
          <View>
            <Text className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Places · {places.length}
            </Text>
            <View className="flex-row flex-wrap p-2">
              {places.map((p) => (
                <View key={p.id} className="w-1/2 p-1">
                  <PlaceTile place={p} />
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

function HeaderPlusButton() {
  const db = useDatabase();
  const onPress = async () => {
    if (!db) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 20,
    });
    if (result.canceled) return;

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const storage = getStorageDirectory().uri;
    const ownerId = getOrCreateOwnerId();
    const now = new Date().toISOString();
    const fs = createImportFs();

    const queue = [...result.assets];
    const next = async () => {
      while (queue.length > 0) {
        const asset = queue.shift();
        if (!asset) return;
        try {
          const r = await importImage(db, {
            sourceUri: asset.uri,
            origin: 'manual',
            ownerId,
            capturedAt: now,
            transfer: 'copy',
            storageDir: storage,
            fs,
          });
          if (r.status === 'imported') imported += 1;
          else skipped += 1;
        } catch (err) {
          console.warn('[camera-roll] import failed', err);
          failed += 1;
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < 4; i += 1) workers.push(next());
    await Promise.all(workers);

    if (process.env.EXPO_OS === 'ios') {
      const haptic =
        failed > 0 && imported === 0
          ? Haptics.NotificationFeedbackType.Error
          : imported > 0
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning;
      Haptics.notificationAsync(haptic).catch(() => {});
    }

    const messageParts: string[] = [];
    if (imported > 0) messageParts.push(`Imported ${imported}`);
    if (skipped > 0) messageParts.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
    if (failed > 0) messageParts.push(`${failed} failed`);
    const message = messageParts.join(' · ');
    Alert.alert(message || 'Nothing to import');
  };

  return (
    <Pressable
      onPress={onPress}
      className="px-3"
      accessibilityRole="button"
      accessibilityLabel="Add screenshots from camera roll"
    >
      <Icon name="plus" size={22} tintColor="#0f172a" />
    </Pressable>
  );
}
