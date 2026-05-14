// Pipeline log: per-source stage history reaching back ~1000 events. See
// docs/superpowers/specs/2026-05-13-pipeline-observability-design.md §In-app
// Diagnostics stream UI. Rows persist with no content — stages, statuses,
// timings, and a closed-vocab error class.

import { useMemo, useState } from 'react';
import { Alert, Pressable as RNPressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { useLiveQuery } from '@/modules/storage';
import { clearPipelineEvents } from '@/modules/pipeline-log';
import { useDatabase } from '@/components/useDatabase';

type Row = {
  id: number;
  source_id: string | null;
  stage: string;
  status: 'done' | 'failed';
  occurred_at: string;
  duration_ms: number;
  error_summary: string | null;
  source_alive: number; // 1 when the matching sources row still exists
};

const PAGE_SIZE = 200;

// LEFT JOIN onto sources so the UI can show "(deleted)" next to ids whose
// source row has been hard-deleted. Newest events first; the UI flips it to
// chronological order within each group.
const SQL = `
  SELECT e.id, e.source_id, e.stage, e.status, e.occurred_at,
         e.duration_ms, e.error_summary,
         CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS source_alive
    FROM pipeline_events e
    LEFT JOIN sources s ON s.id = e.source_id
   ORDER BY e.id DESC
   LIMIT ?
`;

export default function PipelineLogScreen() {
  const router = useRouter();
  const db = useDatabase();
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Live-subscribe so new events appear without a manual refresh.
  const rows = useLiveQuery<Row>(SQL, [limit], ['pipeline_events', 'sources']) ?? [];

  // Group consecutive rows that share the same source_id (DESC order from
  // SQL). Within each group, reverse the stage order so the pipeline reads
  // top→bottom in the same direction it actually ran.
  const groups = useMemo(() => groupBySource(rows), [rows]);

  const onClear = () => {
    if (!db) return;
    Alert.alert('Clear pipeline log?', 'This removes all entries.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          void clearPipelineEvents(db);
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <RNPressable
              onPress={onClear}
              accessibilityRole="button"
              accessibilityLabel="Clear pipeline log"
              hitSlop={12}
            >
              <Text style={{ fontSize: 15, color: '#dc2626', fontWeight: '600' }}>Clear</Text>
            </RNPressable>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="bg-bg flex-1"
        contentContainerClassName="px-4 py-4"
      >
        {groups.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {groups.map((g, i) => (
              <Group
                key={`${g.sourceId ?? 'none'}:${i}:${g.events[0]!.id}`}
                group={g}
                onOpenSource={(id) => router.push(`/sources/${id}`)}
              />
            ))}
            {rows.length >= limit && (
              <Pressable
                onPress={() => setLimit((l) => l + PAGE_SIZE)}
                accessibilityRole="button"
                accessibilityLabel="Load older events"
                className="mt-4 rounded-2xl px-4 py-3"
                style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
              >
                <Text
                  style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6', textAlign: 'center' }}
                >
                  Load older
                </Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

function EmptyState() {
  return (
    <View className="mt-16 items-center">
      <Text className="text-text-muted text-center" style={{ fontSize: 14 }}>
        No pipeline activity yet. Share something or import a screenshot to see events here.
      </Text>
    </View>
  );
}

type GroupView = {
  sourceId: string | null;
  alive: boolean;
  // Events are in chronological order (oldest → newest) so the pipeline
  // reads top-down.
  events: Row[];
};

function groupBySource(rows: Row[]): GroupView[] {
  const out: GroupView[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.sourceId === r.source_id) {
      last.events.push(r);
    } else {
      out.push({
        sourceId: r.source_id,
        alive: r.source_alive === 1,
        events: [r],
      });
    }
  }
  // Within each group, rows arrived newest-first; reverse so the pipeline
  // flow reads top→bottom.
  for (const g of out) g.events.reverse();
  return out;
}

function Group({ group, onOpenSource }: { group: GroupView; onOpenSource: (id: string) => void }) {
  const headerLabel = group.sourceId
    ? `source: ${shortId(group.sourceId)}${group.alive ? '' : ' (deleted)'}`
    : '(no source)';
  const tappable = group.sourceId !== null && group.alive;

  const newest = group.events[group.events.length - 1]!;
  return (
    <View className="mt-6">
      <Text
        className="text-text-muted"
        style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.5 }}
      >
        {formatDayHeader(newest.occurred_at)}
      </Text>
      {tappable ? (
        <Pressable
          onPress={() => onOpenSource(group.sourceId!)}
          accessibilityRole="link"
          accessibilityLabel={`Open ${headerLabel}`}
          className="mt-1"
        >
          <Text className="text-text" style={{ fontSize: 13, fontWeight: '600' }}>
            {headerLabel}
          </Text>
        </Pressable>
      ) : (
        <Text className="text-text mt-1" style={{ fontSize: 13, fontWeight: '600' }}>
          {headerLabel}
        </Text>
      )}
      <View className="mt-2">
        {group.events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </View>
    </View>
  );
}

function EventRow({ event }: { event: Row }) {
  const failed = event.status === 'failed';
  return (
    <View className="mb-1">
      <View className="flex-row">
        <Text className="text-text-muted" style={{ fontSize: 12, fontFamily: 'Menlo', width: 70 }}>
          {formatTime(event.occurred_at)}
        </Text>
        <Text className="text-text" style={{ fontSize: 12, fontFamily: 'Menlo', width: 130 }}>
          {event.stage}
        </Text>
        <Text
          style={{
            fontSize: 12,
            fontFamily: 'Menlo',
            width: 60,
            color: failed ? '#dc2626' : '#14b8a6',
            fontWeight: '600',
          }}
        >
          {event.status}
        </Text>
        <Text className="text-text-muted" style={{ fontSize: 12, fontFamily: 'Menlo' }}>
          {formatDuration(event.duration_ms)}
        </Text>
      </View>
      {failed && event.error_summary && (
        <Text style={{ fontSize: 12, fontFamily: 'Menlo', color: '#dc2626', marginLeft: 70 }}>
          {event.error_summary}
        </Text>
      )}
    </View>
  );
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatTime(iso: string): string {
  // HH:MM:SS — defensive against malformed ISO strings (unlikely but cheap).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  return d.toTimeString().slice(0, 8);
}

function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `TODAY ${formatTime(iso).slice(0, 5)}`;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
