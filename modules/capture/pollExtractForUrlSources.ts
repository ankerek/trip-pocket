import Constants from 'expo-constants';
import Purchases from 'react-native-purchases';
import { Directory, File, Paths } from 'expo-file-system';
import type { Database } from '@/modules/storage/db';
import { pollExtract } from '@/lib/extract/pollExtract';
import { applyExtractDone } from './applyExtractDone';
import { getAppGroupContainerUri } from './paths';

/** Poll budget per source. 30 × 2 s = 60 s, which comfortably covers a
 *  worst-case video extraction (Apify + Gemini Files API). The wait is
 *  non-blocking on the UI thread; the user's triage card still shows the
 *  partial state (caption + cover) until `done` arrives. */
const POLL_MAX_ATTEMPTS = 30;
const POLL_DELAY_MS = 2_000;

/** Cap concurrent polls. A 10-source backlog (after a prolonged offline
 *  period) shouldn't open 10 sockets to the worker simultaneously. */
const POLL_CONCURRENCY = 3;

/**
 * Foreground sweep: for every URL source still in extraction_status='pending',
 * poll the worker's GET /extract/:contentHash. On status='done' apply the
 * deduped places + flip the source to 'done' atomically; on miss
 * (`triggerOnMissing: true`) POST /extract once and re-poll.
 *
 * Replaces the legacy url_fetch → ocr → extract sweep for kind='url' sources
 * — the worker owns those stages now.
 */
export async function pollExtractForUrlSources(
  db: Database,
  ownerId: string,
): Promise<void> {
  const rows = await db.getAllAsync<{
    id: string;
    content_hash: string;
    url: string;
  }>(
    `SELECT id, content_hash, url FROM sources
      WHERE kind = 'url'
        AND extraction_status = 'pending'
        AND extraction_paused_reason IS NULL
        AND content_hash IS NOT NULL
        AND url IS NOT NULL`,
  );
  if (rows.length === 0) return;

  const rcUserId = await getRcUserId();
  if (!rcUserId) {
    // No RC id yet (cold-launch before RC SDK init resolved). The next
    // foreground tick will pick these up.
    return;
  }
  const workerBase = (Constants.expoConfig?.extra?.workerBase as string) ?? '';
  if (!workerBase) return;

  let cursor = 0;
  async function workOne(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i]!;
      await pollAndApplyOne(row, rcUserId!, workerBase, db, ownerId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(POLL_CONCURRENCY, rows.length) }, () => workOne()),
  );
}

async function pollAndApplyOne(
  row: { id: string; content_hash: string; url: string },
  rcUserId: string,
  workerBase: string,
  db: Database,
  ownerId: string,
): Promise<void> {
  let result;
  try {
    result = await pollExtract({
      contentHash: row.content_hash,
      rcUserId,
      workerBase,
      maxAttempts: POLL_MAX_ATTEMPTS,
      delayMs: POLL_DELAY_MS,
      triggerOnMissing: true,
      url: row.url,
    });
  } catch (err) {
    console.warn('[poll-extract] failed for', row.id, err);
    return;
  }
  if (result.status !== 'done') return;

  let coverPath: string | null = null;
  if (result.coverUrl) {
    try {
      coverPath = await downloadCoverImage(result.coverUrl);
    } catch (err) {
      console.warn('[poll-extract] cover download failed for', row.id, err);
    }
  }

  await applyExtractDone(db, {
    sourceId: row.id,
    caption: result.caption ?? null,
    coverPath,
    placesToInsert: result.places,
    model: result.model,
    ownerId,
    now: new Date().toISOString(),
  });
}

async function getRcUserId(): Promise<string | null> {
  try {
    return await Purchases.getAppUserID();
  } catch {
    return null;
  }
}

/**
 * Download the cover image from the worker's signed CDN URL to a permanent
 * local path. IG/TikTok cover URLs expire within hours; persisting the
 * bytes locally lets the source detail UI render offline.
 *
 * Mirrors the existing inline downloader in app/_layout.tsx (the
 * createProcessor wiring) — kept independent so the legacy processor
 * path stays untouched until v2 lifts the image source onto this flow.
 */
async function downloadCoverImage(coverUrl: string): Promise<string> {
  const appGroupUri = getAppGroupContainerUri();
  const screenshotsDir = appGroupUri
    ? new Directory(appGroupUri, 'screenshots')
    : new Directory(Paths.document, 'screenshots');
  if (!screenshotsDir.exists) screenshotsDir.create({ intermediates: true });
  const downloaded = await File.downloadFileAsync(coverUrl, screenshotsDir);
  return downloaded.uri;
}
