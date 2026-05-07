import { useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Modal,
  Platform,
  ToastAndroid,
} from 'react-native';
import {
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getScreenshot,
  softDeleteScreenshot,
  assignTrip,
  useLiveQuery,
  type Screenshot,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { TripPicker, type TripPickerMode } from '@/components/TripPicker';

export default function PlaceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<TripPickerMode>('assign');
  const [debugVisible, setDebugVisible] = useState(false);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'loaded'; screenshot: Screenshot | null }>({ kind: 'loading' });

  // Tick so the row reloads when OCR completes in the background — without
  // this the debug panel would keep showing 'pending' until the screen is
  // re-opened.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['screenshots']);

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
      <SafeAreaView className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={{ title: '', headerTintColor: '#fff' }} />
      </SafeAreaView>
    );
  }

  if (state.screenshot === null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={{ title: '', headerTintColor: '#fff' }} />
        <Text className="text-base text-slate-300">Place not found.</Text>
      </SafeAreaView>
    );
  }

  const screenshot = state.screenshot;

  const openMenu = () => {
    const inTrip = screenshot.tripId !== null;
    const options = [
      inTrip ? 'Move to trip' : 'Add to trip',
      ...(inTrip ? ['Remove from trip'] : []),
      'Delete',
      'Cancel',
    ];
    const cancelIndex = options.length - 1;
    const destructiveIndex = options.indexOf('Delete');

    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
      (idx) => {
        const choice = options[idx];
        if (choice === 'Add to trip' || choice === 'Move to trip') {
          setPickerMode(inTrip ? 'move' : 'assign');
          setPickerVisible(true);
        } else if (choice === 'Remove from trip' && db) {
          assignTrip(db, screenshot.id, null)
            .then(() => {
              setState({ kind: 'loaded', screenshot: { ...screenshot, tripId: null } });
              toast('Returned to Inbox');
            })
            .catch((err) => {
              console.error('[place-detail] assignTrip failed', err);
              Alert.alert('Could not remove from trip', 'Please try again.');
            });
        } else if (choice === 'Delete') {
          confirmDelete();
        }
      },
    );
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
            await softDeleteScreenshot(db, screenshot.id);
            router.back();
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-black">
      <Stack.Screen
        options={{
          title: '',
          headerStyle: { backgroundColor: '#000' },
          headerTintColor: '#fff',
          headerRight: () => (
            <View className="flex-row items-center">
              <Pressable
                onPress={() => setDebugVisible(true)}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="Show OCR text"
              >
                <Text className="text-base text-white">ⓘ</Text>
              </Pressable>
              {Platform.OS === 'ios' ? (
                <Pressable
                  onPress={openMenu}
                  className="px-3"
                  accessibilityRole="button"
                  accessibilityLabel="More actions"
                >
                  <Text className="text-2xl text-white">···</Text>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <View className="flex-1 items-center justify-center">
        <Image
          source={{ uri: screenshot.filePath }}
          className="h-full w-full"
          resizeMode="contain"
          accessibilityLabel="Screenshot"
        />
      </View>
      <TripPicker
        visible={pickerVisible}
        screenshotId={screenshot.id}
        mode={pickerMode}
        onClose={async (result) => {
          setPickerVisible(false);
          if (!result) return;
          // Refresh local state so the menu reflects the new trip.
          if (db) {
            const fresh = await getScreenshot(db, screenshot.id);
            if (fresh) setState({ kind: 'loaded', screenshot: fresh });
          }
          toast(pickerMode === 'assign' ? `Added to ${result.tripName}` : `Moved to ${result.tripName}`);
        }}
      />
      <DebugInfoModal
        visible={debugVisible}
        screenshot={screenshot}
        onClose={() => setDebugVisible(false)}
      />
    </SafeAreaView>
  );
}

function DebugInfoModal({
  visible,
  screenshot,
  onClose,
}: {
  visible: boolean;
  screenshot: Screenshot;
  onClose: () => void;
}) {
  const ocr = screenshot.ocrText ?? '';
  const charCount = [...ocr].length;
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-white">
        <View className="flex-row items-center justify-between border-b border-slate-200 px-4 py-3">
          <Text className="text-lg font-semibold text-slate-900">OCR debug</Text>
          <Pressable
            onPress={onClose}
            className="px-2"
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Text className="text-base text-slate-700">Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerClassName="px-4 py-3 gap-3">
          <Field label="ID" value={screenshot.id} mono />
          <Field label="Source" value={screenshot.source} />
          <Field label="Captured" value={screenshot.capturedAt} />
          <Field label="OCR status" value={screenshot.ocrStatus} />
          <View className="gap-1">
            <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
              OCR text · {charCount} chars
            </Text>
            {screenshot.ocrStatus === 'pending' ? (
              <Text className="text-sm italic text-slate-500">
                OCR pending — re-open this screen after a few seconds.
              </Text>
            ) : screenshot.ocrStatus === 'failed' ? (
              <Text className="text-sm italic text-red-600">
                OCR failed (3 retries exhausted).
              </Text>
            ) : ocr.length === 0 ? (
              <Text className="text-sm italic text-slate-500">
                (no text recognized)
              </Text>
            ) : (
              <Text selectable className="text-sm leading-5 text-slate-900">
                {ocr}
              </Text>
            )}
          </View>
          <Field label="File path" value={screenshot.filePath} mono small />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Field({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </Text>
      <Text
        selectable
        className={[
          small ? 'text-xs' : 'text-sm',
          mono ? 'font-mono' : '',
          'text-slate-900',
        ].join(' ')}
      >
        {value}
      </Text>
    </View>
  );
}

function toast(message: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    // iOS lacks a native toast; a quick alert is acceptable for v0.1.
    Alert.alert(message);
  }
}
