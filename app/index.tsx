import { FlatList, Image, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLiveQuery } from '@/modules/storage';

type Row = {
  id: string;
  file_path: string;
  captured_at: string;
};

export default function Index() {
  const rows = useLiveQuery<Row>(
    `SELECT id, file_path, captured_at
       FROM screenshots
      WHERE deleted_at IS NULL AND trip_id IS NULL
   ORDER BY captured_at DESC`,
    [],
    ['screenshots'],
  );

  if (rows === null) return null;

  if (rows.length === 0) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Text className="px-8 text-center text-base text-slate-500">
          No screenshots yet — share one from Photos.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Text className="px-4 pb-2 pt-4 text-2xl font-semibold text-slate-900">Inbox</Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerClassName="p-2"
        renderItem={({ item }) => (
          <View className="w-1/2 p-1">
            <Image
              source={{ uri: item.file_path }}
              className="aspect-[3/4] w-full rounded-lg bg-slate-100"
              resizeMode="cover"
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}
