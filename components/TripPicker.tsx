import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, StyleSheet } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { Pressable, Text, TextInput, View } from '@/tw';
import { cn } from '@/tw/cn';
import {
  assignSourceTrip,
  countPlacesByTrip,
  createTrip,
  listTrips,
  movePlaceToTrip,
  useLiveQuery,
  type Trip,
} from '@/modules/storage';
import { getOrCreateOwnerId } from '@/modules/capture';
import { useDatabase } from './useDatabase';
import { useThemeColors } from '@/tw/theme';
import { Icon } from '@/components/Icon';

export type TripPickerMode = 'assign' | 'move';
export type TripPickerEntityKind = 'source' | 'place';

type TripWithCount = Trip & { placeCount: number };

export function TripPicker(props: {
  visible: boolean;
  entityId: string | null;
  entityKind: TripPickerEntityKind;
  mode: TripPickerMode;
  onClose: (result: { tripName: string } | null) => void;
  /**
   * Forwarded to assignSourceTrip when entityKind === 'source'. Lets the
   * triage flow pass per-place deselections without splitting the assign
   * call across two sites. Ignored for entityKind === 'place'.
   */
  assignOptions?: { excludePlaceIds?: string[] };
  /** Trip the entity is currently assigned to — that row gets a checkmark. */
  currentTripId?: string | null;
}) {
  const { visible, entityId, entityKind, mode, onClose, assignOptions, currentTripId } = props;
  const db = useDatabase();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  const [internalVisible, setInternalVisible] = useState(false);
  const [trips, setTrips] = useState<TripWithCount[]>([]);
  const [creatingNew, setCreatingNew] = useState(false);
  const [name, setName] = useState('');

  // Tick on either trips or places change so place counts stay accurate
  // if data shifts while the sheet is mounted.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['trips', 'places']);

  const progress = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setInternalVisible(true);
      progress.value = withSpring(1, { damping: 22, stiffness: 240, mass: 0.8 });
    } else if (internalVisible) {
      progress.value = withTiming(0, { duration: 220 }, (finished) => {
        if (finished) runOnJS(setInternalVisible)(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      setCreatingNew(false);
      setName('');
    }
  }, [visible]);

  useEffect(() => {
    if (!db || !visible) return;
    let cancelled = false;
    Promise.all([listTrips(db), countPlacesByTrip(db)]).then(([list, counts]) => {
      if (cancelled) return;
      const merged: TripWithCount[] = list.map((t) => ({
        ...t,
        placeCount: counts[t.id] ?? 0,
      }));
      setTrips(merged);
      // Empty state: skip straight to the create form.
      if (merged.length === 0) setCreatingNew(true);
    });
    return () => {
      cancelled = true;
    };
  }, [db, visible, tick]);

  const assignTo = async (tripId: string): Promise<void> => {
    if (!db || !entityId) return;
    if (entityKind === 'source') {
      await assignSourceTrip(db, entityId, tripId, assignOptions);
    } else {
      await movePlaceToTrip(db, entityId, tripId);
    }
  };

  const choose = async (trip: TripWithCount) => {
    // Tapping the trip the entity already belongs to is a no-op — close
    // without re-running the assign (avoids a pointless updated_at bump
    // and a confusing "Moved to X" toast).
    if (trip.id === currentTripId) {
      onClose(null);
      return;
    }
    try {
      await assignTo(trip.id);
      onClose({ tripName: trip.name });
    } catch (err) {
      Alert.alert('Could not assign trip', String(err));
    }
  };

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && db !== null && entityId !== null;

  const saveCreate = async () => {
    if (!db || !entityId || !canSave) return;
    try {
      const newId = Crypto.randomUUID();
      await createTrip(db, { id: newId, name: trimmed, ownerId: getOrCreateOwnerId() });
      await assignTo(newId);
      onClose({ tripName: trimmed });
    } catch (err) {
      Alert.alert('Could not create trip', String(err));
    }
  };

  const handleBackdropPress = () => {
    if (creatingNew && trips.length > 0) {
      setCreatingNew(false);
      setName('');
    } else {
      onClose(null);
    }
  };

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * 600 }],
  }));

  const title = mode === 'assign' ? 'Add to trip' : 'Move to trip';

  return (
    <Modal
      visible={internalVisible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => onClose(null)}
    >
      <View style={StyleSheet.absoluteFillObject}>
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(15,23,42,0.42)' },
            backdropStyle,
          ]}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={handleBackdropPress}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'flex-end' }}
          pointerEvents="box-none"
        >
          <Animated.View
            accessibilityViewIsModal
            style={[
              {
                // Animated.View is from reanimated, not @/tw, so it ignores
                // `className` — the bg has to come through the style prop or
                // the sheet renders transparent over the scrim.
                backgroundColor: colors.bg,
                borderTopLeftRadius: 22,
                borderTopRightRadius: 22,
                paddingTop: 8,
                paddingBottom: insets.bottom + 16,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: -8 },
                elevation: 24,
              },
              sheetStyle,
            ]}
          >
            <View
              className="bg-hairline self-center"
              style={{
                width: 40,
                height: 5,
                borderRadius: 999,
                marginTop: 4,
                marginBottom: 12,
              }}
            />
            <Text className="text-text text-center text-[15px] font-bold">{title}</Text>

            <View className="mt-2">
              {creatingNew ? (
                <CreateForm
                  name={name}
                  onChangeName={setName}
                  canSave={canSave}
                  onSave={saveCreate}
                />
              ) : (
                <CreateRow onPress={() => setCreatingNew(true)} />
              )}
              {trips.map((t) => (
                <TripRow
                  key={t.id}
                  trip={t}
                  mode={mode}
                  selected={t.id === currentTripId}
                  onPress={() => choose(t)}
                />
              ))}
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function TripRow(props: {
  trip: TripWithCount;
  mode: TripPickerMode;
  selected: boolean;
  onPress: () => void;
}) {
  const { trip, mode, selected, onPress } = props;
  const colors = useThemeColors();
  const hint = selected
    ? 'Already assigned to this trip'
    : mode === 'assign'
      ? 'Adds to this trip'
      : 'Moves to this trip';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={trip.name}
      accessibilityHint={hint}
      accessibilityState={{ selected }}
      className="border-hairline flex-row items-center"
      style={{ paddingVertical: 15, paddingHorizontal: 20, borderTopWidth: 1, gap: 10 }}
    >
      <Text
        className={cn(
          'flex-1 text-[15px]',
          selected ? 'text-accent font-semibold' : 'text-text font-medium',
        )}
        numberOfLines={1}
      >
        {trip.name}
      </Text>
      <Text className="text-text-muted text-[13px] font-medium">
        {formatCount(trip.placeCount)}
      </Text>
      {selected ? <Icon name="checkmark" size={16} tintColor={colors.accent} /> : null}
    </Pressable>
  );
}

function CreateRow(props: { onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel="Create new trip"
      className="flex-row items-center"
      style={{ paddingVertical: 15, paddingHorizontal: 20, gap: 10 }}
    >
      <View
        className="bg-info-bg items-center justify-center"
        style={{ width: 22, height: 22, borderRadius: 999 }}
      >
        <Text className="text-info-text text-[15px] leading-none font-bold">+</Text>
      </View>
      <Text className="text-info-text text-[15px] font-semibold">New trip</Text>
    </Pressable>
  );
}

function CreateForm(props: {
  name: string;
  onChangeName: (v: string) => void;
  canSave: boolean;
  onSave: () => void;
}) {
  const { name, onChangeName, canSave, onSave } = props;
  const colors = useThemeColors();
  return (
    <View
      className="bg-surface border-hairline flex-row items-center"
      style={{
        paddingVertical: 12,
        paddingHorizontal: 20,
        gap: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
      }}
    >
      <TextInput
        autoFocus
        value={name}
        onChangeText={onChangeName}
        placeholder="Trip name"
        placeholderTextColor={colors.textMuted}
        returnKeyType="done"
        onSubmitEditing={onSave}
        accessibilityLabel="New trip name"
        className="bg-bg border-hairline text-text flex-1 text-[15px]"
        style={{
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 9,
        }}
      />
      <Pressable
        onPress={onSave}
        disabled={!canSave}
        accessibilityRole="button"
        accessibilityLabel="Save trip"
        accessibilityState={{ disabled: !canSave }}
        className={canSave ? 'bg-accent' : 'bg-hairline'}
        style={{
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: 9,
          opacity: canSave ? 1 : 0.6,
        }}
      >
        <Text className="text-[14px] font-bold text-white">Save</Text>
      </Pressable>
    </View>
  );
}

function formatCount(n: number): string {
  if (n === 0) return 'No places';
  if (n === 1) return '1 place';
  return `${n} places`;
}
