import { Alert, Pressable, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { SearchButton } from '@/components/SearchButton';
import * as ImagePicker from 'expo-image-picker';
import {
  createImportFs,
  getOrCreateOwnerId,
  getStorageDirectory,
  importImage,
} from '@/modules/capture';
import { useDatabase } from '@/components/useDatabase';

type Row = GridItem & { captured_at: string };

const INBOX_SQL = `SELECT id, file_path, ocr_status, captured_at
                     FROM screenshots
                    WHERE deleted_at IS NULL AND trip_id IS NULL
                 ORDER BY captured_at DESC`;

const ALL_SQL = `SELECT id, file_path, ocr_status, captured_at
                   FROM screenshots
                  WHERE deleted_at IS NULL
               ORDER BY captured_at DESC`;

export default function Places() {
  const inbox = useLiveQuery<Row>(INBOX_SQL, [], ['screenshots']);
  const all = useLiveQuery<Row>(ALL_SQL, [], ['screenshots']);

  if (inbox === null || all === null) return null;

  if (inbox.length === 0 && all.length === 0) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Tabs.Screen
          options={{
            headerRight: () => (
            <View className="flex-row items-center">
              <SearchButton />
              <HeaderPlusButton />
            </View>
          ),
          }}
        />
        <Text className="px-8 text-center text-base text-slate-500">
          No screenshots yet — share one from Photos.
        </Text>
      </SafeAreaView>
    );
  }

  const sections: Array<{ key: string; title: string; data: Row[] }> = [];
  if (inbox.length > 0) {
    sections.push({ key: 'inbox', title: `Inbox · ${inbox.length}`, data: [] });
  }
  sections.push({ key: 'all', title: 'All', data: [] });

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Tabs.Screen
        options={{
          headerRight: () => (
            <View className="flex-row items-center">
              <SearchButton />
              <HeaderPlusButton />
            </View>
          ),
        }}
      />
      {/* SectionList provides outer vertical scroll + per-section headers; each
          section's `data: []` is intentional — the grid lives inside renderSectionHeader
          so PlaceGrid renders inline as a flex-wrap block under the heading. */}
      <SectionList
        sections={sections}
        keyExtractor={(_, idx) => `slot-${idx}`}
        renderItem={() => null}
        renderSectionHeader={({ section }) => (
          <View className="bg-white">
            <Text className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {section.title}
            </Text>
            <PlaceGrid data={section.key === 'inbox' ? inbox : all} />
          </View>
        )}
      />
    </SafeAreaView>
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

    // Concurrency cap of 4 — protects against pathological 20-image cases on slow devices.
    const queue = [...result.assets];
    const next = async () => {
      while (queue.length > 0) {
        const asset = queue.shift();
        if (!asset) return;
        try {
          const r = await importImage(db, {
            sourceUri: asset.uri,
            source: 'manual',
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
      <Text className="text-2xl font-semibold text-slate-900">＋</Text>
    </Pressable>
  );
}
