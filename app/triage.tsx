import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList as RNFlatList,
  Modal,
  ScrollView as RNScrollView,
  useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, Text, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  deleteSource,
  isSourceProcessing,
  listInboxSources,
  useLiveQuery,
  type ProcessingStatus,
  type Source,
} from '@/modules/storage';
import { Icon } from '@/components/Icon';
import { CATEGORY_ICON, CATEGORY_LABEL, type PlaceCategory } from '@/components/PlaceTile';
import { SkeletonRow } from '@/components/Skeleton';
import { TripPicker } from '@/components/TripPicker';
import { useDatabase } from '@/components/useDatabase';
import { openSourceUrl } from '@/lib/openInSocial';
import { useThemeColors } from '@/tw/theme';

type ExtractedPlace = {
  source_id: string;
  place_id: string;
  name: string;
  city: string | null;
  category: PlaceCategory | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  photo_name: string | null;
  extracted_at: string;
};

const EXTRACTED_SQL = `SELECT ps.source_id, p.id AS place_id, p.name, p.city, p.category,
                              p.enrichment_status, p.photo_name, ps.extracted_at
                         FROM place_sources ps
                         JOIN places p ON p.id = ps.place_id
                     ORDER BY ps.extracted_at ASC`;

// Status for every untriaged source — the FlatList window can mount cards
// adjacent to the visible one, so we need per-id lookup, not just current.
const INBOX_STATUS_SQL = `SELECT id, ocr_status, extraction_status,
                                 extraction_paused_reason, url_fetch_paused_reason
                            FROM sources WHERE trip_id IS NULL`;
type SourceStatusRow = {
  id: string;
  ocr_status: ProcessingStatus;
  extraction_status: ProcessingStatus;
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
};
// Tri-state. 'loading' (status query unresolved or row not yet in the result
// set) renders identically to 'processing' so the user never flashes
// COULDN'T READ on cold mount — the source was just imported, so "still
// working" is the safer default.
type CardStatus = 'loading' | 'processing' | 'settled';

const NULL_CATEGORY_ICON = 'mappin.circle';

function categoryIconFor(category: PlaceCategory | null): string {
  return category ? CATEGORY_ICON[category] : NULL_CATEGORY_ICON;
}

// Approximate vertical extent of the CTA tray above the bottom safe-area
// inset. Used to pad the sheet's scrollable content and position the
// floating "Select all" pill above the tray. Update this if you change
// the tray layout.
const TRAY_HEIGHT = 110;

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
  const [preview, setPreview] = useState<Source | null>(null);

  // The hero is a fixed preview area, not a draggable surface. Kept short
  // so the place list — which can hold many extracted rows — gets the
  // bulk of the screen. Tap-to-fullscreen handles inspecting the image.
  const HERO_HEIGHT = Math.min(Math.round(height * 0.38), 360);

  // Live query so AI extraction surfacing mid-triage updates the bottom card.
  const extractedRows = useLiveQuery<ExtractedPlace>(
    EXTRACTED_SQL,
    [],
    ['place_sources', 'places'],
  );

  // OCR/extraction status for every untriaged source. Cheap (< ~50 rows in
  // practice) and avoids a per-card query that'd race with FlatList paging.
  const statusRows = useLiveQuery<SourceStatusRow>(INBOX_STATUS_SQL, [], ['sources']);

  const cardStatusById = useMemo(() => {
    const out = new Map<string, CardStatus>();
    if (statusRows === null) return out; // 'loading' resolved at lookup time
    for (const r of statusRows) {
      out.set(r.id, isSourceProcessing(r) ? 'processing' : 'settled');
    }
    return out;
  }, [statusRows]);

  const getCardStatus = useCallback(
    (sourceId: string): CardStatus => {
      // Status query unresolved, OR resolved but no row for this id yet
      // (race between insert and the next sweep) → 'loading'. Renders
      // identically to 'processing'.
      if (statusRows === null) return 'loading';
      return cardStatusById.get(sourceId) ?? 'loading';
    },
    [statusRows, cardStatusById],
  );

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
      const current = innerPrev ? (innerPrev.get(placeId) ?? true) : true;
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

  const onDelete = useCallback(() => {
    if (!items) return;
    const source = items[index];
    if (!source) return;
    const placesCount = (placesBySource[source.id] ?? []).length;
    const body =
      placesCount === 0
        ? "This can't be undone."
        : `${placesCount} place${placesCount === 1 ? '' : 's'} extracted from it will also be deleted. This can't be undone.`;
    Alert.alert(
      'Delete this source?',
      body,
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
            await deleteSource(db, source.id);
            // Same advance behaviour as the TripPicker save: drop this source
            // from the local list, snap to the next index (or close if last).
            setItems((prev) => prev?.filter((s) => s.id !== source.id) ?? prev);
            const remaining = (items?.length ?? 0) - 1;
            if (index >= remaining) {
              router.back();
            } else {
              listRef.current?.scrollToIndex({ index, animated: true });
            }
          },
        },
      ],
      { cancelable: true },
    );
  }, [db, index, items, placesBySource, router]);

  const current = items?.[index];

  if (!items || !current) {
    return (
      <View className="bg-bg flex-1">
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
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="bg-bg flex-1" accessibilityViewIsModal importantForAccessibility="yes">
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
              status={getCardStatus(item.id)}
              isSelected={(placeId) => isSelected(item.id, placeId)}
              onToggleOne={(placeId) => toggleOne(item.id, placeId)}
              bottomInset={insets.bottom + TRAY_HEIGHT + 16}
              topInset={insets.top}
              heroHeight={HERO_HEIGHT}
              onPreview={() => setPreview(item)}
            />
          )}
        />

        {/* Top: close on the left, count chip pinned to the right. */}
        <View
          className="absolute right-0 left-0 flex-row items-center justify-between px-4"
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

        <CtaTray
          totalCount={totalCount}
          selectedCount={selectedCount}
          bottomInset={insets.bottom}
          onPickTrip={() => setPickerVisible(true)}
          onSkip={onSkip}
          onDelete={onDelete}
        />

        {/* Rendered AFTER CtaTray so its gradient (which has 40pt of top
            padding sitting above the visible buttons) doesn't capture the
            tap. */}
        {totalCount > 0 ? (
          <Pressable
            onPress={() => setAllForSource(current.id, currentPlaces, allSelected ? false : true)}
            accessibilityRole="button"
            accessibilityLabel={allSelected ? 'Deselect all places' : 'Select all places'}
            hitSlop={8}
            className="absolute self-center rounded-full px-3 py-1.5"
            style={{
              // Sits inside the tray's transparent top fade so it reads as
              // attached to the "Choose a trip" button just below it.
              bottom: insets.bottom + TRAY_HEIGHT - 6,
              backgroundColor: 'rgba(15,23,42,0.85)',
            }}
          >
            <Text className="text-white" style={{ fontSize: 12, fontWeight: '600' }}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </Text>
          </Pressable>
        ) : null}

        <TripPicker
          visible={pickerVisible}
          entityId={current.id}
          entityKind="source"
          mode="assign"
          assignOptions={excludePlaceIds.length > 0 ? { excludePlaceIds } : undefined}
          onClose={async (result) => {
            setPickerVisible(false);
            if (!result) return;
            if (process.env.EXPO_OS === 'ios') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
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

      <FullscreenPreview source={preview} topInset={insets.top} onClose={() => setPreview(null)} />
    </>
  );
}

function FullscreenPreview({
  source,
  topInset,
  onClose,
}: {
  source: Source | null;
  topInset: number;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={source !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close preview"
          onPress={onClose}
          style={{ flex: 1 }}
        >
          {source?.filePath ? (
            <ExpoImage
              source={source.filePath}
              style={{ flex: 1 }}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          ) : null}
        </Pressable>
        <View className="absolute" style={{ top: topInset + 8, left: 16 }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close preview"
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
          >
            <Icon name="xmark" size={16} tintColor="#ffffff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function CountChip({ index, total }: { index: number; total: number }) {
  return (
    <View
      accessibilityLabel={`Source ${index + 1} of ${total}`}
      className="items-center justify-center rounded-full"
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
  status,
  isSelected,
  onToggleOne,
  bottomInset,
  topInset,
  heroHeight,
  onPreview,
}: {
  width: number;
  source: Source;
  places: ExtractedPlace[];
  status: CardStatus;
  isSelected: (placeId: string) => boolean;
  onToggleOne: (placeId: string) => void;
  bottomInset: number;
  topInset: number;
  heroHeight: number;
  onPreview: () => void;
}) {
  const colors = useThemeColors();
  const total = places.length;
  const inFlight = status === 'loading' || status === 'processing';
  const hasImage = source.filePath !== null;
  return (
    <View style={{ width, flex: 1 }}>
      <Pressable
        onPress={hasImage ? onPreview : undefined}
        accessibilityRole={hasImage ? 'button' : undefined}
        accessibilityLabel={hasImage ? 'View full image' : undefined}
        accessibilityHint={hasImage ? 'Opens the source image fullscreen' : undefined}
        style={{ marginTop: topInset }}
      >
        <View className="bg-surface" style={{ height: heroHeight, overflow: 'hidden' }}>
          {source.filePath ? (
            <ExpoImage
              source={source.filePath}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              cachePolicy="memory-disk"
            />
          ) : source.kind === 'url' && source.caption ? (
            <View className="bg-surface flex-1 items-center justify-center px-6">
              <Icon name="link" size={28} tintColor={colors.textMuted} />
              <Text
                className="text-text mt-3 text-center"
                style={{ fontSize: 14, lineHeight: 20 }}
                numberOfLines={6}
              >
                {source.caption}
              </Text>
            </View>
          ) : (
            <View className="flex-1 items-center justify-center">
              <Icon
                name={source.kind === 'url' ? 'link' : 'photo'}
                size={36}
                tintColor={colors.textMuted}
              />
            </View>
          )}
          {hasImage ? (
            <View className="absolute" style={{ bottom: 10, right: 10 }} pointerEvents="none">
              <View
                className="items-center justify-center rounded-full"
                style={{
                  width: 32,
                  height: 32,
                  backgroundColor: 'rgba(0,0,0,0.55)',
                }}
              >
                <Icon name="arrow.up.left.and.arrow.down.right" size={13} tintColor="#ffffff" />
              </View>
            </View>
          ) : null}
          {source.kind === 'url' && source.platform && source.url ? (
            <View className="absolute" style={{ top: 46, right: 10 }}>
              <Pressable
                onPress={() => {
                  if (process.env.EXPO_OS === 'ios') {
                    Haptics.selectionAsync().catch(() => {});
                  }
                  openSourceUrl(source.url!, source.platform).catch((err) => {
                    console.warn('[triage] openSourceUrl failed', err);
                  });
                }}
                accessibilityRole="button"
                accessibilityLabel={`Open in ${
                  source.platform === 'instagram' ? 'Instagram' : 'TikTok'
                }`}
                hitSlop={8}
                className="flex-row items-center rounded-full"
                style={{
                  paddingLeft: 10,
                  paddingRight: 11,
                  paddingVertical: 6,
                  backgroundColor: 'rgba(0,0,0,0.72)',
                  gap: 5,
                }}
              >
                <Icon name="arrow.up.right.square.fill" size={12} tintColor="#ffffff" />
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    color: '#ffffff',
                    letterSpacing: 0.2,
                  }}
                >
                  {source.platform === 'instagram' ? 'Instagram' : 'TikTok'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Pressable>

      <View className="bg-bg flex-1">
        <RNScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: bottomInset }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="px-4 pt-3 pb-2">
            {inFlight ? (
              <Text
                className="text-info-text"
                style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}
              >
                PROCESSING…
              </Text>
            ) : total > 0 ? (
              <Text
                className="text-info-text"
                style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}
              >
                ✦ {total} {total === 1 ? 'PLACE FOUND' : 'PLACES FOUND'}
              </Text>
            ) : (
              <Text
                className="text-text-muted"
                style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }}
              >
                COULDN&apos;T READ
              </Text>
            )}
            {!inFlight && total === 0 ? (
              <Text className="text-text-muted mt-1" style={{ fontSize: 13 }}>
                Save it anyway and label it later.
              </Text>
            ) : null}
          </View>

          {!inFlight && total > 0 ? (
            <View className="px-4 pt-3 pb-1">
              <Text
                className="text-text-muted"
                style={{
                  fontSize: 11,
                  fontWeight: '600',
                  letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}
              >
                Add to trip
              </Text>
            </View>
          ) : null}

          {inFlight ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : (
            places.map((p) => (
              <PlaceSelectRow
                key={p.place_id}
                place={p}
                checked={isSelected(p.place_id)}
                onToggle={() => onToggleOne(p.place_id)}
              />
            ))
          )}
        </RNScrollView>
      </View>
    </View>
  );
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
  const colors = useThemeColors();
  const photoUrl = buildPhotoUrl(place.enrichment_status === 'enriched' ? place.photo_name : null);
  const subtitle = [place.city, prettyCategory(place.category)].filter(Boolean).join(' · ');
  const categoryIcon = categoryIconFor(place.category);

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={place.city ? `${place.name}, ${place.city}` : place.name}
      style={{ opacity: checked ? 1 : 0.45, borderBottomWidth: 1 }}
      className="border-hairline flex-row items-center gap-3 px-4 py-3"
    >
      {photoUrl ? (
        <ExpoImage
          source={{ uri: photoUrl }}
          style={{ width: 44, height: 44, borderRadius: 10 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View className="bg-surface h-11 w-11 items-center justify-center rounded-[10px]">
          <Icon name={categoryIcon} size={20} tintColor={colors.text} />
        </View>
      )}
      <View className="flex-1">
        <Text
          className="text-text"
          style={{
            fontSize: 15,
            fontWeight: '600',
            textDecorationLine: checked ? 'none' : 'line-through',
            textDecorationColor: colors.textMuted,
          }}
          numberOfLines={1}
        >
          {place.name}
        </Text>
        {subtitle ? (
          <Text className="text-text-muted mt-0.5" style={{ fontSize: 12 }} numberOfLines={1}>
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
          backgroundColor: checked ? colors.accent : 'transparent',
          borderWidth: checked ? 0 : 2,
          borderColor: colors.textMuted,
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
  onDelete,
}: {
  totalCount: number;
  selectedCount: number;
  bottomInset: number;
  onPickTrip: () => void;
  onSkip: () => void;
  onDelete: () => void;
}) {
  // Sheet body lives on the `bg-bg` surface, so the fade-into-tray gradient
  // has to use the active bg color instead of always-white. We pull the JS
  // mirror of the bg token from the palette so the gradient stops swap with
  // the system theme.
  const colors = useThemeColors();
  const bgRgba = (alpha: number) =>
    colors.bg === '#020617' ? `rgba(2,6,23,${alpha})` : `rgba(255,255,255,${alpha})`;
  return (
    <View className="absolute right-0 bottom-0 left-0" pointerEvents="box-none">
      <LinearGradient
        colors={[bgRgba(0), bgRgba(0.96)]}
        locations={[0, 0.55]}
        style={{
          paddingTop: 24,
          paddingHorizontal: 16,
          paddingBottom: bottomInset + 6,
        }}
      >
        <Pressable
          onPress={onPickTrip}
          accessibilityRole="button"
          accessibilityLabel="Choose a trip"
          accessibilityHint="Picks a trip and saves the selected places"
          className="bg-accent flex-row items-center justify-between rounded-2xl px-4"
          style={{ paddingVertical: 14 }}
        >
          <View className="flex-row items-center gap-2">
            <Icon name="folder.fill" size={16} tintColor="#ffffff" />
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#ffffff' }}>Choose a trip</Text>
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

        {/* Secondary actions share a row, separated by a hairline — iOS
            alert-style. Saves vertical space vs. stacked pill buttons. */}
        <View className="mt-1 flex-row items-center">
          <Pressable
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel="Skip for now"
            accessibilityHint="Leaves this source in the inbox and goes to the next"
            className="flex-1 items-center justify-center"
            style={{ paddingVertical: 10 }}
            hitSlop={8}
          >
            <Text className="text-text" style={{ fontSize: 14, fontWeight: '600' }}>
              Skip for now
            </Text>
          </Pressable>
          <View
            style={{
              width: 1,
              height: 18,
              backgroundColor: colors.hairline,
            }}
          />
          <Pressable
            onPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel="Delete source"
            accessibilityHint="Permanently delete this source and any extracted places."
            className="flex-1 items-center justify-center"
            style={{ paddingVertical: 10 }}
            hitSlop={8}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#dc2626' }}>Delete</Text>
          </Pressable>
        </View>
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
  return category ? CATEGORY_LABEL[category] : '';
}
