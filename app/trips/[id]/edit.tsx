import { useEffect, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { Pressable, Text, TextInput, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
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
      const countRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM places WHERE trip_id = ? AND deleted_at IS NULL`,
        id,
      );
      if (cancelled) return;
      setLoad({ kind: 'loaded', trip: t, count: t ? countRow?.n ?? 0 : 0 });
      if (t) setName(t.name);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  if (load.kind === 'loading') return null;

  if (load.trip === null) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLeft: () => (
              <Pressable
                onPress={() => router.back()}
                className="px-3"
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                hitSlop={8}
              >
                <Text style={{ fontSize: 16, color: '#475569' }}>Cancel</Text>
              </Pressable>
            ),
            headerRight: () => null,
          }}
        />
        <View className="flex-1 items-center justify-center bg-bg">
          <Text className="text-base text-text-muted">Trip not found.</Text>
        </View>
      </>
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
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              hitSlop={8}
            >
              <Text style={{ fontSize: 16, color: '#475569' }}>Cancel</Text>
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
              hitSlop={8}
            >
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: '600',
                  color: canSave ? '#14b8a6' : '#cbd5e1',
                }}
              >
                Save
              </Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        className="flex-1 bg-bg"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: 24, paddingBottom: 32 }}
      >
        <Text
          className="text-text-muted mb-2"
          style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' }}
        >
          Trip name
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Trip name"
          placeholderTextColor="#94a3b8"
          returnKeyType="done"
          onSubmitEditing={onSave}
          style={{
            fontSize: 17,
            color: '#0c4a6e',
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: '#f8fafc',
            borderWidth: 1,
            borderColor: 'rgba(15,23,42,0.06)',
          }}
        />

        <View style={{ height: 24 }} />

        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete trip"
          style={{
            paddingVertical: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: 'rgba(220,38,38,0.30)',
            backgroundColor: 'rgba(254,242,242,0.6)',
          }}
        >
          <Text
            className="text-center"
            style={{ fontSize: 14, fontWeight: '600', color: '#dc2626' }}
          >
            Delete trip
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
