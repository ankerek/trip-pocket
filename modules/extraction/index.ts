export {
  createExtractor,
  ExtractionError,
  type CreateExtractorOptions,
  type ExtractedPlaceInput,
  type Extractor,
  type ExtractionErrorKind,
  type ExtractionResult,
  type ExtractionRunner,
} from './extraction';
export { extractFromProxy } from './proxy';

import type { Extractor } from './extraction';

let provided: Extractor | null = null;

export function provideExtractor(e: Extractor): void {
  provided = e;
}

export function getExtractor(): Extractor | null {
  return provided;
}

/** Test-only — clear the singleton between tests. */
export function _resetExtractorForTests(): void {
  provided = null;
}
