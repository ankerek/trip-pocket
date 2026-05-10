import { useEffect, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { Pressable, Text, TextInput, View } from '@/tw';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  getTrip,
  renameTrip,
  deleteTrip,
  type Trip,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';

type CountSet = {
  places: number;
  sources: number;
  cascadeDeletedPlaces: number;
  cascadeSurvivingShared: number;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; trip: Trip | null; counts: CountSet | null };

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
      if (!t) {
        if (!cancelled) setLoad({ kind: 'loaded', trip: null, counts: null });
        return;
      }
      const placeCountRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM places WHERE trip_id = ?`,
        id,
      );
      const sourceCountRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sources WHERE trip_id = ?`,
        id,
      );
      // Places that cascade-delete: every junction points at a source in this trip.
      const cascadeDeletedRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM places p
          WHERE p.id IN (
            SELECT DISTINCT place_id FROM place_sources
             WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)
          )
            AND NOT EXISTS (
              SELECT 1 FROM place_sources ps
               WHERE ps.place_id = p.id
                 AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
            )`,
        id, id,
      );
      // Places that survive cascade because they have other-trip sources too.
      const cascadeSharedRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM places p
          WHERE (p.trip_id = ?
                 OR p.id IN (SELECT DISTINCT place_id FROM place_sources
                              WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)))
            AND EXISTS (
              SELECT 1 FROM place_sources ps
               WHERE ps.place_id = p.id
                 AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
            )`,
        id, id, id,
      );
      if (cancelled) return;
      setLoad({
        kind: 'loaded',
        trip: t,
        counts: {
          places: placeCountRow?.n ?? 0,
          sources: sourceCountRow?.n ?? 0,
          cascadeDeletedPlaces: cascadeDeletedRow?.n ?? 0,
          cascadeSurvivingShared: cascadeSharedRow?.n ?? 0,
        },
      });
      setName(t.name);
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
  const counts = load.counts;
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

  const onDeleteUntriage = () => {
    if (!db || !id || !counts) return;
    const { sources: n, places: m } = counts;
    const body =
      n === 0 && m === 0
        ? "This can't be undone."
        : `${n} screenshot${n === 1 ? '' : 's'} and ${m} place${m === 1 ? '' : 's'} will move back to your Inbox.`;
    Alert.alert(
      `Delete '${trip.name}'?`,
      body,
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
              await deleteTrip(db, id, 'untriage');
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

  const onDeleteCascade = () => {
    if (!db || !id || !counts) return;
    const { sources: n, cascadeDeletedPlaces: m, cascadeSurvivingShared: s } = counts;
    const title = `Delete '${trip.name}' and ${n} screenshot${n === 1 ? '' : 's'}, ${m} place${m === 1 ? '' : 's'}?`;
    const lines: string[] = [];
    if (s > 0) {
      lines.push(`${s} place${s === 1 ? '' : 's'} shared with other trips will be moved to your Inbox.`);
    }
    lines.push("This can't be undone.");
    Alert.alert(
      title,
      lines.join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            try {
              if (process.env.EXPO_OS === 'ios') {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
              }
              await deleteTrip(db, id, 'cascade');
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

  const cascadeAvailable =
    counts !== null && (counts.sources > 0 || counts.cascadeDeletedPlaces > 0);

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
          onPress={onDeleteUntriage}
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

        {cascadeAvailable ? (
          <>
            <View style={{ height: 8 }} />
            <Pressable
              onPress={onDeleteCascade}
              accessibilityRole="button"
              accessibilityLabel="Delete trip and everything in it"
              style={{ paddingVertical: 10 }}
              hitSlop={8}
            >
              <Text
                className="text-center"
                style={{ fontSize: 13, fontWeight: '500', color: '#dc2626' }}
              >
                Delete trip and everything in it
              </Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}
