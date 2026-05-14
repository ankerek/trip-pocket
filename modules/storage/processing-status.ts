import type { ProcessingStatus } from './sources';
import type { EnrichmentStatus } from './places';

export function isSourceProcessing(s: {
  ocr_status: ProcessingStatus;
  extraction_status: ProcessingStatus;
}): boolean {
  return s.ocr_status === 'pending' || s.extraction_status === 'pending';
}

export function isPlaceProcessing(p: { enrichment_status: EnrichmentStatus }): boolean {
  return p.enrichment_status === 'pending';
}

// SQL fragment used by the Pocket / Trip Detail banner count query.
export const PROCESSING_SOURCES_WHERE = `ocr_status = 'pending' OR extraction_status = 'pending'`;
