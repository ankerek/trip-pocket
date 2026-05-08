import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import {
  getScreenshot,
  useLiveQuery,
  type Screenshot,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { getMapsUrl } from '@/components/PlaceRow';

type DebugPlace = {
  id: string;
  name: string;
  city: string;
  address: string | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  external_place_id: string | null;
  latitude: number | null;
  longitude: number | null;
};

const DEBUG_PLACES_SQL = `SELECT ep.id, ep.name, ep.city, ep.address,
                                 ep.enrichment_status,
                                 ep.external_place_id,
                                 pe.latitude, pe.longitude
                            FROM extracted_places ep
                       LEFT JOIN place_enrichments pe
                                 ON pe.external_place_id = ep.external_place_id
                           WHERE ep.screenshot_id = ? AND ep.deleted_at IS NULL
                        ORDER BY ep.created_at ASC`;

export default function OcrDebugSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useDatabase();
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);

  // Re-read when OCR completes in the background.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['screenshots']);
  const places = useLiveQuery<DebugPlace>(
    DEBUG_PLACES_SQL,
    id ? [id] : [],
    ['extracted_places'],
  );

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getScreenshot(db, id).then((s) => {
      if (!cancelled) setScreenshot(s);
    });
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  if (!screenshot) return null;

  const ocr = screenshot.ocrText ?? '';
  const charCount = [...ocr].length;

  return (
    <ScrollView
      className="flex-1 bg-white"
      contentContainerClassName="px-4 py-3 gap-3"
    >
      <Field label="ID" value={screenshot.id} mono />
      <Field label="Source" value={screenshot.source} />
      <Field label="Captured" value={screenshot.capturedAt} />
      <Field label="OCR status" value={screenshot.ocrStatus} />
      <View className="gap-1">
        <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
          OCR text · {charCount} chars
        </Text>
        {screenshot.ocrStatus === 'pending' ? (
          <Text className="text-sm italic text-slate-500">
            OCR pending — pull down to refresh after a few seconds.
          </Text>
        ) : screenshot.ocrStatus === 'failed' ? (
          <Text className="text-sm italic text-red-600">
            OCR failed (3 retries exhausted).
          </Text>
        ) : ocr.length === 0 ? (
          <Text className="text-sm italic text-slate-500">
            (no text recognized)
          </Text>
        ) : (
          <Text selectable className="text-sm leading-5 text-slate-900">
            {ocr}
          </Text>
        )}
      </View>
      <Field label="File path" value={screenshot.filePath} mono small />
      <ExtractedPlacesSection places={places} />
    </ScrollView>
  );
}

function ExtractedPlacesSection({ places }: { places: DebugPlace[] | null }) {
  if (places === null) return null;
  return (
    <View className="gap-2">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Extracted places · {places.length}
      </Text>
      {places.length === 0 ? (
        <Text className="text-sm italic text-slate-500">
          (none extracted yet)
        </Text>
      ) : (
        places.map((p) => (
          <View
            key={p.id}
            className="gap-1 rounded-md border border-slate-200 px-3 py-2"
          >
            <Text selectable className="text-sm font-semibold text-slate-900">
              {p.name}
            </Text>
            <Text selectable className="text-xs text-slate-500">
              city: {p.city || '—'}
              {p.address ? `\naddress: ${p.address}` : ''}
              {`\nenrichment: ${p.enrichment_status}`}
              {p.external_place_id ? `\nplace_id: ${p.external_place_id}` : ''}
            </Text>
            <Text selectable className="font-mono text-xs text-slate-700">
              {getMapsUrl(p)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function Field({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </Text>
      <Text
        selectable
        className={[
          small ? 'text-xs' : 'text-sm',
          mono ? 'font-mono' : '',
          'text-slate-900',
        ].join(' ')}
      >
        {value}
      </Text>
    </View>
  );
}
