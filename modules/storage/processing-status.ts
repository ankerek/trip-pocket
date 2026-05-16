import type { ExtractionStrategyName, ProcessingStatus } from './sources';
import type { EnrichmentStatus } from './places';

// Vision-strategy rows intentionally skip OCR, so `ocr_status` stays 'pending'
// for them forever. Only `extraction_status` is meaningful as a progress signal.
// Legacy NULL is treated as 'ocrTextLLM' (matches the orchestrator).
function ocrStatusIsMeaningful(strategy: ExtractionStrategyName | null | undefined): boolean {
  return strategy == null || strategy === 'ocrTextLLM';
}

export function isSourceProcessing(s: {
  ocr_status: ProcessingStatus;
  extraction_status: ProcessingStatus;
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
  extraction_strategy?: ExtractionStrategyName | null;
}): boolean {
  if (s.extraction_paused_reason || s.url_fetch_paused_reason) return false;
  if (s.extraction_status === 'pending') return true;
  if (ocrStatusIsMeaningful(s.extraction_strategy)) {
    return s.ocr_status === 'pending';
  }
  return false;
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
//
// Vision/captionPlusVision rows leave `ocr_status` at 'pending' permanently
// (OCR is skipped by design). Only `ocr_status = 'pending'` for ocrTextLLM
// (or legacy NULL) rows counts as live work — otherwise the banner would lie
// forever.
export const PROCESSING_SOURCES_WHERE = `(
    extraction_status = 'pending'
    OR (
      ocr_status = 'pending'
      AND (extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM')
    )
  )
  AND extraction_paused_reason IS NULL
  AND url_fetch_paused_reason IS NULL`;
