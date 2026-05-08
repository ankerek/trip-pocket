import type { Migration } from '../db';
import { init } from './0001_init';
import { ocrFts } from './0002_ocr_fts';
import { extraction } from './0003_extraction';
import { extractedAddress } from './0004_extracted_address';
import { placeEnrichments } from './0005_place_enrichments';

export const migrations: Migration[] = [
  init,
  ocrFts,
  extraction,
  extractedAddress,
  placeEnrichments,
];
