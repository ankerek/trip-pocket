import { Alert } from 'react-native';
import { Image, Pressable, View } from '@/tw';
import { Link, useRouter, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { deleteSource } from '@/modules/storage';
import { useDatabase } from './useDatabase';
import { thumbnailBadge } from './thumbnailBadge';
import { PinBadge } from './PinBadge';
import { NoPlacesBadge } from './NoPlacesBadge';
import { PausedBadge } from './PausedBadge';
import { openLapsePaywall } from '@/lib/paywall/openLapsePaywall';

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
  extraction_paused_reason?: string | null;
  url_fetch_paused_reason?: string | null;
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
  const pathname = usePathname();

  const confirmDelete = (id: string) => {
    Alert.alert(
      'Delete this source?',
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
            await deleteSource(db, id);
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
          extraction_paused_reason: item.extraction_paused_reason ?? null,
          url_fetch_paused_reason: item.url_fetch_paused_reason ?? null,
          place_count: item.place_count ?? 0,
        });
        // Paused tiles route taps to the lapse paywall instead of source
        // detail — the source's content is half-built and the lapse paywall
        // is the unblock action. Use Pressable directly (not Link) so the
        // long-press menu still works via a sibling Link, but tap goes to
        // paywall.
        if (badge === 'paused') {
          return (
            <Pressable
              key={item.id}
              onPress={() => openLapsePaywall(router, pathname)}
              className="w-1/2 p-1"
              accessibilityRole="button"
              accessibilityLabel="Paused — subscription required"
            >
              <View className="bg-surface relative aspect-[3/4] w-full overflow-hidden rounded-lg">
                <Image
                  source={item.file_path}
                  className="h-full w-full"
                  contentFit="cover"
                  style={{ opacity: 0.6 }}
                  onError={(error) =>
                    console.warn('[PlaceGrid] image load failed', item.id, item.file_path, error)
                  }
                />
                <PausedBadge />
              </View>
            </Pressable>
          );
        }
        return (
          <Link key={item.id} href={`/sources/${item.id}`} asChild>
            <Link.Trigger>
              <Pressable
                className="w-1/2 p-1"
                accessibilityRole="button"
                accessibilityLabel="Source"
              >
                <View className="bg-surface relative aspect-[3/4] w-full overflow-hidden rounded-lg">
                  <Image
                    source={item.file_path}
                    className="h-full w-full"
                    contentFit="cover"
                    onError={(error) =>
                      console.warn('[PlaceGrid] image load failed', item.id, item.file_path, error)
                    }
                  />
                  {badge === 'shimmer' ? (
                    // The background color goes through `style`, not className.
                    // Tailwind v4's default palette compiles to `oklch()`, which
                    // react-native-css can't interpolate during animate-pulse —
                    // it produced "#NaNNaNNaN1a" (NaN RGB, valid alpha 1a/10%)
                    // and Reanimated bailed. Inline rgba sidesteps the whole
                    // color pipeline; only opacity animates.
                    <View
                      pointerEvents="none"
                      style={{ backgroundColor: 'rgba(0, 0, 0, 0.1)' }}
                      className="absolute inset-0 animate-pulse"
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
                onPress={() => router.push(`/sources/${item.id}/ocr-debug`)}
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
