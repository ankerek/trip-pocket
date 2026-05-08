import { useEffect, useState } from 'react';
import { Alert, Modal } from 'react-native';
import { FlatList, Pressable, SafeAreaView, Text, TextInput, View } from '@/tw';
import * as Crypto from 'expo-crypto';
import {
  assignSourceTrip,
  createTrip,
  listTrips,
  movePlaceToTrip,
  useLiveQuery,
  type Trip,
} from '@/modules/storage';
import { getOrCreateOwnerId } from '@/modules/capture';
import { useDatabase } from './useDatabase';

export type TripPickerMode = 'assign' | 'move';
export type TripPickerEntityKind = 'source' | 'place';

export function TripPicker(props: {
  visible: boolean;
  entityId: string | null;
  entityKind: TripPickerEntityKind;
  mode: TripPickerMode;
  onClose: (result: { tripName: string } | null) => void;
}) {
  const { visible, entityId, entityKind, mode, onClose } = props;
  const db = useDatabase();
  const [stage, setStage] = useState<'list' | 'create'>('list');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [name, setName] = useState('');

  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['trips']);

  useEffect(() => {
    let cancelled = false;
    if (!db || !visible) return;
    listTrips(db).then((rows) => {
      if (!cancelled) setTrips(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [db, visible, tick]);

  useEffect(() => {
    if (!visible) {
      setStage('list');
      setName('');
    }
  }, [visible]);

  const assignTo = async (tripId: string): Promise<void> => {
    if (!db || !entityId) return;
    if (entityKind === 'source') {
      await assignSourceTrip(db, entityId, tripId);
    } else {
      await movePlaceToTrip(db, entityId, tripId);
    }
  };

  const choose = async (trip: Trip) => {
    try {
      await assignTo(trip.id);
      onClose({ tripName: trip.name });
    } catch (err) {
      Alert.alert('Could not assign trip', String(err));
    }
  };

  const trimmed = name.trim();
  const canSaveCreate = trimmed.length > 0 && db !== null && entityId !== null;

  const saveCreate = async () => {
    if (!db || !entityId || !canSaveCreate) return;
    try {
      const newId = Crypto.randomUUID();
      await createTrip(db, { id: newId, name: trimmed, ownerId: getOrCreateOwnerId() });
      await assignTo(newId);
      onClose({ tripName: trimmed });
    } catch (err) {
      Alert.alert('Could not create trip', String(err));
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => onClose(null)}
    >
      <SafeAreaView className="flex-1 bg-white">
        <View className="flex-row items-center justify-between border-b border-slate-200 p-4">
          <Pressable
            onPress={() => onClose(null)}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text className="text-base text-slate-600">Cancel</Text>
          </Pressable>
          <Text className="text-base font-semibold text-slate-900">
            {stage === 'list' ? (mode === 'assign' ? 'Add to trip' : 'Move to trip') : 'New trip'}
          </Text>
          {stage === 'create' ? (
            <Pressable
              onPress={saveCreate}
              disabled={!canSaveCreate}
              accessibilityRole="button"
              accessibilityLabel="Save"
              accessibilityState={{ disabled: !canSaveCreate }}
            >
              <Text
                className={
                  canSaveCreate
                    ? 'text-base font-semibold text-blue-600'
                    : 'text-base font-semibold text-slate-300'
                }
              >
                Save
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: 50 }} />
          )}
        </View>

        {stage === 'list' ? (
          <FlatList
            data={trips}
            keyExtractor={(t) => t.id}
            ListHeaderComponent={
              <Pressable
                onPress={() => setStage('create')}
                className="border-b border-slate-100 p-4"
                accessibilityRole="button"
                accessibilityLabel="Create new trip"
              >
                <Text className="text-base font-semibold text-blue-600">+ Create new trip</Text>
              </Pressable>
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => choose(item)}
                className="border-b border-slate-100 p-4"
                accessibilityRole="button"
                accessibilityLabel={item.name}
              >
                <Text className="text-base text-slate-900">{item.name}</Text>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text className="p-4 text-sm text-slate-400">
                No trips yet — tap "Create new trip".
              </Text>
            }
          />
        ) : (
          <View className="p-4">
            <TextInput
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="Trip name (e.g. Japan)"
              className="rounded-md border border-slate-200 px-3 py-3 text-base"
              returnKeyType="done"
              onSubmitEditing={saveCreate}
            />
            <Pressable
              onPress={() => setStage('list')}
              className="mt-3"
              accessibilityRole="button"
              accessibilityLabel="Back to trip list"
            >
              <Text className="text-sm text-slate-500">← Back to trip list</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}
