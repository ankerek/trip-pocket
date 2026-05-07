import { FlatList, Image, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';

export type GridItem = {
  id: string;
  file_path: string;
  /**
   * If present and equal to 'pending', the thumbnail renders a subtle shimmer
   * overlay while OCR is in flight. 'done' and 'failed' look the same — failed
   * is silent in UI by design (logged elsewhere when telemetry lands).
   */
  ocr_status?: 'pending' | 'done' | 'failed';
};

export function PlaceGrid({ data }: { data: readonly GridItem[] }) {
  const router = useRouter();
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      numColumns={2}
      scrollEnabled={false}
      contentContainerClassName="p-2"
      renderItem={({ item }) => (
        <Pressable
          className="w-1/2 p-1"
          onPress={() => router.push(`/places/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel="Screenshot"
        >
          <View className="relative">
            <Image
              source={{ uri: item.file_path }}
              className="aspect-[3/4] w-full rounded-lg bg-slate-100"
              resizeMode="cover"
            />
            {item.ocr_status === 'pending' ? (
              <View
                pointerEvents="none"
                className="absolute inset-0 animate-pulse rounded-lg bg-black/10"
              />
            ) : null}
          </View>
        </Pressable>
      )}
    />
  );
}
