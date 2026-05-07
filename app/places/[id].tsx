import { useEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Image,
  Platform,
  Pressable,
  Text,
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
import { useDatabase } from '@/app/_components/useDatabase';

export default function PlaceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getScreenshot(db, id).then((s) => {
      if (!cancelled) setScreenshot(s);
    });
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (!screenshot) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-black">
        <Stack.Screen options={{ title: '', headerTintColor: '#fff' }} />
      </SafeAreaView>
    );
  }

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
          // Picker is mounted by Task 10 — for now, log.
          if (__DEV__) console.log('[place-detail] open picker', { id, mode: inTrip ? 'move' : 'assign' });
        } else if (choice === 'Remove from trip' && db) {
          assignTrip(db, screenshot.id, null).then(() => {
            setScreenshot({ ...screenshot, tripId: null });
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
    </SafeAreaView>
  );
}
