import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import { getTrip, useLiveQuery, type Trip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import { PlaceTile, type PlaceTileData } from '@/components/PlaceTile';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/EmptyState';
import { showCaptureActionSheet } from '@/components/CaptureActionSheet';
import {
  DetailHeaderIconButton,
  DetailHeaderOverlay,
} from '@/components/DetailHeaderOverlay';

const TRIP_SOURCES_SQL = `SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
                                 COALESCE(p.place_count, 0) AS place_count
                            FROM sources s
                       LEFT JOIN (
                              SELECT ps.source_id, COUNT(*) AS place_count
                                FROM place_sources ps
                            GROUP BY ps.source_id
                            ) p ON p.source_id = s.id
                           WHERE s.trip_id = ?
                        ORDER BY s.captured_at DESC`;

const TRIP_PLACES_SQL = `SELECT id, name, city, category, photo_name,
                                rating, price_level,
                                external_place_id, enrichment_status,
                                latitude, longitude, formatted_address
                           FROM places
                          WHERE trip_id = ?
                       ORDER BY enriched_at DESC NULLS LAST, created_at DESC`;

type ViewMode = 'grid' | 'map';

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useDatabase();
  const [trip, setTrip] = useState<Trip | null | 'loading'>('loading');
  const [tab, setTab] = useState<'photos' | 'places'>('places');
  const [view, setView] = useState<ViewMode>('grid');

  const sources = useLiveQuery<GridItem>(
    TRIP_SOURCES_SQL,
    id ? [id] : [],
    ['sources', 'place_sources'],
  );
  const places = useLiveQuery<PlaceTileData>(
    TRIP_PLACES_SQL,
    id ? [id] : [],
    ['places'],
  );

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    (async () => {
      const t = await getTrip(db, id);
      if (cancelled) return;
      setTrip(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  // Cover photo: highest-rated enriched place with a photo, falling back
  // to the first place with a photo.
  const coverPhotoUrl = useMemo(() => {
    if (!places) return null;
    const ranked = [...places]
      .filter((p) => p.photo_name)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    return ranked[0] ? buildCoverUrl(ranked[0].photo_name) : null;
  }, [places]);

  const headerRight = (
    <DetailHeaderIconButton
      icon="ellipsis"
      accessibilityLabel="Edit trip"
      onPress={() => router.push(`/trips/${id}/edit`)}
    />
  );

  if (trip === 'loading' || sources === null || places === null) {
    return (
      <View className="flex-1 bg-bg">
        <DetailHeaderOverlay right={headerRight} />
      </View>
    );
  }

  if (trip === null) {
    return (
      <>
        <View className="flex-1 items-center justify-center bg-bg">
          <DetailHeaderOverlay right={headerRight} />
          <Text className="text-base text-text-muted">Trip not found.</Text>
        </View>
      </>
    );
  }

  const empty = sources.length === 0 && places.length === 0;

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        className="flex-1 bg-bg"
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        <TripHero
          name={trip.name}
          coverPhotoUrl={coverPhotoUrl}
          placeCount={places.length}
        />

        {empty ? (
          <View className="pt-6 pb-16">
            <EmptyState
              icon="square.and.arrow.down"
              title="Nothing in this trip yet"
              body={`Capture screenshots, then assign them to “${trip.name}” from your Inbox.`}
              cta={{
                label: 'Add from Photos',
                onPress: () => {
                  if (db) showCaptureActionSheet(db);
                },
                accessibilityHint:
                  'Opens the camera roll to import screenshots into the inbox',
              }}
            />
          </View>
        ) : (
          <>
            {/* View toggle — Grid | Map. Map is "Coming soon" v1 (spec §4.5). */}
            <View className="pt-3">
              <ViewToggle view={view} onChange={setView} />
            </View>

            {view === 'map' ? (
              <View
                className="mx-4 mt-2 items-center justify-center rounded-2xl py-12"
                style={{ backgroundColor: 'rgba(15,23,42,0.04)' }}
              >
                <Icon name="map" size={28} tintColor="#94a3b8" />
                <Text
                  className="mt-2 text-text-muted"
                  style={{ fontSize: 13, fontWeight: '500' }}
                >
                  Map view coming soon
                </Text>
              </View>
            ) : (
              <>
                <SubTabToggle
                  tab={tab}
                  onChange={setTab}
                  placesCount={places.length}
                  sourcesCount={sources.length}
                />
                {tab === 'places' ? (
                  <View className="flex-row flex-wrap px-2.5 pt-1">
                    {places.map((p) => (
                      <View key={p.id} className="w-1/2 p-1">
                        <PlaceTile place={p} />
                      </View>
                    ))}
                  </View>
                ) : (
                  <PlaceGrid data={sources} />
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
      <DetailHeaderOverlay right={headerRight} />
    </>
  );
}

function TripHero({
  name,
  coverPhotoUrl,
  placeCount,
}: {
  name: string;
  coverPhotoUrl: string | null;
  placeCount: number;
}) {
  return (
    <View
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        backgroundColor: '#e2e8f0',
        overflow: 'hidden',
      }}
    >
      {coverPhotoUrl ? (
        <Image
          source={{ uri: coverPhotoUrl }}
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
          <Icon name="map" size={48} tintColor="#94a3b8" />
        </View>
      )}

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

      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 16, right: 16, bottom: 22 }}
      >
        <Text
          numberOfLines={2}
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
          {name}
        </Text>
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
          {placeCount} place{placeCount === 1 ? '' : 's'}
        </Text>
      </View>
    </View>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <View
      className="mx-4 flex-row rounded-full p-1"
      style={{
        backgroundColor: 'rgba(15,23,42,0.06)',
      }}
      accessibilityRole="tablist"
    >
      <ToggleSegment label="Grid" active={view === 'grid'} onPress={() => onChange('grid')} />
      <ToggleSegment
        label="Map"
        active={view === 'map'}
        onPress={() => onChange('map')}
      />
    </View>
  );
}

function ToggleSegment({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      className="flex-1 items-center rounded-full py-2"
      style={{
        backgroundColor: active ? '#ffffff' : 'transparent',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? '600' : '500',
          color: active ? '#0c4a6e' : '#475569',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SubTabToggle({
  tab,
  onChange,
  placesCount,
  sourcesCount,
}: {
  tab: 'photos' | 'places';
  onChange: (next: 'photos' | 'places') => void;
  placesCount: number;
  sourcesCount: number;
}) {
  return (
    <View className="flex-row gap-2 px-4 py-3">
      <SubTabButton
        label={`Places · ${placesCount}`}
        active={tab === 'places'}
        onPress={() => onChange('places')}
      />
      <SubTabButton
        label={`Sources · ${sourcesCount}`}
        active={tab === 'photos'}
        onPress={() => onChange('photos')}
      />
    </View>
  );
}

function SubTabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className="flex-1 items-center rounded-full px-4 py-2"
      style={{
        backgroundColor: active ? '#0c4a6e' : 'rgba(15,23,42,0.06)',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: active ? '600' : '500',
          color: active ? '#f8fafc' : '#475569',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function buildCoverUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=1200&h=1500`;
}
