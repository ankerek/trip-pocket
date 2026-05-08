import type { Database } from '@/modules/storage/db';
import { getProcessor } from '@/modules/processing';
import { getExtractor } from '@/modules/extraction';
import { ingestPendingImports } from './ingest';
import { createImportFs } from './importFsRuntime';
import { getOrCreateOwnerId } from './owner';
import { getStorageDirectory } from './paths';

let inFlight: Promise<void> | null = null;

/**
 * Run the established foreground ingest sequence as one atomic operation:
 * 1. Drain anything the share extension left in the App Group inbox.
 * 2. Sweep `pending` OCR rows (catches anything the previous session
 *    left mid-process).
 * 3. Sweep `pending` extraction rows.
 *
 * Idempotent. If a run is in flight, callers receive the same promise so
 * pull-to-refresh can never race the foreground-effect or share-extension
 * imports.
 *
 * Spec §4.1 — pull-to-refresh and the root layout's foreground effect
 * both call this single helper.
 */
export function runForegroundIngest(db: Database): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      await ingestPendingImports(db, {
        ownerId: getOrCreateOwnerId(),
        storageDir: getStorageDirectory().uri,
        fs: createImportFs(),
      });
      await getProcessor()?.runOcrSweep();
      await getExtractor()?.runExtractionSweep();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
