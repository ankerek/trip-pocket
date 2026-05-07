import { Alert } from 'react-native';
import { Image, Pressable, View } from '@/tw';
import { Link, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { softDeleteScreenshot } from '@/modules/storage';
import { useDatabase } from './useDatabase';
import { thumbnailBadge } from './thumbnailBadge';
import { PinBadge } from './PinBadge';
import { NoPlacesBadge } from './NoPlacesBadge';

export type GridItem = {
  id: string;
  file_path: string;
  /**
   * Drives the merged background-pipeline shimmer (OCR + extraction) and
   * the pin / no-places badge. See `thumbnailBadge` for the decision rules.
   * Optional so legacy callers that haven't widened their query yet still
   * compile; defaults treat the row as fully-processed with 0 places (no
   * shimmer, no badges) which is wrong for actual pending rows but the
   * right "do nothing" stance until the call site is widened.
   */
  ocr_status?: 'pending' | 'done' | 'failed';
  extraction_status?: 'pending' | 'done' | 'failed';
  place_count?: number;
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
      {data.map((item) => {
        const badge = thumbnailBadge({
          ocr_status: item.ocr_status ?? 'done',
          extraction_status: item.extraction_status ?? 'done',
          place_count: item.place_count ?? 0,
        });
        return (
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
                {badge === 'shimmer' ? (
                  <View
                    pointerEvents="none"
                    className="absolute inset-0 animate-pulse bg-black/10"
                  />
                ) : null}
                {badge === 'pin' ? <PinBadge /> : null}
                {badge === 'no-places' ? <NoPlacesBadge /> : null}
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
        );
      })}
    </View>
  );
}
