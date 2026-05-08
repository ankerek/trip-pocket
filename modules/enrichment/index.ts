export {
  createEnricher,
  EnrichmentError,
  type CreateEnricherOptions,
  type EnrichErrorKind,
  type Enricher,
  type EnrichmentRunner,
  type EnrichOutcome,
  type EnrichRequestPayload,
} from './enrichment';
export { enrichFromProxy } from './proxy';

import type { Enricher } from './enrichment';

let provided: Enricher | null = null;

export function provideEnricher(e: Enricher): void {
  provided = e;
}

export function getEnricher(): Enricher | null {
  return provided;
}

/** Test-only — clear the singleton between tests. */
export function _resetEnricherForTests(): void {
  provided = null;
}
