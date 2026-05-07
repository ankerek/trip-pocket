import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import {
  getScreenshot,
  useLiveQuery,
  type Screenshot,
} from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';

export default function OcrDebugSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useDatabase();
  const [screenshot, setScreenshot] = useState<Screenshot | null>(null);

  // Re-read when OCR completes in the background.
  const tick = useLiveQuery<{ v: number }>(`SELECT 0 AS v`, [], ['screenshots']);

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
    </ScrollView>
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
