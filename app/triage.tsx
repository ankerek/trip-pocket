import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList as RNFlatList,
  ScrollView as RNScrollView,
  useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Pressable, Text, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { listInboxSources, useLiveQuery, type Source } from '@/modules/storage';
import { Icon } from '@/components/Icon';
import { TripPicker } from '@/components/TripPicker';
import { useDatabase } from '@/components/useDatabase';
import { formatCapturedAt } from '@/lib/relativeTime';

type ExtractedPlace = {
  source_id: string;
  place_id: string;
  name: string;
  city: string | null;
  category: 'place' | 'food' | 'activity' | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  photo_name: string | null;
  extracted_at: string;
};

const EXTRACTED_SQL = `SELECT ps.source_id, p.id AS place_id, p.name, p.city, p.category,
                              p.enrichment_status, p.photo_name, ps.extracted_at
                         FROM place_sources ps
                         JOIN places p ON p.id = ps.place_id
                        WHERE ps.deleted_at IS NULL AND p.deleted_at IS NULL
                     ORDER BY ps.extracted_at ASC`;

const CATEGORY_ICON: Record<NonNullable<ExtractedPlace['category']> | 'null', string> = {
  food: 'fork.knife',
  activity: 'figure.walk',
  place: 'mappin.circle',
  null: 'mappin.circle',
};

const TRAY_HEIGHT = 138;
const HERO_MIN = 260;

type SelectionMap = Map<string, Map<string, boolean>>;

export default function Triage() {
  const router = useRouter();
  const db = useDatabase();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<RNFlatList<Source>>(null);

  const [items, setItems] = useState<Source[] | null>(null);
  const [index, setIndex] = useState(0);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [selections, setSelections] = useState<SelectionMap>(new Map());

  // Expandable-hero shared state. The grabber pan drives heroHeight; both
  // hero and sheet read it.
  const HERO_MAX = Math.min(height * 0.7, height - insets.top - TRAY_HEIGHT - insets.bottom - 60);
  const heroHeight = useSharedValue(HERO_MIN);

  // Live query so AI extraction surfacing mid-triage updates the bottom card.
  const extractedRows = useLiveQuery<ExtractedPlace>(EXTRACTED_SQL, [], [
    'place_sources',
    'places',
  ]);

  const placesBySource = useMemo(() => {
    const out: Record<string, ExtractedPlace[]> = {};
    for (const row of extractedRows ?? []) {
      const bucket = out[row.source_id] ?? [];
      bucket.push(row);
      out[row.source_id] = bucket;
    }
    return out;
  }, [extractedRows]);

  useEffect(() => {
    let cancelled = false;
    if (!db) return;
    listInboxSources(db).then((rows) => {
      if (cancelled) return;
      setItems(rows);
      if (rows.length === 0) router.back();
    });
    return () => {
      cancelled = true;
    };
  }, [db, router]);

  const isSelected = useCallback(
    (sourceId: string, placeId: string): boolean => {
      const override = selections.get(sourceId);
      if (!override) return true;
      const v = override.get(placeId);
      return v ?? true;
    },
    [selections],
  );

  const toggleOne = useCallback((sourceId: string, placeId: string) => {
    if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
    setSelections((prev) => {
      const next = new Map(prev);
      const innerPrev = prev.get(sourceId);
      const inner = new Map(innerPrev ?? new Map());
      const current = innerPrev ? innerPrev.get(placeId) ?? true : true;
      inner.set(placeId, !current);
      next.set(sourceId, inner);
      return next;
    });
  }, []);

  const setAllForSource = useCallback(
    (sourceId: string, places: ExtractedPlace[], value: boolean) => {
      if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
      setSelections((prev) => {
        const next = new Map(prev);
        const inner = new Map<string, boolean>();
        for (const p of places) inner.set(p.place_id, value);
        next.set(sourceId, inner);
        return next;
      });
    },
    [],
  );

  const advanceOrClose = useCallback(() => {
    if (!items) return;
    const next = index + 1;
    if (next >= items.length) {
      router.back();
      return;
    }
    setIndex(next);
    listRef.current?.scrollToIndex({ index: next, animated: true });
  }, [index, items, router]);

  const onSkip = () => {
    if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
    advanceOrClose();
  };

  const tapHaptic = useCallback(() => {
    if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
  }, []);

  // Per-card pan gestures live inside `TriageCard`; they share the
  // `heroHeight` value at the parent so swiping between sources keeps
  // the expanded state.

  const current = items?.[index];

  if (!items || !current) {
    return (
      <View className="flex-1 bg-bg">
        <Stack.Screen options={{ headerShown: false }} />
      </View>
    );
  }

  const currentPlaces = placesBySource[current.id] ?? [];
  const selectedCount = currentPlaces.reduce(
    (n, p) => (isSelected(current.id, p.place_id) ? n + 1 : n),
    0,
  );
  const totalCount = currentPlaces.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const excludePlaceIds = currentPlaces
    .filter((p) => !isSelected(current.id, p.place_id))
    .map((p) => p.place_id);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        className="flex-1 bg-bg"
        accessibilityViewIsModal
        importantForAccessibility="yes"
      >
        <RNFlatList
          ref={listRef}
          data={items}
          keyExtractor={(s) => s.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={!pickerVisible}
          onMomentumScrollEnd={(e) => {
            const next = Math.round(e.nativeEvent.contentOffset.x / width);
            if (next !== index) setIndex(next);
          }}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          renderItem={({ item }) => (
            <TriageCard
              width={width}
              source={item}
              places={placesBySource[item.id] ?? []}
              isSelected={(placeId) => isSelected(item.id, placeId)}
              onToggleOne={(placeId) => toggleOne(item.id, placeId)}
              bottomInset={insets.bottom + TRAY_HEIGHT + 16}
              heroHeight={heroHeight}
              heroMin={HERO_MIN}
              heroMax={HERO_MAX}
              onSnapHaptic={tapHaptic}
            />
          )}
        />

        {/* Top: close on the left, count chip pinned to the right. */}
        <View
          className="absolute left-0 right-0 flex-row items-center justify-between px-4"
          style={{ top: insets.top + 8 }}
          pointerEvents="box-none"
        >
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close triage"
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          >
            <Icon name="xmark" size={16} tintColor="#ffffff" />
          </Pressable>
          <CountChip index={index} total={items.length} />
        </View>

        {totalCount > 0 ? (
          <Pressable
            onPress={() =>
              setAllForSource(current.id, currentPlaces, allSelected ? false : true)
            }
            accessibilityRole="button"
            accessibilityLabel={allSelected ? 'Deselect all places' : 'Select all places'}
            hitSlop={8}
            className="absolute self-center rounded-full px-3 py-1.5"
            style={{
              bottom: insets.bottom + TRAY_HEIGHT + 22,
              backgroundColor: 'rgba(15,23,42,0.85)',
            }}
          >
            <Text className="text-white" style={{ fontSize: 12, fontWeight: '600' }}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </Text>
          </Pressable>
        ) : null}

        <CtaTray
          totalCount={totalCount}
          selectedCount={selectedCount}
          bottomInset={insets.bottom}
          onPickTrip={() => setPickerVisible(true)}
          onSkip={onSkip}
        />

        <TripPicker
          visible={pickerVisible}
          entityId={current.id}
          entityKind="source"
          mode="assign"
          assignOptions={
            excludePlaceIds.length > 0 ? { excludePlaceIds } : undefined
          }
          onClose={async (result) => {
            setPickerVisible(false);
            if (!result) return;
            if (process.env.EXPO_OS === 'ios') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
                () => {},
              );
            }
            setSelections((prev) => {
              if (!prev.has(current.id)) return prev;
              const next = new Map(prev);
              next.delete(current.id);
              return next;
            });
            setItems((prev) => prev?.filter((s) => s.id !== current.id) ?? prev);
            const remaining = (items?.length ?? 0) - 1;
            if (index >= remaining) {
              router.back();
            } else {
              listRef.current?.scrollToIndex({ index, animated: true });
            }
          }}
        />
      </View>
    </GestureHandlerRootView>
  );
}

function CountChip({ index, total }: { index: number; total: number }) {
  return (
    <View
      accessibilityLabel={`Source ${index + 1} of ${total}`}
      className="rounded-full items-center justify-center"
      style={{
        height: 30,
        paddingHorizontal: 12,
        backgroundColor: 'rgba(15,23,42,0.85)',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: '600',
          fontVariant: ['tabular-nums'],
          color: 'rgba(255,255,255,0.7)',
          includeFontPadding: false,
        }}
      >
        <Text style={{ color: '#ffffff', fontWeight: '700' }}>{index + 1}</Text>
        {' of '}
        {total}
      </Text>
    </View>
  );
}

function TriageCard({
  width,
  source,
  places,
  isSelected,
  onToggleOne,
  bottomInset,
  heroHeight,
  heroMin,
  heroMax,
  onSnapHaptic,
}: {
  width: number;
  source: Source;
  places: ExtractedPlace[];
  isSelected: (placeId: string) => boolean;
  onToggleOne: (placeId: string) => void;
  bottomInset: number;
  heroHeight: SharedValue<number>;
  heroMin: number;
  heroMax: number;
  onSnapHaptic: () => void;
}) {
  const total = places.length;
  // The hero stays at heroMax behind the sheet; expanding/collapsing
  // animates the sheet's translateY only. Animating layout (`height`) here
  // was very laggy because every shared-value tick re-ran Yoga across the
  // entire subtree (and across every TriageCard mounted in the paging
  // window). transform/opacity stays on the fast path.
  const sheetAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: heroHeight.value - heroMin }],
  }));
  // Both the hero and the grabber drive the same heroHeight via identical
  // pan logic. Two Gesture.Pan() instances are needed because each
  // GestureDetector takes its own. Internal state (`startHeight`) is shared
  // — only one gesture is active at a time.
  const startHeight = useSharedValue(heroMin);
  const heroPan = useMemo(
    () => buildHeroPan({ heroHeight, heroMin, heroMax, startHeight, onSnapHaptic }),
    [heroHeight, heroMin, heroMax, startHeight, onSnapHaptic],
  );
  const grabberPan = useMemo(
    () => buildHeroPan({ heroHeight, heroMin, heroMax, startHeight, onSnapHaptic }),
    [heroHeight, heroMin, heroMax, startHeight, onSnapHaptic],
  );
  return (
    <View style={{ width, flex: 1 }}>
      {/* Hero — fixed at heroMax, sits behind the sheet. The visible
          portion is whatever isn't covered by the sheet, so dragging the
          sheet down "reveals" more hero without any layout work. */}
      <GestureDetector gesture={heroPan}>
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: heroMax,
            backgroundColor: '#0c4a6e',
            overflow: 'hidden',
          }}
        >
          {source.filePath ? (
            <ExpoImage
              source={source.filePath}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <Icon name="photo" size={36} tintColor="#94a3b8" />
            </View>
          )}
        </View>
      </GestureDetector>

      {/* Sheet — fixed-size, slides via translateY. */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: heroMin,
            left: 0,
            right: 0,
            bottom: 0,
          },
          sheetAnimStyle,
        ]}
      >
        <View className="flex-1 bg-bg">
        <GestureDetector gesture={grabberPan}>
          <View
            className="items-center"
            style={{ paddingTop: 8, paddingBottom: 4 }}
            accessibilityRole="adjustable"
            accessibilityLabel="Drag to resize the screenshot"
          >
            <View
              style={{
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: 'rgba(15,23,42,0.18)',
              }}
            />
          </View>
        </GestureDetector>

        <RNScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: bottomInset }}
          // Keyboard isn't likely here, but keep this safe.
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-4 pt-1 pb-2">
            {total > 0 ? (
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#0f766e',
                  letterSpacing: 0.6,
                }}
              >
                ✦ {total} {total === 1 ? 'PLACE FOUND' : 'PLACES FOUND'}
              </Text>
            ) : (
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '700',
                  color: '#64748b',
                  letterSpacing: 0.6,
                }}
              >
                COULDN'T READ
              </Text>
            )}
            <Text
              className="text-text mt-1"
              style={{ fontSize: 16, fontWeight: '700', letterSpacing: -0.2 }}
              numberOfLines={1}
            >
              {formatCapturedAt(source.capturedAt)}
            </Text>
            {total === 0 ? (
              <Text className="text-text-muted mt-1" style={{ fontSize: 13 }}>
                Save it anyway and label it later.
              </Text>
            ) : null}
          </View>

          {total > 0 ? (
            <View className="px-4 pt-3 pb-1">
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '600',
                  color: '#64748b',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Add to trip
              </Text>
            </View>
          ) : null}

          {places.map((p) => (
            <PlaceSelectRow
              key={p.place_id}
              place={p}
              checked={isSelected(p.place_id)}
              onToggle={() => onToggleOne(p.place_id)}
            />
          ))}
        </RNScrollView>
        </View>
      </Animated.View>
    </View>
  );
}

function buildHeroPan({
  heroHeight,
  heroMin,
  heroMax,
  startHeight,
  onSnapHaptic,
}: {
  heroHeight: SharedValue<number>;
  heroMin: number;
  heroMax: number;
  startHeight: SharedValue<number>;
  onSnapHaptic: () => void;
}) {
  return Gesture.Pan()
    .activeOffsetY([-8, 8])
    .failOffsetX([-12, 12])
    .onStart(() => {
      startHeight.value = heroHeight.value;
    })
    .onUpdate((e) => {
      const next = startHeight.value + e.translationY;
      heroHeight.value = Math.max(heroMin, Math.min(heroMax, next));
    })
    .onEnd((e) => {
      const mid = (heroMin + heroMax) / 2;
      const goingDown =
        e.velocityY > 300 || (e.velocityY > -300 && heroHeight.value > mid);
      const target = goingDown ? heroMax : heroMin;
      heroHeight.value = withSpring(target, { damping: 20, stiffness: 180 });
      runOnJS(onSnapHaptic)();
    });
}

function PlaceSelectRow({
  place,
  checked,
  onToggle,
}: {
  place: ExtractedPlace;
  checked: boolean;
  onToggle: () => void;
}) {
  const photoUrl = buildPhotoUrl(
    place.enrichment_status === 'enriched' ? place.photo_name : null,
  );
  const subtitle = [place.city, prettyCategory(place.category)]
    .filter(Boolean)
    .join(' · ');
  const categoryIcon = CATEGORY_ICON[place.category ?? 'null'];

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={place.city ? `${place.name}, ${place.city}` : place.name}
      style={{ opacity: checked ? 1 : 0.45 }}
      className="flex-row items-center gap-3 border-b border-slate-100 px-4 py-3"
    >
      {photoUrl ? (
        <ExpoImage
          source={{ uri: photoUrl }}
          style={{ width: 44, height: 44, borderRadius: 10 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View className="h-11 w-11 items-center justify-center rounded-[10px] bg-slate-100">
          <Icon name={categoryIcon} size={20} tintColor="#0f172a" />
        </View>
      )}
      <View className="flex-1">
        <Text
          className="text-slate-900"
          style={{
            fontSize: 15,
            fontWeight: '600',
            textDecorationLine: checked ? 'none' : 'line-through',
            textDecorationColor: 'rgba(15,23,42,0.4)',
          }}
          numberOfLines={1}
        >
          {place.name}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-slate-500" style={{ fontSize: 12 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View
        className="items-center justify-center"
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          backgroundColor: checked ? '#14b8a6' : 'transparent',
          borderWidth: checked ? 0 : 2,
          borderColor: 'rgba(15,23,42,0.2)',
        }}
        importantForAccessibility="no"
        accessibilityElementsHidden
      >
        {checked ? <Icon name="checkmark" size={14} tintColor="#ffffff" /> : null}
      </View>
    </Pressable>
  );
}

function CtaTray({
  totalCount,
  selectedCount,
  bottomInset,
  onPickTrip,
  onSkip,
}: {
  totalCount: number;
  selectedCount: number;
  bottomInset: number;
  onPickTrip: () => void;
  onSkip: () => void;
}) {
  return (
    <View className="absolute left-0 right-0 bottom-0" pointerEvents="box-none">
      <LinearGradient
        colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.96)']}
        locations={[0, 0.55]}
        style={{
          paddingTop: 40,
          paddingHorizontal: 16,
          paddingBottom: bottomInset + 16,
        }}
      >
        <Pressable
          onPress={onPickTrip}
          accessibilityRole="button"
          accessibilityLabel="Choose a trip"
          accessibilityHint="Picks a trip and saves the selected places"
          className="flex-row items-center justify-between rounded-2xl px-4 py-4"
          style={{ backgroundColor: '#14b8a6' }}
        >
          <View className="flex-row items-center gap-2">
            <Icon name="folder.fill" size={16} tintColor="#ffffff" />
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#ffffff' }}>
              Choose a trip
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            {totalCount > 0 ? (
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: '500',
                  color: 'rgba(255,255,255,0.85)',
                }}
              >
                Adding {selectedCount} of {totalCount}
              </Text>
            ) : null}
            <Icon name="chevron.right" size={14} tintColor="rgba(255,255,255,0.85)" />
          </View>
        </Pressable>

        <Pressable
          onPress={onSkip}
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
          accessibilityHint="Leaves this screenshot in the inbox and goes to the next"
          className="mt-2 rounded-2xl items-center justify-center"
          style={{
            paddingVertical: 12,
            backgroundColor: 'rgba(15,23,42,0.05)',
            borderWidth: 1,
            borderColor: 'rgba(15,23,42,0.06)',
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#475569' }}>
            Skip for now
          </Text>
        </Pressable>
      </LinearGradient>
    </View>
  );
}

function buildPhotoUrl(photoName: string | null): string | null {
  if (!photoName) return null;
  const base = Constants.expoConfig?.extra?.photoProxyUrlBase as string | undefined;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${photoName}?w=88&h=88`;
}

function prettyCategory(category: ExtractedPlace['category']): string {
  if (!category) return '';
  if (category === 'food') return 'Restaurant';
  if (category === 'activity') return 'Activity';
  return 'Place';
}
