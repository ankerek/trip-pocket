export type ThumbnailBadgeInput = {
  ocr_status: 'pending' | 'done' | 'failed';
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
  place_count: number;
};

export type ThumbnailBadgeKind = 'shimmer' | 'paused' | 'pin' | 'no-places' | 'none';

/**
 * Decides which (if any) overlay to render on a screenshot thumbnail.
 *
 * Rules, in order:
 *
 *  1. Paused on entitlement (extraction OR url-fetch) — the pipeline stopped
 *     because the worker returned 401. Surface as a 'paused' chip so the user
 *     understands cause; the tile becomes a tap target for the lapse paywall.
 *
 *  2. Shimmer when the pipeline still has live work for this row:
 *       ocr_status='pending' (OCR will run)
 *       OR ocr_status='done' AND extraction_status='pending' (extraction will run)
 *     A failed-OCR row does NOT shimmer — extraction's sweep requires
 *     ocr_status='done', so it'll never reach this row this session.
 *     Shimmer would lie.
 *
 *  3. Once both phases are terminal:
 *       place_count > 0     → 'pin' (we found places, blue badge)
 *       extraction='done', 0 → 'no-places' (we processed and found nothing)
 *       any 'failed'          → 'none' (silent — could be transient; recoverable
 *                                       on relaunch via runStartupRecovery, so a
 *                                       "no places" cue would be a false signal)
 *
 * Pure function — keeps PlaceGrid's render logic trivial and the rules
 * unit-testable in isolation.
 */
export function thumbnailBadge(item: ThumbnailBadgeInput): ThumbnailBadgeKind {
  if (
    item.extraction_paused_reason === 'entitlement' ||
    item.url_fetch_paused_reason === 'entitlement'
  ) {
    return 'paused';
  }
  if (item.ocr_status === 'pending') return 'shimmer';
  if (item.ocr_status === 'done' && item.extraction_status === 'pending') return 'shimmer';
  if (item.place_count > 0) return 'pin';
  if (item.ocr_status === 'done' && item.extraction_status === 'done') return 'no-places';
  return 'none';
}
