import { useEffect, useState } from 'react';
import { Alert, ScrollView, ToastAndroid } from 'react-native';
import { Image, Pressable, Text, View } from '@/tw';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  getPlace,
  movePlaceToTrip,
  softDeletePlace,
  useLiveQuery,
  type Place,
} from '@/modules/storage';
import { Icon } from '@/components/Icon';
import { TripChip } from '@/components/TripChip';
import { useDatabase } from '@/components/useDatabase';
import { TripPicker, type TripPickerMode } from '@/components/TripPicker';
import { openInMaps, type MapTarget } from '@/lib/openInMaps';
import { getEnricher } from '@/modules/enrichment';
import { DetailHeaderOverlay } from '@/components/DetailHeaderOverlay';

type SourceStripItem = {
  source_id: string;
  file_path: string | null;
  trip_id: string | null;
  trip_name: string | null;
};

const TRIP_NAME_SQL = `SELECT name FROM trips WHERE id = ? AND deleted_at IS NULL LIMIT 1`;

export default function PlaceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const insets = useSafeAreaInsets();
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<TripPickerMode>('assign');
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'loaded'; place: Place | null }
  >({ kind: 'loading' });

  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['places']);

  const placeForQueries = state.kind === 'loaded' ? state.place : null;
  const tripIdForQuery = placeForQueries?.tripId ?? null;

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

  const tripRows = useLiveQuery<{ name: string }>(
    TRIP_NAME_SQL,
    tripIdForQuery ? [tripIdForQuery] : [],
    ['trips'],
  );
  const tripName = tripIdForQuery ? (tripRows?.[0]?.name ?? null) : null;

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
        <DetailHeaderOverlay />
      </View>
    );
  }

  if (state.place === null) {
    return (
      <View className="flex-1 items-center justify-center bg-bg">
        <DetailHeaderOverlay />
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
      <ScrollView
        className="flex-1 bg-bg"
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* Full-bleed hero. Photo extends behind the transparent nav header,
            with bottom corners rounded to read as a "card" against the body. */}
        <View
          style={{
            width: '100%',
            aspectRatio: 4 / 5,
            backgroundColor: '#e2e8f0',
            overflow: 'hidden',
          }}
        >
          {photoUrl ? (
            <Image
              source={{ uri: photoUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View
              style={{
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="mappin.circle" size={48} tintColor="#94a3b8" />
            </View>
          )}

          {/* Real gradient — fades from transparent at the photo's
              vertical midpoint down to ~0.7 alpha at the bottom so the
              title and meta row keep 4.5:1 contrast against any photo. */}
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.7)']}
            locations={[0, 0.55, 1]}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '65%',
            }}
          />

          {/* Trip chip — top-right, aligned with the back button. */}
          {tripName ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                top: insets.top + 8,
                right: 14,
              }}
            >
              <TripChip name={tripName} variant="overlay" />
            </View>
          ) : null}

          {/* Title stack — sits at the bottom of the photo over the dark
              overlay. Category chip → name → meta row. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 16,
              right: 16,
              bottom: 22,
            }}
          >
            {place.category ? (
              <View style={{ alignSelf: 'flex-start', marginBottom: 10 }}>
                <OverlayCategoryChip category={place.category} />
              </View>
            ) : null}
            <Text
              style={{
                fontSize: 30,
                fontWeight: '700',
                color: '#ffffff',
                letterSpacing: -0.6,
                lineHeight: 34,
                textShadowColor: 'rgba(0,0,0,0.45)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 4,
              }}
            >
              {place.name}
            </Text>
            <HeroMetaRow
              city={place.city}
              rating={place.rating}
              priceLevel={place.priceLevel}
            />
          </View>
        </View>

        {/* Side-by-side primary actions. */}
        <View
          style={{
            flexDirection: 'row',
            paddingHorizontal: 14,
            paddingTop: 14,
            gap: 8,
          }}
        >
          <Pressable
            onPress={onOpenInMaps}
            accessibilityRole="button"
            accessibilityLabel="Open in Maps"
            style={{
              flex: 1,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 6,
              paddingVertical: 12,
              borderRadius: 14,
              backgroundColor: '#14b8a6',
            }}
          >
            <Icon name="map.fill" size={16} tintColor="#ffffff" />
            <Text
              style={{ fontSize: 14, fontWeight: '600', color: '#ffffff' }}
            >
              Maps
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onAssignTrip(inTrip ? 'move' : 'assign')}
            accessibilityRole="button"
            accessibilityLabel={inTrip ? 'Move to trip' : 'Add to trip'}
            style={{
              flex: 1,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 6,
              paddingVertical: 12,
              borderRadius: 14,
              backgroundColor: 'rgba(15,23,42,0.06)',
              borderWidth: 1,
              borderColor: 'rgba(15,23,42,0.06)',
            }}
          >
            <Icon name="folder" size={16} tintColor="#0c4a6e" />
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#0c4a6e' }}>
              {inTrip ? 'Move trip' : 'Add to trip'}
            </Text>
          </Pressable>
        </View>

        {place.description ? (
          <View className="px-4 pb-4 pt-4">
            <Text className="text-[15px] leading-5 text-text">{place.description}</Text>
          </View>
        ) : null}

        {/* Metadata block. */}
        <View
          className="mx-4 mt-4 overflow-hidden rounded-2xl"
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

        {/* Footer destructive actions. */}
        <View className="px-4 pb-4 pt-4">
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
      <DetailHeaderOverlay />

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

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  food: { icon: 'fork.knife', label: 'Food' },
  activity: { icon: 'figure.walk', label: 'Activity' },
  place: { icon: 'mappin.circle', label: 'Place' },
};

// Photo-aware category pill — translucent dark fill with white text/icon
// for legibility against any image. Mirrors PlaceTile's overlay convention.
function OverlayCategoryChip({ category }: { category: string }) {
  const meta = CATEGORY_META[category];
  if (!meta) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: 'rgba(0,0,0,0.35)',
      }}
    >
      <Icon name={meta.icon} size={11} tintColor="#ffffff" />
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: '#ffffff',
          letterSpacing: 0.1,
        }}
      >
        {meta.label}
      </Text>
    </View>
  );
}

function HeroMetaRow({
  city,
  rating,
  priceLevel,
}: {
  city: string | null;
  rating: number | null;
  priceLevel: number | null;
}) {
  const parts: string[] = [];
  if (city) parts.push(city);
  if (rating !== null) parts.push(`★ ${rating.toFixed(1)}`);
  if (priceLevel !== null && priceLevel > 0) parts.push('$'.repeat(priceLevel));
  if (parts.length === 0) return null;
  return (
    <Text
      style={{
        marginTop: 4,
        fontSize: 14,
        fontWeight: '500',
        color: 'rgba(255,255,255,0.92)',
        textShadowColor: 'rgba(0,0,0,0.45)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
        fontVariant: ['tabular-nums'],
      }}
    >
      {parts.join('   ·   ')}
    </Text>
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
  return `${base.replace(/\/$/, '')}/${photoName}?w=1200&h=1500`;
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
