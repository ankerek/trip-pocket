import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { useEntitlement } from '@/lib/entitlement/provider';
import { openLapsePaywall } from '@/lib/paywall/openLapsePaywall';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { getTrip, useLiveQuery, PROCESSING_SOURCES_WHERE, type Trip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { PlaceGrid, type GridItem } from '@/components/PlaceGrid';
import {
  PlaceTile,
  type PlaceTileData,
  type PlaceCategory,
  CATEGORY_ICON,
  CATEGORY_LABEL,
} from '@/components/PlaceTile';
import { ProcessingBanner } from '@/components/ProcessingBanner';
import { FilterPills, type FilterOption } from '@/components/FilterPills';
import { Icon } from '@/components/Icon';
import { EmptyState } from '@/components/EmptyState';
import { pickPhotosForImport } from '@/components/pickPhotos';
import { DetailHeaderIconButton, DetailHeaderOverlay } from '@/components/DetailHeaderOverlay';
import { cn } from '@/tw/cn';
import { useThemeColors } from '@/tw/theme';

// Fixed taxonomy order — pills render in this sequence regardless of count,
// so a trip's pill row layout is stable as places get added or filtered.
const CATEGORY_ORDER: readonly PlaceCategory[] = [
  'food',
  'drinks',
  'stays',
  'sights',
  'activities',
  'shops',
];
const ALL_CATEGORY_FILTER = '__all__';

const TRIP_SOURCES_SQL = `SELECT s.id, s.file_path, s.ocr_status, s.extraction_status,
                                 s.extraction_paused_reason, s.url_fetch_paused_reason,
                                 s.extraction_strategy,
                                 COALESCE(p.place_count, 0) AS place_count
                            FROM sources s
                       LEFT JOIN (
                              SELECT ps.source_id, COUNT(*) AS place_count
                                FROM place_sources ps
                            GROUP BY ps.source_id
                            ) p ON p.source_id = s.id
                           WHERE s.trip_id = ?
                        ORDER BY s.captured_at DESC`;

const TRIP_PLACES_SQL = `SELECT id, name, city, country_code, category, photo_name,
                                rating, price_level,
                                external_place_id, enrichment_status,
                                latitude, longitude, formatted_address
                           FROM places
                          WHERE trip_id = ?
                       ORDER BY COALESCE(enriched_at, created_at) DESC, created_at DESC`;

// Global source-level in-flight count — same semantics as the Pocket banner.
// Not filtered by trip: OCR/extraction run regardless of trip assignment, and
// keeping both screens on the same signal avoids divergent UX.
const PROCESSING_COUNT_SQL = `SELECT COUNT(*) AS n
                                FROM sources
                               WHERE ${PROCESSING_SOURCES_WHERE}`;

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const db = useDatabase();
  const { status: entitlementStatus } = useEntitlement();
  const [trip, setTrip] = useState<Trip | null | 'loading'>('loading');
  const [tab, setTab] = useState<'photos' | 'places'>('places');
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORY_FILTER);

  const sources = useLiveQuery<GridItem>(TRIP_SOURCES_SQL, id ? [id] : [], [
    'sources',
    'place_sources',
  ]);
  const places = useLiveQuery<PlaceTileData>(TRIP_PLACES_SQL, id ? [id] : [], ['places']);
  const processingRows = useLiveQuery<{ n: number }>(PROCESSING_COUNT_SQL, [], ['sources']);
  const processingCount = processingRows?.[0]?.n ?? 0;

  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<PlaceCategory, number>> = {};
    for (const p of places ?? []) {
      if (p.category) counts[p.category] = (counts[p.category] ?? 0) + 1;
    }
    return counts;
  }, [places]);

  const categoryFilterOptions = useMemo<FilterOption[]>(() => {
    if (!places) return [];
    const opts: FilterOption[] = [{ id: ALL_CATEGORY_FILTER, label: 'All', count: places.length }];
    for (const cat of CATEGORY_ORDER) {
      const count = categoryCounts[cat];
      if (count) {
        opts.push({ id: cat, label: CATEGORY_LABEL[cat], count, icon: CATEGORY_ICON[cat] });
      }
    }
    return opts;
  }, [places, categoryCounts]);

  // If the selected category no longer has any places (e.g. user deleted
  // the last one via place detail), the pill disappears — fall back to
  // "All" for both the filter and the highlighted pill, derived inline so
  // we don't need a useEffect to sync state.
  const effectiveCategoryFilter =
    categoryFilter === ALL_CATEGORY_FILTER ||
    categoryCounts[categoryFilter as PlaceCategory] !== undefined
      ? categoryFilter
      : ALL_CATEGORY_FILTER;

  const filteredPlaces = useMemo(() => {
    if (!places) return [];
    if (effectiveCategoryFilter === ALL_CATEGORY_FILTER) return places;
    return places.filter((p) => p.category === effectiveCategoryFilter);
  }, [places, effectiveCategoryFilter]);

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

  const onAddFromPhotos = () => {
    if (!db || !id) return;
    if (process.env.EXPO_OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    if (entitlementStatus === 'inactive') {
      openLapsePaywall(router, pathname);
      return;
    }
    void pickPhotosForImport(db, {
      tripId: id,
      getEntitlementStatus: () => entitlementStatus,
    }).then((outcome) => {
      if (outcome.entitlementRequired) openLapsePaywall(router, pathname);
    });
  };

  const headerRight = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <DetailHeaderIconButton
        icon="plus"
        accessibilityLabel="Add photos to this trip"
        onPress={onAddFromPhotos}
      />
      <DetailHeaderIconButton
        icon="ellipsis"
        accessibilityLabel="Edit trip"
        onPress={() => router.push(`/trips/${id}/edit`)}
      />
    </View>
  );

  if (trip === 'loading' || sources === null || places === null || processingRows === null) {
    return (
      <View className="bg-bg flex-1">
        <DetailHeaderOverlay right={headerRight} />
      </View>
    );
  }

  if (trip === null) {
    return (
      <>
        <View className="bg-bg flex-1 items-center justify-center">
          <DetailHeaderOverlay right={headerRight} />
          <Text className="text-text-muted text-base">Trip not found.</Text>
        </View>
      </>
    );
  }

  const empty = sources.length === 0 && places.length === 0;

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        className="bg-bg flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
      >
        <TripHero name={trip.name} coverPhotoUrl={coverPhotoUrl} placeCount={places.length} />

        <ProcessingBanner count={processingCount} />

        {empty ? (
          <View className="pt-6 pb-16">
            <EmptyState
              icon="square.and.arrow.down"
              title="Nothing in this trip yet"
              body={`Add photos from your library — they'll be assigned to “${trip.name}” automatically.`}
              cta={{
                label: 'Add from Photos',
                onPress: onAddFromPhotos,
                accessibilityHint: 'Imports photos from your library into this trip',
              }}
            />
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
              <>
                {/* Hide the pill row when only the "All" entry exists —
                    no categories means nothing to filter. */}
                {categoryFilterOptions.length > 1 ? (
                  <FilterPills
                    options={categoryFilterOptions}
                    selectedId={effectiveCategoryFilter}
                    onSelect={setCategoryFilter}
                  />
                ) : null}
                <PlacesGrid places={filteredPlaces} />
              </>
            ) : (
              <PlaceGrid data={sources} />
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
  const colors = useThemeColors();
  return (
    <View
      className="bg-surface"
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
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
          <Icon name="map" size={48} tintColor={colors.textMuted} />
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

      <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: 22 }}>
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
  // Active uses the accent token (teal) so it stays vivid against both
  // a light and a dark page surface. Inactive uses the hairline tint.
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={cn(
        'flex-1 items-center rounded-full px-4 py-2',
        active ? 'bg-accent' : 'bg-hairline',
      )}
    >
      <Text
        className={active ? 'text-white' : 'text-text-muted'}
        style={{ fontSize: 13, fontWeight: active ? '600' : '500' }}
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

// Flat 2-col grid of places. No section headers — categories surface via
// the filter pill row above, not via grouping.
function PlacesGrid({ places }: { places: PlaceTileData[] }) {
  if (places.length === 0) return null;
  return (
    <View className="flex-row flex-wrap px-2.5 pt-1">
      {places.map((p) => (
        <View key={p.id} className="w-1/2 p-1">
          <PlaceTile place={p} />
        </View>
      ))}
    </View>
  );
}
