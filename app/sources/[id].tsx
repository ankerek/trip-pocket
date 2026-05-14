import { useEffect, useState } from 'react';
import { Alert, ToastAndroid } from 'react-native';
import { Image, Pressable, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  getSource,
  deleteSource,
  assignSourceTrip,
  useLiveQuery,
  type Source,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { TripPicker, type TripPickerMode } from '@/components/TripPicker';
import { Icon } from '@/components/Icon';
import { openSourceUrl } from '@/lib/openInSocial';

const HEADER_OPTIONS = {
  title: '',
  headerStyle: { backgroundColor: '#000' },
  headerTintColor: '#fff',
  headerBackButtonDisplayMode: 'minimal',
} as const;

export default function SourceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<TripPickerMode>('assign');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'loaded'; source: Source | null }
  >({ kind: 'loading' });

  // Refresh when OCR or extraction completes in the background.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['sources', 'place_sources']);

  // Live place count drives the toolbar icon (mappin.circle.fill vs
  // mappin.slash) so the button flips state the moment extraction commits.
  const placeCounts = useLiveQuery<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources WHERE source_id = ?`,
    id ? [id] : [],
    ['place_sources'],
  );
  const placeCount = placeCounts?.[0]?.n ?? 0;

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getSource(db, id).then((s) => {
      if (!cancelled) setState({ kind: 'loaded', source: s });
    });
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  if (state.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={HEADER_OPTIONS} />
      </View>
    );
  }

  if (state.source === null) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={HEADER_OPTIONS} />
        <Text className="text-base text-slate-300">Source not found.</Text>
      </View>
    );
  }

  const source = state.source;
  const inTrip = source.tripId !== null;
  const isUrlSource = source.kind === 'url' && source.url !== null;

  const openInApp = async () => {
    if (!source.url) return;
    try {
      // openSourceUrl hands off to the Instagram / TikTok app when installed
      // (Universal Link via Linking.openURL) and falls back to
      // SFSafariViewController otherwise — keeps users inside Trip Pocket if
      // they don't have the native app.
      await openSourceUrl(source.url, source.platform);
    } catch (err) {
      console.warn('[source-detail] openSourceUrl failed', err);
    }
  };

  const onAssignTrip = (mode: TripPickerMode) => {
    setPickerMode(mode);
    setPickerVisible(true);
  };

  const onRemoveFromTrip = async () => {
    if (!db) return;
    try {
      await assignSourceTrip(db, source.id, null);
      setState({ kind: 'loaded', source: { ...source, tripId: null } });
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      toast('Returned to Inbox');
    } catch (err) {
      console.error('[source-detail] assignSourceTrip failed', err);
      Alert.alert('Could not remove from trip', 'Please try again.');
    }
  };

  const confirmDelete = async () => {
    if (!db) return;
    // Count places that will be orphan-pruned: places whose only junction
    // is to this source.
    const countRow = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM place_sources ps1
        WHERE ps1.source_id = ?
          AND NOT EXISTS (
                SELECT 1 FROM place_sources ps2
                 WHERE ps2.place_id = ps1.place_id
                   AND ps2.source_id != ?
              )`,
      source.id,
      source.id,
    );
    const orphanCount = countRow?.n ?? 0;
    const body =
      orphanCount === 0
        ? "This can't be undone."
        : `${orphanCount} place${orphanCount === 1 ? '' : 's'} extracted from it will also be deleted. This can't be undone.`;
    Alert.alert(
      'Delete this source?',
      body,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (process.env.EXPO_OS === 'ios') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            }
            await deleteSource(db, source.id);
            router.back();
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <>
      <Stack.Screen options={HEADER_OPTIONS} />
      <View className="flex-1 bg-black">
        {source.filePath ? (
          <View className="flex-1">
            <Image
              source={source.filePath}
              className="h-full w-full"
              contentFit="contain"
              accessibilityLabel="Source image"
            />
            {isUrlSource ? (
              <Pressable
                onPress={openInApp}
                accessibilityRole="button"
                accessibilityLabel={`Open in ${prettyPlatform(source.platform)}`}
                className="absolute inset-0 items-center justify-center"
              >
                <View
                  className="flex-row items-center rounded-full"
                  style={{
                    paddingHorizontal: 18,
                    paddingVertical: 11,
                    backgroundColor: 'rgba(0,0,0,0.72)',
                    gap: 8,
                  }}
                >
                  <Icon name="arrow.up.right.square.fill" size={18} tintColor="#ffffff" />
                  <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '600' }}>
                    Open in {prettyPlatform(source.platform)}
                  </Text>
                </View>
              </Pressable>
            ) : null}
            {isUrlSource ? <PlatformBadge platform={source.platform} /> : null}
          </View>
        ) : isUrlSource ? (
          <Pressable
            onPress={openInApp}
            accessibilityRole="button"
            accessibilityLabel={`Open in ${prettyPlatform(source.platform)}`}
            className="flex-1 items-center justify-center px-8"
          >
            <View
              className="mb-4 items-center justify-center rounded-full"
              style={{
                width: 72,
                height: 72,
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}
            >
              <Icon name="link" size={28} tintColor="#ffffff" />
            </View>
            {source.caption ? (
              <Text
                className="text-center text-slate-200"
                style={{ fontSize: 15, lineHeight: 22 }}
                numberOfLines={8}
              >
                {source.caption}
              </Text>
            ) : null}
            <Text className="mt-4 text-center text-slate-400" style={{ fontSize: 13 }}>
              Tap to open in {prettyPlatform(source.platform)}
            </Text>
            <PlatformBadge platform={source.platform} />
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text className="text-base text-slate-300">No preview for this source.</Text>
          </View>
        )}
      </View>
      {process.env.EXPO_OS === 'ios' ? (
        <Stack.Toolbar placement="right">
          {source.extractionStatus === 'done' ? (
            <Stack.Toolbar.Button
              icon={placeCount > 0 ? 'mappin.circle.fill' : 'mappin.slash'}
              tintColor={placeCount > 0 ? '#60a5fa' : '#94a3b8'}
              onPress={() => router.push(`/sources/${source.id}/places-found`)}
            />
          ) : null}
          <Stack.Toolbar.Button
            icon="info.circle"
            tintColor="#fff"
            onPress={() => router.push(`/sources/${source.id}/ocr-debug`)}
          />
          <Stack.Toolbar.Menu icon="ellipsis" tintColor="#fff">
            {isUrlSource ? (
              <Stack.Toolbar.MenuAction icon="arrow.up.right.square" onPress={openInApp}>
                Open in {prettyPlatform(source.platform)}
              </Stack.Toolbar.MenuAction>
            ) : null}
            <Stack.Toolbar.MenuAction
              icon="folder"
              onPress={() => onAssignTrip(inTrip ? 'move' : 'assign')}
            >
              {inTrip ? 'Move to trip' : 'Add to trip'}
            </Stack.Toolbar.MenuAction>
            {inTrip ? (
              <Stack.Toolbar.MenuAction icon="folder.badge.minus" onPress={onRemoveFromTrip}>
                Remove from trip
              </Stack.Toolbar.MenuAction>
            ) : null}
            <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
              Delete
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <TripPicker
        visible={pickerVisible}
        entityId={source.id}
        entityKind="source"
        mode={pickerMode}
        currentTripId={source.tripId}
        onClose={async (result) => {
          setPickerVisible(false);
          if (!result) return;
          if (db) {
            const fresh = await getSource(db, source.id);
            if (fresh) setState({ kind: 'loaded', source: fresh });
          }
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          }
          toast(
            pickerMode === 'assign' ? `Added to ${result.tripName}` : `Moved to ${result.tripName}`,
          );
        }}
      />
    </>
  );
}

function toast(message: string) {
  if (process.env.EXPO_OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert(message);
  }
}

function prettyPlatform(platform: Source['platform']): string {
  if (platform === 'instagram') return 'Instagram';
  if (platform === 'tiktok') return 'TikTok';
  return 'the post';
}

function PlatformBadge({ platform }: { platform: Source['platform'] }) {
  if (!platform) return null;
  return (
    <View className="absolute" style={{ top: 12, right: 12 }} pointerEvents="none">
      <View
        className="flex-row items-center rounded-full"
        style={{
          paddingHorizontal: 10,
          paddingVertical: 4,
          backgroundColor: 'rgba(0,0,0,0.6)',
        }}
      >
        <Text
          style={{
            fontSize: 11,
            fontWeight: '700',
            color: '#ffffff',
            letterSpacing: 0.2,
          }}
        >
          {prettyPlatform(platform)}
        </Text>
      </View>
    </View>
  );
}
