// In-memory hand-off between the URL-fetch step and the video extraction
// step. /fetch-post returns a CDN videoUrl that's signed and expires within
// hours; we explicitly do NOT persist it (see the video extraction spec
// §Decisions — "Video URL is consumed in-memory, never stored"). This
// module is the tiny cache that bridges those two phases.
//
// On a cache miss (app killed between fetch and extract sweep, or row was
// stamped with strategy='videoPlusCaption' before this module existed), the
// extractor's extractVisual callback soft-degrades to captionPlusVision
// using the persisted cover image + caption.
//
// The cache is process-local; it does not survive a cold start.

export type VideoMetadata = {
  videoUrl: string;
  videoDuration: number | null;
  /** Cache enqueue time, ms epoch. Used by the TTL sweep. */
  cachedAt: number;
};

// CDN URLs from IG and TikTok are typically signed for several hours. We
// keep entries for 30 minutes — long enough to ride out an OCR queue blip
// or a brief network outage, short enough that stale entries clear out on
// their own.
const TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, VideoMetadata>();

export function rememberVideoMetadata(
  sourceId: string,
  videoUrl: string,
  videoDuration: number | null,
): void {
  cache.set(sourceId, { videoUrl, videoDuration, cachedAt: Date.now() });
}

export function takeVideoMetadata(sourceId: string): VideoMetadata | null {
  const hit = cache.get(sourceId);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > TTL_MS) {
    cache.delete(sourceId);
    return null;
  }
  // Single-shot: consuming the entry removes it. The video extraction call
  // is one-and-done; if it fails and falls back to captionPlusVision we
  // don't try the video path again on a retry.
  cache.delete(sourceId);
  return hit;
}

/** Test-only. Empties the cache. */
export function _clearVideoMetadata(): void {
  cache.clear();
}

/** Test-only. Peeks without consuming. */
export function _peekVideoMetadata(sourceId: string): VideoMetadata | null {
  return cache.get(sourceId) ?? null;
}
