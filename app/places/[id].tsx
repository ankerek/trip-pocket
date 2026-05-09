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
import { CategoryChip } from '@/components/CategoryChip';
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

  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['places']);

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

  useEffect(() => {
    if (state.kind !== 'loaded' || !state.place) return;
    const status = state.place.enrichmentStatus;
    if (status === 'pending' || status === 'failed') {
      getEnricher()?.enqueueEnrichment(state.place.id);
    }
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <View className="flex-1 bg-bg">
        <Stack.Screen options={HEADER_OPTIONS} />
      </View>
    );
  }

  if (state.place === null) {
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <Stack.Screen options={HEADER_OPTIONS} />
        <Text className="text-base text-text-muted">Place not found.</Text>
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
    if (process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    openInMaps(toMapTarget(place)).catch((err) =>
      console.warn('[place-detail] open Maps failed', err),
    );
  };

  return (
    <>
      <Stack.Screen options={HEADER_OPTIONS} />
      <ScrollView
        className="flex-1 bg-bg"
        contentInsetAdjustmentBehavior="automatic"
      >
        {/* Hero photo. Continuity with the grid tile comes from the
            expo-image memory-disk cache + the 150ms transition on both
            ends — see spec §5 spike outcome. */}
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            className="aspect-[4/3] w-full"
            style={{ backgroundColor: '#e2e8f0' }}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
          />
        ) : (
          <View
            className="aspect-[4/3] w-full items-center justify-center"
            style={{ backgroundColor: '#e2e8f0' }}
          >
            <Icon name="mappin.circle" size={48} tintColor="#94a3b8" />
          </View>
        )}

        {/* Title block — spec §4.3. */}
        <View className="px-4 pb-2 pt-5">
          <Text
            className="text-text"
            style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4 }}
          >
            {place.name}
          </Text>
          {place.city ? (
            <Text className="mt-1 text-base text-text-muted">{place.city}</Text>
          ) : null}

          <View className="mt-3 flex-row flex-wrap items-center gap-2">
            {place.rating !== null ? <Stat label={`★ ${place.rating.toFixed(1)}`} /> : null}
            {place.priceLevel !== null && place.priceLevel > 0 ? (
              <Stat label={'$'.repeat(place.priceLevel)} />
            ) : null}
            {place.category ? <CategoryChip category={place.category} /> : null}
          </View>
        </View>

        {/* Primary CTA — Teal, full-width per spec §4.3. */}
        <View className="px-4 pb-3 pt-1">
          <Pressable
            onPress={onOpenInMaps}
            accessibilityRole="button"
            accessibilityLabel="Open in Maps"
            className="flex-row items-center justify-center gap-2 rounded-2xl py-3.5"
            style={{ backgroundColor: '#14b8a6' }}
          >
            <Icon name="map.fill" size={18} tintColor="#ffffff" />
            <Text
              style={{ fontSize: 15, fontWeight: '600', color: '#ffffff', letterSpacing: -0.2 }}
            >
              Open in Maps
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onAssignTrip(inTrip ? 'move' : 'assign')}
            accessibilityRole="button"
            accessibilityLabel={inTrip ? 'Move to trip' : 'Add to trip'}
            className="mt-2 flex-row items-center justify-center gap-2 rounded-2xl py-3"
            style={{
              backgroundColor: 'rgba(15,23,42,0.04)',
              borderWidth: 1,
              borderColor: 'rgba(15,23,42,0.06)',
            }}
          >
            <Icon name="folder" size={16} tintColor="#0c4a6e" />
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#0c4a6e' }}>
              {inTrip ? 'Move to another trip' : 'Add to a trip'}
            </Text>
          </Pressable>
        </View>

        {place.description ? (
          <View className="px-4 pb-4 pt-2">
            <Text className="text-[15px] leading-5 text-text">{place.description}</Text>
          </View>
        ) : null}

        {/* Metadata block. */}
        <View
          className="mx-4 mt-2 overflow-hidden rounded-2xl"
          style={{
            backgroundColor: 'rgba(15,23,42,0.025)',
            borderWidth: 1,
            borderColor: 'rgba(15,23,42,0.06)',
          }}
        >
          {place.formattedAddress ? (
            <MetaRow icon="mappin" text={place.formattedAddress} />
          ) : null}
          {place.externalUrl ? <MetaRow icon="link" text={place.externalUrl} /> : null}
          <MetaRow
            icon="info.circle"
            text={enrichmentLabel(place.enrichmentStatus)}
            muted
          />
        </View>

        {/* Sources strip. */}
        <View className="px-4 pb-2 pt-6">
          <Text
            className="text-text-muted"
            style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}
          >
            Found in {sources?.length ?? 0} screenshot{(sources?.length ?? 0) === 1 ? '' : 's'}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-4 pb-6 gap-2"
        >
          {(sources ?? []).map((src) => (
            <Pressable
              key={src.source_id}
              onPress={() => router.push(`/sources/${src.source_id}`)}
              className="overflow-hidden rounded-xl"
              style={{
                width: 88,
                height: 110,
                backgroundColor: '#e2e8f0',
              }}
              accessibilityRole="button"
              accessibilityLabel="Open source screenshot"
            >
              {src.file_path ? (
                <Image
                  source={src.file_path}
                  className="h-full w-full"
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <Icon name="link" size={20} tintColor="#94a3b8" />
                </View>
              )}
              {src.trip_id !== place.tripId && src.trip_name ? (
                <View
                  className="absolute inset-x-0 bottom-0 px-1.5 py-0.5"
                  style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
                >
                  <Text
                    className="text-[10px] text-white"
                    numberOfLines={1}
                    style={{ fontWeight: '500' }}
                  >
                    from {src.trip_name}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>

        {/* Footer destructive actions, separated. */}
        <View className="px-4 pb-12 pt-4">
          {inTrip ? (
            <Pressable
              onPress={onUnassign}
              className="mb-2 rounded-2xl py-3"
              accessibilityRole="button"
              accessibilityLabel="Remove from trip"
              style={{
                backgroundColor: 'rgba(15,23,42,0.04)',
                borderWidth: 1,
                borderColor: 'rgba(15,23,42,0.06)',
              }}
            >
              <Text
                className="text-center text-text"
                style={{ fontSize: 14, fontWeight: '500' }}
              >
                Remove from trip
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={confirmDelete}
            className="rounded-2xl py-3"
            accessibilityRole="button"
            accessibilityLabel="Delete place"
            style={{
              borderWidth: 1,
              borderColor: 'rgba(220,38,38,0.30)',
              backgroundColor: 'rgba(254,242,242,0.6)',
            }}
          >
            <Text
              className="text-center"
              style={{ fontSize: 14, fontWeight: '600', color: '#dc2626' }}
            >
              Delete place
            </Text>
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

function Stat({ label }: { label: string }) {
  return (
    <View
      className="rounded-full px-2.5 py-1"
      style={{ backgroundColor: 'rgba(15,23,42,0.06)' }}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: '600',
          color: '#475569',
          fontVariant: ['tabular-nums'],
        }}
      >
        {label}
      </Text>
    </View>
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
    <View
      className="flex-row items-center gap-3 px-4 py-3"
      style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(15,23,42,0.06)' }}
    >
      <Icon name={icon} size={16} tintColor={muted ? '#94a3b8' : '#0c4a6e'} />
      <Text
        className="flex-1"
        numberOfLines={2}
        style={{ fontSize: 14, color: muted ? '#94a3b8' : '#0c4a6e' }}
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
