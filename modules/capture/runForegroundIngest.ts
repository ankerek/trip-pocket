import type { Database } from '@/modules/storage/db';
import { getProcessor } from '@/modules/processing';
import { getExtractor } from '@/modules/extraction';
import { ingestPendingImports } from './ingest';
import { createImportFs } from './importFsRuntime';
import { getOrCreateOwnerId } from './owner';
import { getStorageDirectory } from './paths';
import { pollExtractForUrlSources } from './pollExtractForUrlSources';

let inFlight: Promise<void> | null = null;

/**
 * Run the established foreground ingest sequence as one atomic operation:
 * 1. Drain anything the share extension left in the App Group inbox.
 * 2. Sweep `pending` URL-fetch rows (kind='url' awaiting the worker call).
 * 3. Sweep `pending` OCR rows (catches anything the previous session
 *    left mid-process).
 * 4. Sweep `pending` extraction rows.
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
      const ownerId = getOrCreateOwnerId();
      await ingestPendingImports(db, {
        ownerId,
        storageDir: getStorageDirectory().uri,
        fs: createImportFs(),
      });
      // New share-time pre-warm path for URL sources: worker owns
      // fetch-post + OCR + extract. Cache hit returns done immediately;
      // miss POSTs once and polls. Replaces runUrlFetchSweep for
      // kind='url' sources (the processor's URL handling will be
      // removed in a follow-up cleanup).
      await pollExtractForUrlSources(db, ownerId);
      // Image sources still flow through the legacy processor + extractor
      // (v2 scope: lift them onto the worker too).
      await getProcessor()?.runOcrSweep();
      await getExtractor()?.runExtractionSweep();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
