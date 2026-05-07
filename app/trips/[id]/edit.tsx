import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { Pressable, SafeAreaView, Text, TextInput, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  countByTrip,
  getTrip,
  renameTrip,
  softDeleteTrip,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; trip: Trip | null; count: number };

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    (async () => {
      const t = await getTrip(db, id);
      const counts = await countByTrip(db);
      if (cancelled) return;
      setLoad({ kind: 'loaded', trip: t, count: t ? counts[id] ?? 0 : 0 });
      if (t) setName(t.name);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (load.kind === 'loading') return null;

  if (load.trip === null) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Stack.Screen
          options={{
            headerLeft: () => (
              <Pressable
                onPress={() => router.back()}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text className="text-base text-slate-600">Cancel</Text>
              </Pressable>
            ),
            headerRight: () => null,
          }}
        />
        <Text className="text-base text-slate-500">Trip not found.</Text>
      </SafeAreaView>
    );
  }

  const trip = load.trip;
  const count = load.count;
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== trip.name && db !== null;

  const onSave = async () => {
    if (!db || !id || !canSave) return;
    try {
      await renameTrip(db, { id, name: trimmed });
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      router.back();
    } catch (err) {
      Alert.alert('Could not rename trip', String(err));
    }
  };

  const onDelete = () => {
    if (!db || !id) return;
    Alert.alert(
      `Delete '${trip.name}'?`,
      `Its ${count} place${count === 1 ? '' : 's'} return${count === 1 ? 's' : ''} to Inbox.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (process.env.EXPO_OS === 'ios') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
              }
              await softDeleteTrip(db, id);
              // Pop twice: first this modal, then the trip detail screen behind it.
              // Assumes we were opened from /trips/[id] (the only entry path in v0.1).
              // If a future deep link opens this modal directly, the second back() will
              // pop to whatever was below — usually still acceptable, but worth revisiting.
              router.back();
              setTimeout(() => router.back(), 0);
            } catch (err) {
              Alert.alert('Could not delete trip', String(err));
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text className="text-base text-slate-600">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={onSave}
              disabled={!canSave}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Save"
              accessibilityState={{ disabled: !canSave }}
            >
              <Text
                className={
                  canSave
                    ? 'text-base font-semibold text-blue-600'
                    : 'text-base font-semibold text-slate-300'
                }
              >
                Save
              </Text>
            </Pressable>
          ),
        }}
      />
      <View className="p-4">
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Trip name"
          className="rounded-md border border-slate-200 px-3 py-3 text-base"
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
      </View>
      <View className="mt-auto p-4">
        <Pressable
          onPress={onDelete}
          className="rounded-md border border-red-300 px-3 py-3"
          accessibilityRole="button"
          accessibilityLabel="Delete trip"
        >
          <Text className="text-center text-base font-semibold text-red-600">Delete trip</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
