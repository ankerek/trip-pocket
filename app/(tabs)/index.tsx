import { Pressable, SectionList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { PlaceGrid, type GridItem } from '@/app/_components/PlaceGrid';

type Row = GridItem & { captured_at: string };

const INBOX_SQL = `SELECT id, file_path, captured_at
                     FROM screenshots
                    WHERE deleted_at IS NULL AND trip_id IS NULL
                 ORDER BY captured_at DESC`;

const ALL_SQL = `SELECT id, file_path, captured_at
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
            headerRight: () => <HeaderPlusButton />,
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
          headerRight: () => <HeaderPlusButton />,
        }}
      />
      {/* SectionList provides outer vertical scroll + per-section headers; each
          section's `data: []` is intentional — the grid lives inside renderSectionHeader
          so PlaceGrid (a non-scrolling FlatList) can own its own layout. */}
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
  return (
    <Pressable
      onPress={() => {
        // Camera-roll import is wired in Task 11.
        if (__DEV__) console.log('[places] + tapped — camera roll picker not yet wired');
      }}
      className="px-3"
      accessibilityRole="button"
      accessibilityLabel="Add screenshots from camera roll"
    >
      <Text className="text-2xl font-semibold text-slate-900">＋</Text>
    </Pressable>
  );
}
