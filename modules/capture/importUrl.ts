// Counterpart to importImage.ts for kind='url' sources.
//
// Flow at ingest time (synchronous, no network):
//   1. Normalise + hash the shared URL.
//   2. Detect platform (instagram | tiktok) from hostname.
//   3. Insert a kind='url' source row with file_path=NULL, caption=NULL,
//      status='pending'. The worker call + image download happen later
//      in the processor — keeping ingest synchronous and offline-safe.
//   4. Enqueue URL processing.
//
// TikTok short-link dedup: we hash the URL the user shared, not the
// canonical URL the worker would resolve it to. Two shares of the same
// post via different short links will therefore create two sources
// today. Acceptable tradeoff for v0.2.1 — fixing requires either an
// app-side HEAD resolve (extra network call at ingest) or a worker
// roundtrip-then-rehash (mid-pipeline UNIQUE collision dance). Both add
// complexity for a usage pattern we don't see yet.

import * as Crypto from 'expo-crypto';
import type { Database } from '@/modules/storage/db';
import { insertSource, type SourcePlatform } from '@/modules/storage/sources';
import { notifyChange } from '@/modules/storage/live-query';
import { startStage } from '@/modules/pipeline-log';
import { sha256OfBytes } from './importFsRuntime';

export type ImportUrlInput = {
  url: string;
  origin: 'share' | 'manual' | 'auto';
  ownerId: string;
  capturedAt: string;
  suggestedTripId?: string | null;
};

export type ImportUrlResult =
  | { status: 'imported'; sourceId: string }
  | { status: 'duplicate'; existingSourceId: string }
  | { status: 'unsupported' };

export async function importUrl(db: Database, input: ImportUrlInput): Promise<ImportUrlResult> {
  // Pre-allocate so the share-import row and every downstream stage share one
  // source_id — see spec §Storage/schema.
  const sourceId = Crypto.randomUUID();
  const shareImportStage = startStage('url_share_import', sourceId);

  const platform = detectPlatformFromUrl(input.url);
  if (!platform) {
    shareImportStage.done({ kind: 'url', unsupported: true, urlHost: safeHost(input.url) });
    return { status: 'unsupported' };
  }

  const normalized = normalizeUrl(input.url);
  const contentHash = await sha256OfString(normalized);

  const existing = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM sources WHERE content_hash = ? LIMIT 1`,
    contentHash,
  );
  if (existing) {
    shareImportStage.done({
      kind: 'url',
      platform,
      dup: true,
      existingSourceId: existing.id,
    });
    return { status: 'duplicate', existingSourceId: existing.id };
  }

  shareImportStage.done({ kind: 'url', platform });

  const storageStage = startStage('storage', sourceId);
  try {
    await insertSource(db, {
      id: sourceId,
      kind: 'url',
      platform,
      tripId: input.suggestedTripId ?? null,
      filePath: null,
      url: normalized,
      contentHash,
      origin: input.origin,
      capturedAt: input.capturedAt,
      ownerId: input.ownerId,
    });
    storageStage.done({ tripId: input.suggestedTripId ?? null });
  } catch (err) {
    storageStage.failed(err);
    throw err;
  }

  notifyChange('sources');
  if (input.suggestedTripId) notifyChange('trips');

  // URL sources are now driven by the share-time pre-warm + foreground
  // poll path (modules/capture/pollExtractForUrlSources). The legacy
  // processor.enqueueUrlFetch call has been removed to prevent the two
  // paths from racing on the same source.

  return { status: 'imported', sourceId };
}

// --- URL utilities ------------------------------------------------------

function safeHost(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function detectPlatformFromUrl(rawUrl: string): SourcePlatform | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    if (host === 'instagram.com' || host === 'instagr.am') return 'instagram';
    if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
      return 'tiktok';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lower-cases host, strips a leading `www.`, drops the query string, and
 * removes a trailing slash. The same normalisation should run on both the
 * client (here, at ingest) and the worker so that `content_hash` and
 * worker-side cache keys agree for shares of the same post.
 */
export function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  // Strip query and fragment — IG/TikTok shares often append tracking
  // params (`igshid`, `share_token`, etc.) that vary per share.
  url.search = '';
  url.hash = '';
  // Normalise host casing + drop leading www./m. (mobile web). NOT stripped
  // for arbitrary subdomains — TikTok short-links live at `vm.tiktok.com`
  // and `vt.tiktok.com`, where the prefix carries meaning.
  url.hostname = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  let out = url.toString();
  // Strip trailing slash on the path (but keep a bare "https://host/")
  if (out.endsWith('/') && url.pathname.length > 1) {
    out = out.slice(0, -1);
  }
  return out;
}

async function sha256OfString(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  return sha256OfBytes(enc);
}
