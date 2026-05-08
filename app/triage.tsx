import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList as RNFlatList,
  KeyboardAvoidingView,
  useWindowDimensions,
} from 'react-native';
import {
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from '@/tw';
import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  listInboxSources,
  useLiveQuery,
  type Source,
} from '@/modules/storage';
import { Icon } from '@/components/Icon';
import { TripPicker } from '@/components/TripPicker';
import { useDatabase } from '@/components/useDatabase';

type ExtractedPlace = {
  source_id: string;
  place_id: string;
  name: string;
  city: string | null;
  category: 'place' | 'food' | 'activity' | null;
};

const EXTRACTED_SQL = `SELECT ps.source_id, p.id AS place_id, p.name, p.city, p.category
                         FROM place_sources ps
                         JOIN places p ON p.id = ps.place_id
                        WHERE ps.deleted_at IS NULL AND p.deleted_at IS NULL`;

export default function Triage() {
  const router = useRouter();
  const db = useDatabase();
  const { width } = useWindowDimensions();
  const listRef = useRef<RNFlatList<Source>>(null);

  const [items, setItems] = useState<Source[] | null>(null);
  const [index, setIndex] = useState(0);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Live query so AI extraction surfacing mid-triage updates the bottom card.
  const extractedRows = useLiveQuery<ExtractedPlace>(EXTRACTED_SQL, [], [
    'place_sources',
    'places',
  ]);

  const extractedBySource = useMemo(() => {
    const out: Record<string, ExtractedPlace> = {};
    for (const row of extractedRows ?? []) {
      // Keep the first extraction per source — usually the best one. The
      // user can edit a place individually from /places/[id] after triage.
      if (!out[row.source_id]) out[row.source_id] = row;
    }
    return out;
  }, [extractedRows]);

  // One-shot load of the inbox at modal open. We don't live-query on every
  // change — the user is sorting these one at a time and a snapshot keeps
  // the swipe pager stable while we mutate underlying rows.
  useEffect(() => {
    let cancelled = false;
    if (!db) return;
    listInboxSources(db).then((rows) => {
      if (cancelled) return;
      setItems(rows);
      if (rows.length === 0) {
        // Nothing to triage — pop out immediately. The Inbox banner that
        // routed us here only renders when count > 0, but a race with
        // ingest/share-extension can land us in an empty state.
        router.back();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [db, router]);

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
    if (process.env.EXPO_OS === 'ios') {
      Haptics.selectionAsync().catch(() => {});
    }
    advanceOrClose();
  };

  const current = items?.[index];

  if (!items || !current) {
    return (
      <View className="flex-1 bg-bg">
        <Stack.Screen options={{ headerShown: false }} />
      </View>
    );
  }

  return (
    <>
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
          // Disable scroll while the picker is open so a sheet pan doesn't
          // double as a horizontal swipe (spec §4.2 gesture rule).
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
              extracted={extractedBySource[item.id] ?? null}
              isCurrent={item.id === current.id}
            />
          )}
        />

        {/* Top overlay — close + progress, sits above the screenshot. */}
        <View
          className="absolute left-4 right-4 flex-row items-center justify-between"
          style={{ top: 56 }}
          pointerEvents="box-none"
        >
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close triage"
            hitSlop={12}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          >
            <Icon name="xmark" size={16} tintColor="#ffffff" />
          </Pressable>
          <View
            className="rounded-full px-3 py-1.5"
            style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          >
            <Text
              className="text-white"
              style={{ fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}
            >
              {index + 1} of {items.length}
            </Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        {/* Bottom action sheet — fixed-height v1; auto-grow on keyboard
            handled by KeyboardAvoidingView. Drag-to-snap is phase 7
            (spec §4.2). */}
        <KeyboardAvoidingView
          behavior="padding"
          className="absolute bottom-0 left-0 right-0"
          pointerEvents="box-none"
        >
          <TriageSheet
            source={current}
            extracted={extractedBySource[current.id] ?? null}
            onPickTrip={() => setPickerVisible(true)}
            onSkip={onSkip}
          />
        </KeyboardAvoidingView>

        <TripPicker
          visible={pickerVisible}
          entityId={current.id}
          entityKind="source"
          mode="assign"
          onClose={async (result) => {
            setPickerVisible(false);
            if (!result) return;
            if (process.env.EXPO_OS === 'ios') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            }
            // Optimistically remove the just-triaged item from the local
            // pager so the user doesn't see it again. The DB already has
            // trip_id set by TripPicker (it called assignSourceTrip).
            setItems((prev) => prev?.filter((s) => s.id !== current.id) ?? prev);
            // Stay on the same index — it now points at the next item.
            // If we just triaged the last one, close.
            const remaining = (items?.length ?? 0) - 1;
            if (index >= remaining) {
              router.back();
            } else {
              listRef.current?.scrollToIndex({ index, animated: true });
            }
          }}
        />
      </View>
    </>
  );
}

function TriageCard({
  width,
  source,
  extracted,
  isCurrent: _isCurrent,
}: {
  width: number;
  source: Source;
  extracted: ExtractedPlace | null;
  isCurrent: boolean;
}) {
  return (
    <View style={{ width, flex: 1 }}>
      {/* Hero screenshot fills the top half-and-then-some so the bottom
          sheet rests on top of the image rather than hiding it. */}
      {source.filePath ? (
        <Image
          source={source.filePath}
          style={{ width, aspectRatio: 1, backgroundColor: '#0c4a6e' }}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={{ width, aspectRatio: 1, backgroundColor: '#0c4a6e' }}
          className="items-center justify-center"
        >
          <Icon name="photo" size={36} tintColor="#94a3b8" />
        </View>
      )}
      {/* Faux-extracted badge so the user always sees what we know about
          this screenshot without dragging the sheet. */}
      {extracted ? null : (
        <View
          className="absolute right-4 rounded-full px-2.5 py-1"
          style={{ top: 100, backgroundColor: 'rgba(0,0,0,0.45)' }}
        >
          <Text
            style={{ fontSize: 11, fontWeight: '600', color: '#ffffff', letterSpacing: 0.4 }}
          >
            COULDN'T READ
          </Text>
        </View>
      )}
    </View>
  );
}

function TriageSheet({
  source: _source,
  extracted,
  onPickTrip,
  onSkip,
}: {
  source: Source;
  extracted: ExtractedPlace | null;
  onPickTrip: () => void;
  onSkip: () => void;
}) {
  return (
    <View
      className="rounded-t-2xl bg-bg"
      style={{
        paddingTop: 8,
        paddingBottom: 28,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: 'rgba(15,23,42,0.06)',
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: -6 },
      }}
    >
      <View
        className="self-center mb-3"
        style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(15,23,42,0.15)' }}
      />

      <ScrollView
        className="max-h-[60vh]"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {extracted ? (
          <>
            <View
              className="self-start rounded-full px-2.5 py-1"
              style={{
                backgroundColor: '#14b8a6',
              }}
            >
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: '700',
                  color: '#ffffff',
                  letterSpacing: 0.6,
                }}
              >
                ✦ AI EXTRACTED
              </Text>
            </View>
            <Text
              className="text-text mt-2"
              style={{ fontSize: 22, fontWeight: '700', letterSpacing: -0.3 }}
              numberOfLines={2}
            >
              {extracted.name}
            </Text>
            {extracted.city ? (
              <Text className="mt-0.5 text-text-muted" style={{ fontSize: 14 }}>
                {extracted.city}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Text
              className="text-text"
              style={{ fontSize: 22, fontWeight: '700', letterSpacing: -0.3 }}
            >
              Couldn't read
            </Text>
            <Text className="mt-0.5 text-text-muted" style={{ fontSize: 14 }}>
              Save it anyway and label it later.
            </Text>
          </>
        )}

        {/* Picking a trip is the save action — TripPicker calls
            assignSourceTrip on selection and we auto-advance to the
            next item in the onClose handler. There is no separate
            "save" button because there is no separate save step. */}
        <View className="mt-4">
          <Pressable
            onPress={onPickTrip}
            accessibilityRole="button"
            accessibilityLabel="Choose a trip"
            accessibilityHint="Picking a trip saves this screenshot and moves to the next"
            className="flex-row items-center justify-between rounded-2xl px-4 py-4"
            style={{
              backgroundColor: '#14b8a6',
            }}
          >
            <View className="flex-row items-center gap-2">
              <Icon name="folder.fill" size={16} tintColor="#ffffff" />
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#ffffff' }}>
                Choose a trip
              </Text>
            </View>
            <Icon name="chevron.right" size={14} tintColor="rgba(255,255,255,0.85)" />
          </Pressable>

          <Text
            className="text-text-muted mt-2 px-1"
            style={{ fontSize: 12, lineHeight: 16 }}
          >
            Saves automatically when you pick a trip.
          </Text>

          <Pressable
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel="Skip for now"
            accessibilityHint="Leaves this screenshot in the inbox and goes to the next"
            className="mt-3 rounded-2xl items-center justify-center"
            style={{
              paddingVertical: 12,
              backgroundColor: 'rgba(15,23,42,0.04)',
              borderWidth: 1,
              borderColor: 'rgba(15,23,42,0.06)',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '600', color: '#475569' }}>
              Skip for now
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}


