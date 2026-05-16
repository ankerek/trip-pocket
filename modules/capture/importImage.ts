import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { insertSource } from '@/modules/storage/sources';
import { notifyChange } from '@/modules/storage/live-query';
import { getProcessor } from '@/modules/processing';
import { getExtractor } from '@/modules/extraction';
import { startStage } from '@/modules/pipeline-log';
import { getForceStrategy } from '@/modules/extraction/config';
import { strategyForImageImport } from '@/modules/extraction/strategies/select';

export type ImportFs = {
  sha256: (uri: string) => Promise<string>;
  copy: (from: string, to: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  unlink: (uri: string) => Promise<void>;
};

export type ImportImageInput = {
  sourceUri: string;
  origin: 'share' | 'manual' | 'auto';
  ownerId: string;
  capturedAt: string;
  suggestedTripId?: string | null;
  transfer: 'move' | 'copy';
  storageDir: string;
  fs: ImportFs;
  // Optional caption derived from EXIF GPS by the picker
  // (`deriveLocationCaption`). When present, the strategy upgrades to
  // `captionPlusVision` and Gemini gets the geographic hint alongside the
  // image. Share-extension path leaves this null — iOS often strips EXIF
  // on the share sheet.
  caption?: string | null;
};

export type ImportImageResult =
  | { status: 'imported'; sourceId: string }
  | { status: 'duplicate'; existingSourceId: string };

export async function importImage(
  db: Database,
  input: ImportImageInput,
): Promise<ImportImageResult> {
  // Pre-allocate the source UUID so every downstream stage (storage, ocr, …)
  // groups under one id in the pipeline log — see spec §Storage/schema.
  const sourceId = Crypto.randomUUID();
  const shareImportStage = startStage('share_import', sourceId);

  const contentHash = await input.fs.sha256(input.sourceUri);

  const existing = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM sources WHERE content_hash = ? LIMIT 1`,
    contentHash,
  );
  if (existing) {
    shareImportStage.done({ kind: 'image', dup: true, existingSourceId: existing.id });
    return { status: 'duplicate', existingSourceId: existing.id };
  }

  shareImportStage.done({ kind: 'image' });

  // expo-file-system's Directory.uri can come back with a trailing slash; strip
  // it so we never produce `file://.../sources//<id>.jpg`. Some iOS code paths
  // choke on the double slash even though the filesystem itself doesn't.
  const dir = input.storageDir.endsWith('/') ? input.storageDir.slice(0, -1) : input.storageDir;
  const targetUri = `${dir}/${sourceId}.jpg`;

  if (input.transfer === 'move') {
    await input.fs.move(input.sourceUri, targetUri);
  } else {
    await input.fs.copy(input.sourceUri, targetUri);
  }
  console.log('[importImage]', input.transfer, input.sourceUri, '->', targetUri);

  const trimmedCaption =
    typeof input.caption === 'string' && input.caption.trim().length > 0 ? input.caption : null;
  const extractionStrategy = strategyForImageImport(getForceStrategy(), trimmedCaption !== null);

  const storageStage = startStage('storage', sourceId);
  try {
    await insertSource(db, {
      id: sourceId,
      kind: 'image',
      tripId: input.suggestedTripId ?? null,
      filePath: targetUri,
      contentHash,
      origin: input.origin,
      capturedAt: input.capturedAt,
      ownerId: input.ownerId,
      extractionStrategy,
      caption: trimmedCaption,
    });
    storageStage.done({
      tripId: input.suggestedTripId ?? null,
      hasCaption: trimmedCaption !== null,
    });
  } catch (err) {
    // Insert failed (e.g. unique-index race with a concurrent writer that landed
    // a row with the same hash between our pre-check and our insert). Unlink the
    // file we just placed so we don't leave an orphan, then re-throw.
    try {
      await input.fs.unlink(targetUri);
    } catch {
      // Swallow unlink failures — the original error is what the caller cares about.
    }
    storageStage.failed(err);
    throw err;
  }

  notifyChange('sources');
  if (input.suggestedTripId) notifyChange('trips');

  // Kick off the appropriate stage. ocrTextLLM enqueues OCR (which chains
  // into extraction via processing.ts). Vision + captionPlusVision skip OCR
  // and go straight to the extractor — file_path is already set, so the
  // sweep would pick it up too; this immediate enqueue just avoids the
  // sweep-tick latency. The extractor reads `sources.caption` from the row
  // and passes it to the visual runner alongside the image. No-op when no
  // processor/extractor has been provisioned (Jest, share-extension cold
  // start) — the relevant sweep at app boot handles those rows.
  if (extractionStrategy === 'ocrTextLLM') {
    getProcessor()?.enqueueOcr(sourceId);
  } else {
    getExtractor()?.enqueueExtraction(sourceId);
  }

  return { status: 'imported', sourceId };
}
