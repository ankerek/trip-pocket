import { Image, Pressable, View } from 'react-native';
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

/**
 * Two-column grid of screenshot thumbnails. Plain flex-wrap rather than a
 * FlatList so the grid can render reliably inside SectionList.renderSectionHeader
 * (where a virtualized list collapses to 0 height because it has no scroll
 * viewport to anchor layout to). Outer scrolling lives in the parent.
 */
export function PlaceGrid({ data }: { data: readonly GridItem[] }) {
  const router = useRouter();
  return (
    <View className="flex-row flex-wrap p-2">
      {data.map((item) => (
        <Pressable
          key={item.id}
          className="w-1/2 p-1"
          onPress={() => router.push(`/places/${item.id}`)}
          accessibilityRole="button"
          accessibilityLabel="Screenshot"
        >
          <View className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-100">
            <Image
              source={{ uri: item.file_path }}
              className="h-full w-full"
              resizeMode="cover"
              onError={(e) =>
                console.warn(
                  '[PlaceGrid] image load failed',
                  item.id,
                  item.file_path,
                  e.nativeEvent,
                )
              }
            />
            {item.ocr_status === 'pending' ? (
              <View
                pointerEvents="none"
                className="absolute inset-0 animate-pulse bg-black/10"
              />
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}
