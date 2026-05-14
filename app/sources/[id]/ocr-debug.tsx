import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import { getSource, useLiveQuery, type Source } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { getMapsUrl } from '@/components/PlaceRow';

type DebugPlace = {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed';
  external_place_id: string | null;
  latitude: number | null;
  longitude: number | null;
};

const DEBUG_PLACES_SQL = `SELECT p.id, p.name, p.city,
                                 ps.extracted_address AS address,
                                 p.enrichment_status,
                                 p.external_place_id,
                                 p.latitude, p.longitude
                            FROM place_sources ps
                            JOIN places p ON p.id = ps.place_id
                           WHERE ps.source_id = ?
                        ORDER BY ps.extracted_at ASC`;

export default function OcrDebugSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useDatabase();
  const [source, setSource] = useState<Source | null>(null);

  // Re-read when OCR completes in the background.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['sources']);
  const places = useLiveQuery<DebugPlace>(DEBUG_PLACES_SQL, id ? [id] : [], [
    'place_sources',
    'places',
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!db || !id) return;
    getSource(db, id).then((s) => {
      if (!cancelled) setSource(s);
    });
    return () => {
      cancelled = true;
    };
  }, [db, id, tick]);

  if (!source) return null;

  const ocr = source.ocrText ?? '';
  const charCount = [...ocr].length;

  return (
    <ScrollView className="bg-bg flex-1" contentContainerClassName="px-4 py-3 gap-3">
      <Field label="ID" value={source.id} mono />
      <Field label="Kind" value={source.kind} />
      <Field label="Origin" value={source.origin} />
      <Field label="Captured" value={source.capturedAt} />
      <Field label="OCR status" value={source.ocrStatus} />
      <View className="gap-1">
        <Text className="text-text-muted text-xs font-medium tracking-wide uppercase">
          OCR text · {charCount} chars
        </Text>
        {source.ocrStatus === 'pending' ? (
          <Text className="text-text-muted text-sm italic">
            OCR pending — pull down to refresh after a few seconds.
          </Text>
        ) : source.ocrStatus === 'failed' ? (
          <Text className="text-sm text-red-600 italic">OCR failed (3 retries exhausted).</Text>
        ) : ocr.length === 0 ? (
          <Text className="text-text-muted text-sm italic">(no text recognized)</Text>
        ) : (
          <Text selectable className="text-text text-sm leading-5">
            {ocr}
          </Text>
        )}
      </View>
      {source.filePath ? <Field label="File path" value={source.filePath} mono small /> : null}
      {source.url ? <Field label="URL" value={source.url} small /> : null}
      <ExtractedPlacesSection places={places} />
    </ScrollView>
  );
}

function ExtractedPlacesSection({ places }: { places: DebugPlace[] | null }) {
  if (places === null) return null;
  return (
    <View className="gap-2">
      <Text className="text-text-muted text-xs font-medium tracking-wide uppercase">
        Extracted places · {places.length}
      </Text>
      {places.length === 0 ? (
        <Text className="text-text-muted text-sm italic">(none extracted yet)</Text>
      ) : (
        places.map((p) => (
          <View
            key={p.id}
            className="border-hairline bg-surface gap-1 rounded-md px-3 py-2"
            style={{ borderWidth: 1 }}
          >
            <Text selectable className="text-text text-sm font-semibold">
              {p.name}
            </Text>
            <Text selectable className="text-text-muted text-xs">
              city: {p.city || '—'}
              {p.address ? `\naddress: ${p.address}` : ''}
              {`\nenrichment: ${p.enrichment_status}`}
              {p.external_place_id ? `\nplace_id: ${p.external_place_id}` : ''}
            </Text>
            <Text selectable className="text-text-muted font-mono text-xs">
              {getMapsUrl({
                name: p.name,
                city: p.city ?? '',
                address: p.address,
                latitude: p.latitude,
                longitude: p.longitude,
                external_place_id: p.external_place_id,
              })}
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
      <Text className="text-text-muted text-xs font-medium tracking-wide uppercase">{label}</Text>
      <Text
        selectable
        className={[small ? 'text-xs' : 'text-sm', mono ? 'font-mono' : '', 'text-text'].join(' ')}
      >
        {value}
      </Text>
    </View>
  );
}
