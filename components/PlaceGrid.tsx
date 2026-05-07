import { Alert } from 'react-native';
import { Image, Pressable, View } from '@/tw';
import { Link, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { softDeleteScreenshot } from '@/modules/storage';
import { useDatabase } from './useDatabase';

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
  const db = useDatabase();
  const router = useRouter();

  const confirmDelete = (id: string) => {
    Alert.alert(
      'Delete this place?',
      "This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!db) return;
            if (process.env.EXPO_OS === 'ios') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            }
            await softDeleteScreenshot(db, id);
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <View className="flex-row flex-wrap p-2">
      {data.map((item) => (
        <Link key={item.id} href={`/places/${item.id}`} asChild>
          <Link.Trigger>
            <Pressable
              className="w-1/2 p-1"
              accessibilityRole="button"
              accessibilityLabel="Screenshot"
            >
              <View className="relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-slate-100">
                <Image
                  source={item.file_path}
                  className="h-full w-full"
                  contentFit="cover"
                  onError={(error) =>
                    console.warn(
                      '[PlaceGrid] image load failed',
                      item.id,
                      item.file_path,
                      error,
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
          </Link.Trigger>
          <Link.Preview />
          <Link.Menu>
            <Link.MenuAction
              title="Show OCR text"
              icon="info.circle"
              onPress={() => router.push(`/places/${item.id}/ocr-debug`)}
            />
            <Link.MenuAction
              title="Delete"
              icon="trash"
              destructive
              onPress={() => confirmDelete(item.id)}
            />
          </Link.Menu>
        </Link>
      ))}
    </View>
  );
}
