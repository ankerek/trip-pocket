import { useEffect, useState } from 'react';
import { Alert, ToastAndroid } from 'react-native';
import { Image, Text, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  getScreenshot,
  softDeleteScreenshot,
  assignTrip,
  useLiveQuery,
  type Screenshot,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { TripPicker, type TripPickerMode } from '@/components/TripPicker';

const HEADER_OPTIONS = {
  title: '',
  headerStyle: { backgroundColor: '#000' },
  headerTintColor: '#fff',
} as const;

export default function PlaceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<TripPickerMode>('assign');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'loaded'; screenshot: Screenshot | null }
  >({ kind: 'loading' });

  // Refresh when OCR or extraction completes in the background.
  const tick = useLiveQuery<{ v: number }>(
    `SELECT 0 AS v`,
    [],
    ['screenshots', 'extracted_places'],
  );

  // Live place count drives the toolbar icon (mappin.circle.fill vs
  // mappin.slash) so the button flips state the moment extraction commits.
  const placeCounts = useLiveQuery<{ n: number }>(
    `SELECT COUNT(*) AS n FROM extracted_places
      WHERE screenshot_id = ? AND deleted_at IS NULL`,
    id ? [id] : [],
    ['extracted_places'],
  );
  const placeCount = placeCounts?.[0]?.n ?? 0;

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getScreenshot(db, id).then((s) => {
      if (!cancelled) setState({ kind: 'loaded', screenshot: s });
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

  if (state.screenshot === null) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={HEADER_OPTIONS} />
        <Text className="text-base text-slate-300">Place not found.</Text>
      </View>
    );
  }

  const screenshot = state.screenshot;
  const inTrip = screenshot.tripId !== null;

  const onAssignTrip = (mode: TripPickerMode) => {
    setPickerMode(mode);
    setPickerVisible(true);
  };

  const onRemoveFromTrip = async () => {
    if (!db) return;
    try {
      await assignTrip(db, screenshot.id, null);
      setState({ kind: 'loaded', screenshot: { ...screenshot, tripId: null } });
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      toast('Returned to Inbox');
    } catch (err) {
      console.error('[place-detail] assignTrip failed', err);
      Alert.alert('Could not remove from trip', 'Please try again.');
    }
  };

  const confirmDelete = () => {
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
            await softDeleteScreenshot(db, screenshot.id);
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
      <View className="flex-1 items-center justify-center bg-black">
        <Image
          source={screenshot.filePath}
          className="h-full w-full"
          contentFit="contain"
          accessibilityLabel="Screenshot"
        />
      </View>
      {process.env.EXPO_OS === 'ios' ? (
        <Stack.Toolbar placement="right">
          {/*
            Places button. Hidden while extraction is pending or failed
            (no information to show yet). When extraction is done, the
            icon flips: filled-pin when we found places (positive), slash
            when we processed and found nothing (so the user can pop the
            sheet, confirm "no places detected", and delete confidently).
          */}
          {screenshot.extractionStatus === 'done' ? (
            <Stack.Toolbar.Button
              icon={placeCount > 0 ? 'mappin.circle.fill' : 'mappin.slash'}
              tintColor={placeCount > 0 ? '#60a5fa' : '#94a3b8'}
              onPress={() => router.push(`/places/${screenshot.id}/places-found`)}
            />
          ) : null}
          <Stack.Toolbar.Button
            icon="info.circle"
            tintColor="#fff"
            onPress={() => router.push(`/places/${screenshot.id}/ocr-debug`)}
          />
          <Stack.Toolbar.Menu icon="ellipsis" tintColor="#fff">
            <Stack.Toolbar.MenuAction
              icon="folder"
              onPress={() => onAssignTrip(inTrip ? 'move' : 'assign')}
            >
              {inTrip ? 'Move to trip' : 'Add to trip'}
            </Stack.Toolbar.MenuAction>
            {inTrip ? (
              <Stack.Toolbar.MenuAction
                icon="folder.badge.minus"
                onPress={onRemoveFromTrip}
              >
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
        screenshotId={screenshot.id}
        mode={pickerMode}
        onClose={async (result) => {
          setPickerVisible(false);
          if (!result) return;
          if (db) {
            const fresh = await getScreenshot(db, screenshot.id);
            if (fresh) setState({ kind: 'loaded', screenshot: fresh });
          }
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          }
          toast(pickerMode === 'assign' ? `Added to ${result.tripName}` : `Moved to ${result.tripName}`);
        }}
      />
    </>
  );
}

function toast(message: string) {
  if (process.env.EXPO_OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    // iOS lacks a native toast; a quick alert is acceptable for v0.1.
    Alert.alert(message);
  }
}
