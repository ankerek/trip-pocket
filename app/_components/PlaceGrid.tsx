import { FlatList, Image, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';

export type GridItem = {
  id: string;
  file_path: string;
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
        >
          <View>
            <Image
              source={{ uri: item.file_path }}
              className="aspect-[3/4] w-full rounded-lg bg-slate-100"
              resizeMode="cover"
            />
          </View>
        </Pressable>
      )}
    />
  );
}
