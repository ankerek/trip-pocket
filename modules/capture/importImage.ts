import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { insertScreenshot } from '@/modules/storage/screenshots';
import { notifyChange } from '@/modules/storage/live-query';

export type ImportFs = {
  sha256: (uri: string) => Promise<string>;
  copy: (from: string, to: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  unlink: (uri: string) => Promise<void>;
};

export type ImportImageInput = {
  sourceUri: string;
  source: 'share' | 'manual';
  ownerId: string;
  capturedAt: string;
  suggestedTripId?: string | null;
  transfer: 'move' | 'copy';
  sandboxDir: string;
  fs: ImportFs;
};

export type ImportImageResult =
  | { status: 'imported'; screenshotId: string }
  | { status: 'duplicate'; existingScreenshotId: string };

export async function importImage(
  db: Database,
  input: ImportImageInput,
): Promise<ImportImageResult> {
  const contentHash = await input.fs.sha256(input.sourceUri);

  const existing = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM screenshots
      WHERE content_hash = ? AND deleted_at IS NULL
      LIMIT 1`,
    contentHash,
  );
  if (existing) {
    return { status: 'duplicate', existingScreenshotId: existing.id };
  }

  const screenshotId = Crypto.randomUUID();
  const targetUri = `${input.sandboxDir}/${screenshotId}.jpg`;

  if (input.transfer === 'move') {
    await input.fs.move(input.sourceUri, targetUri);
  } else {
    await input.fs.copy(input.sourceUri, targetUri);
  }

  try {
    await insertScreenshot(db, {
      id: screenshotId,
      tripId: input.suggestedTripId ?? null,
      filePath: targetUri,
      contentHash,
      source: input.source,
      capturedAt: input.capturedAt,
      ownerId: input.ownerId,
    });
  } catch (err) {
    // Insert failed (e.g. unique-index race with a concurrent writer that landed
    // a row with the same hash between our pre-check and our insert). Unlink the
    // file we just placed in the sandbox so we don't leave an orphan, then re-throw.
    try {
      await input.fs.unlink(targetUri);
    } catch {
      // Swallow unlink failures — the original error is what the caller cares about.
    }
    throw err;
  }

  notifyChange('screenshots');
  if (input.suggestedTripId) notifyChange('trips');

  return { status: 'imported', screenshotId };
}
