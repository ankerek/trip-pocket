import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { insertSource } from '@/modules/storage/sources';
import { notifyChange } from '@/modules/storage/live-query';
import { getProcessor } from '@/modules/processing';

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
};

export type ImportImageResult =
  | { status: 'imported'; sourceId: string }
  | { status: 'duplicate'; existingSourceId: string };

export async function importImage(
  db: Database,
  input: ImportImageInput,
): Promise<ImportImageResult> {
  const contentHash = await input.fs.sha256(input.sourceUri);

  const existing = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM sources
      WHERE content_hash = ? AND deleted_at IS NULL
      LIMIT 1`,
    contentHash,
  );
  if (existing) {
    return { status: 'duplicate', existingSourceId: existing.id };
  }

  const sourceId = Crypto.randomUUID();
  // expo-file-system's Directory.uri can come back with a trailing slash; strip
  // it so we never produce `file://.../sources//<id>.jpg`. Some iOS code paths
  // choke on the double slash even though the filesystem itself doesn't.
  const dir = input.storageDir.endsWith('/')
    ? input.storageDir.slice(0, -1)
    : input.storageDir;
  const targetUri = `${dir}/${sourceId}.jpg`;

  if (input.transfer === 'move') {
    await input.fs.move(input.sourceUri, targetUri);
  } else {
    await input.fs.copy(input.sourceUri, targetUri);
  }
  console.log('[importImage]', input.transfer, input.sourceUri, '->', targetUri);

  try {
    await insertSource(db, {
      id: sourceId,
      kind: 'screenshot',
      tripId: input.suggestedTripId ?? null,
      filePath: targetUri,
      contentHash,
      origin: input.origin,
      capturedAt: input.capturedAt,
      ownerId: input.ownerId,
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
    throw err;
  }

  notifyChange('sources');
  if (input.suggestedTripId) notifyChange('trips');

  // Kick off OCR for the freshly inserted row. Non-blocking; the import call
  // resolves immediately and the OCR worker picks it up in the background.
  // No-op when no processor has been provisioned (Jest, etc.).
  getProcessor()?.enqueueOcr(sourceId);

  return { status: 'imported', sourceId };
}
