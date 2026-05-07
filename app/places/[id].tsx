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
          // Picker is mounted by Task 10 — for now, log.
          if (__DEV__) console.log('[place-detail] open picker', { id, mode: inTrip ? 'move' : 'assign' });
        } else if (choice === 'Remove from trip' && db) {
          assignTrip(db, screenshot.id, null)
            .then(() => {
              setState({ kind: 'loaded', screenshot: { ...screenshot, tripId: null } });
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
    </SafeAreaView>
  );
}
