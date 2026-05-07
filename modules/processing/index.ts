export {
  createProcessor,
  type CreateProcessorOptions,
  type OcrRunner,
  type Processor,
} from './processing';

import type { Processor } from './processing';

let provided: Processor | null = null;

export function provideProcessor(p: Processor): void {
  provided = p;
}

export function getProcessor(): Processor | null {
  return provided;
}

/** Test-only — clear the singleton between tests. */
export function _resetProcessorForTests(): void {
  provided = null;
}
