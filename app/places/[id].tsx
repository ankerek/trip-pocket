import { useEffect, useState } from 'react';
import { Alert, ScrollView, ToastAndroid } from 'react-native';
import { Image, Pressable, Text, View } from '@/tw';
import Constants from 'expo-constants';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  getPlace,
  movePlaceToTrip,
  softDeletePlace,
  useLiveQuery,
  type Place,
} from '@/modules/storage';
import { Icon } from '@/components/Icon';
import { useDatabase } from '@/components/useDatabase';
import { TripPicker, type TripPickerMode } from '@/components/TripPicker';
import { openInMaps, type MapTarget } from '@/lib/openInMaps';
import { getEnricher } from '@/modules/enrichment';

const HEADER_OPTIONS = {
  title: '',
  headerTransparent: true,
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
} as const;

type SourceStripItem = {
  source_id: string;
  file_path: string | null;
  trip_id: string | null;
  trip_name: string | null;
};

export default function PlaceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<TripPickerMode>('assign');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'loaded'; place: Place | null }
  >({ kind: 'loading' });

  // Re-read when this place changes (enrichment lands, trip moves).
  const tick = useLiveQuery<{ v: number }>(
    `SELECT 0 AS v`,
    [],
    ['places'],
  );

  const sources = useLiveQuery<SourceStripItem>(
    `SELECT ps.source_id, s.file_path, s.trip_id, t.name AS trip_name
       FROM place_sources ps
       JOIN sources s ON s.id = ps.source_id
  LEFT JOIN trips t ON t.id = s.trip_id
      WHERE ps.place_id = ? AND ps.deleted_at IS NULL
        AND s.deleted_at IS NULL
   ORDER BY ps.extracted_at ASC`,
    id ? [id] : [],
    ['place_sources', 'sources', 'trips'],
  );

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getPlace(db, id).then((p) => {
      if (!cancelled) setState({ kind: 'loaded', place: p });
    });
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  // Trigger /enrich on first paint when status warrants it. The enricher
  // dedups internally, so it's safe to fire from every visit.
  useEffect(() => {
    if (state.kind !== 'loaded' || !state.place) return;
    const status = state.place.enrichmentStatus;
    if (status === 'pending' || status === 'failed') {
      getEnricher()?.enqueueEnrichment(state.place.id);
    }
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <View className="flex-1 bg-white">
        <Stack.Screen options={HEADER_OPTIONS} />
      </View>
    );
  }

  if (state.place === null) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Stack.Screen options={HEADER_OPTIONS} />
        <Text className="text-base text-slate-500">Place not found.</Text>
      </View>
    );
  }

  const place = state.place;
  const inTrip = place.tripId !== null;
  const photoUrl = buildPhotoUrl(place.photoName);

  const onAssignTrip = (mode: TripPickerMode) => {
    setPickerMode(mode);
    setPickerVisible(true);
  };

  const onUnassign = async () => {
    if (!db) return;
    try {
      await movePlaceToTrip(db, place.id, null);
      setState({ kind: 'loaded', place: { ...place, tripId: null } });
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      toast('Returned to Untriaged');
    } catch (err) {
      console.error('[place-detail] unassign failed', err);
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
            await softDeletePlace(db, place.id);
            router.back();
          },
        },
      ],
      { cancelable: true },
    );
  };

  const onOpenInMaps = () => {
    openInMaps(toMapTarget(place)).catch((err) =>
      console.warn('[place-detail] open Maps failed', err),
    );
  };

  return (
    <>
      <Stack.Screen options={HEADER_OPTIONS} />
      <ScrollView
        className="flex-1 bg-white"
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Hero photo (or category-tinted placeholder pre-enrichment). */}
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="aspect-[4/3] w-full bg-slate-100"
            contentFit="cover"
            transition={150}
          />
        ) : (
          <View className="aspect-[4/3] w-full items-center justify-center bg-slate-100">
            <Icon name="mappin.circle" size={48} tintColor="#94a3b8" />
          </View>
        )}

        <View className="px-4 pt-4 pb-1">
          <Text className="text-2xl font-semibold text-slate-900">{place.name}</Text>
          {place.city ? (
            <Text className="mt-0.5 text-base text-slate-500">{place.city}</Text>
          ) : null}
          {place.rating !== null ? (
            <Text className="mt-1 text-sm text-slate-500">
              ★ {place.rating.toFixed(1)}
              {place.priceLevel !== null && place.priceLevel > 0
                ? ' · '.concat('$'.repeat(place.priceLevel))
                : ''}
            </Text>
          ) : null}
        </View>

        <View className="flex-row gap-2 px-4 py-3">
          <Pressable
            onPress={onOpenInMaps}
            className="flex-row items-center gap-1 rounded-md bg-blue-600 px-4 py-2"
            accessibilityRole="button"
            accessibilityLabel="Open in Maps"
          >
            <Icon name="map" size={18} tintColor="#ffffff" />
            <Text className="text-sm font-semibold text-white">Open in Maps</Text>
          </Pressable>
          <Pressable
            onPress={() => onAssignTrip(inTrip ? 'move' : 'assign')}
            className="flex-row items-center gap-1 rounded-md border border-slate-300 px-4 py-2"
            accessibilityRole="button"
            accessibilityLabel={inTrip ? 'Move to trip' : 'Add to trip'}
          >
            <Icon name="folder" size={18} tintColor="#0f172a" />
            <Text className="text-sm font-medium text-slate-900">
              {inTrip ? 'Move' : 'Add to trip'}
            </Text>
          </Pressable>
        </View>

        {place.description ? (
          <View className="px-4 pb-3">
            <Text className="text-sm leading-5 text-slate-700">{place.description}</Text>
          </View>
        ) : null}

        {/* Metadata block — stays terse; details users may not care about
            keep their own row, the way Apple Maps surfaces them. */}
        <View className="border-y border-slate-100">
          {place.formattedAddress ? (
            <MetaRow icon="mappin" text={place.formattedAddress} />
          ) : null}
          {place.externalUrl ? (
            <MetaRow icon="link" text={place.externalUrl} />
          ) : null}
          <MetaRow
            icon="info.circle"
            text={enrichmentLabel(place.enrichmentStatus)}
            muted
          />
        </View>

        {/* Sources strip — every screenshot/URL that produced this place. */}
        <View className="px-4 pt-4 pb-2">
          <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Sources · {sources?.length ?? 0}
          </Text>
        </View>
        <View className="flex-row flex-wrap gap-2 px-4 pb-6">
          {(sources ?? []).map((src) => (
            <Pressable
              key={src.source_id}
              onPress={() => router.push(`/sources/${src.source_id}`)}
              className="overflow-hidden rounded-md bg-slate-100"
              accessibilityRole="button"
              accessibilityLabel="Open source"
              style={{ width: 88, height: 110 }}
            >
              {src.file_path ? (
                <Image
                  source={src.file_path}
                  className="h-full w-full"
                  contentFit="cover"
                />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <Icon name="link" size={20} tintColor="#64748b" />
                </View>
              )}
              {src.trip_id !== place.tripId && src.trip_name ? (
                <View className="absolute inset-x-0 bottom-0 bg-slate-900/60 px-1 py-0.5">
                  <Text className="text-[10px] text-white" numberOfLines={1}>
                    from {src.trip_name}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </View>

        {/* Footer actions: destructive separated from the primary toolbar. */}
        <View className="px-4 pb-10">
          {inTrip ? (
            <Pressable
              onPress={onUnassign}
              className="mb-2 rounded-md border border-slate-200 px-4 py-3"
              accessibilityRole="button"
              accessibilityLabel="Remove from trip"
            >
              <Text className="text-center text-sm font-medium text-slate-700">
                Remove from trip
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={confirmDelete}
            className="rounded-md border border-red-300 px-4 py-3"
            accessibilityRole="button"
            accessibilityLabel="Delete place"
          >
            <Text className="text-center text-sm font-semibold text-red-600">Delete place</Text>
          </Pressable>
        </View>
      </ScrollView>

      <TripPicker
        visible={pickerVisible}
        entityId={place.id}
        entityKind="place"
        mode={pickerMode}
        onClose={async (result) => {
          setPickerVisible(false);
          if (!result) return;
          if (db) {
            const fresh = await getPlace(db, place.id);
            if (fresh) setState({ kind: 'loaded', place: fresh });
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

function MetaRow({
  icon,
  text,
  muted,
}: {
  icon: string;
  text: string;
  muted?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0">
      <Icon name={icon} size={18} tintColor={muted ? '#94a3b8' : '#0f172a'} />
      <Text
        className={muted ? 'flex-1 text-sm text-slate-500' : 'flex-1 text-sm text-slate-900'}
        numberOfLines={2}
      >
        {text}
      </Text>
    </View>
  );
}

function enrichmentLabel(status: Place['enrichmentStatus']): string {
  switch (status) {
    case 'pending':
      return 'Looking up details…';
    case 'enriched':
      return 'Details up to date';
    case 'not-found':
      return 'No match found in Maps. Tap Open in Maps to search.';
    case 'failed':
      return 'Couldn’t fetch details. Reopen to retry.';
  }
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=1200&h=900`;
}

function toMapTarget(place: Place): MapTarget {
  return {
    name: place.name,
    city: place.city ?? '',
    address: place.formattedAddress ?? null,
    latitude: place.latitude,
    longitude: place.longitude,
    externalPlaceId: place.externalPlaceId,
  };
}

function toast(message: string) {
  if (process.env.EXPO_OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert(message);
  }
}
