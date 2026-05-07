import { useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Image,
  Platform,
  Pressable,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getScreenshot,
  softDeleteScreenshot,
  assignTrip,
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
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'loaded'; screenshot: Screenshot | null }>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getScreenshot(db, id).then((s) => {
      if (!cancelled) setState({ kind: 'loaded', screenshot: s });
    });
    return () => {
      cancelled = true;
    };
  }, [db, id]);

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
          headerRight: () =>
            Platform.OS === 'ios' ? (
              <Pressable
                onPress={openMenu}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="More actions"
              >
                <Text className="text-2xl text-white">···</Text>
              </Pressable>
            ) : null,
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
    </SafeAreaView>
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
