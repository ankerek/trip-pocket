import type { ProcessingStatus } from './sources';
import type { EnrichmentStatus } from './places';

export function isSourceProcessing(s: {
  ocr_status: ProcessingStatus;
  extraction_status: ProcessingStatus;
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
}): boolean {
  if (s.extraction_paused_reason || s.url_fetch_paused_reason) return false;
  return s.ocr_status === 'pending' || s.extraction_status === 'pending';
}

export function isPlaceProcessing(p: {
  enrichment_status: EnrichmentStatus;
  enrichment_paused_reason: string | null;
}): boolean {
  if (p.enrichment_paused_reason) return false;
  return p.enrichment_status === 'pending';
}

// SQL fragment used by the Pocket / Trip Detail banner count query. Entitlement-
// paused rows keep `*_status = 'pending'` so the pipeline can resume them, but we
// exclude them from the live-processing count — they belong to the paused-row
// surfaces instead.
export const PROCESSING_SOURCES_WHERE = `(ocr_status = 'pending' OR extraction_status = 'pending')
  AND extraction_paused_reason IS NULL
  AND url_fetch_paused_reason IS NULL`;
