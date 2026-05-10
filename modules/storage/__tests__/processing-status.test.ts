import { isPlaceProcessing, isSourceProcessing } from '../processing-status';

describe('isSourceProcessing', () => {
  it.each([
    ['pending', 'pending', true],
    ['pending', 'done', true],
    ['done', 'pending', true],
    ['pending', 'failed', true],
    ['failed', 'pending', true],
    ['done', 'done', false],
    ['failed', 'done', false],
    ['done', 'failed', false],
    ['failed', 'failed', false],
  ] as const)('ocr=%s extraction=%s → %s', (ocr_status, extraction_status, expected) => {
    expect(isSourceProcessing({ ocr_status, extraction_status })).toBe(expected);
  });
});

describe('isPlaceProcessing', () => {
  it.each([
    ['pending', true],
    ['enriched', false],
    ['not-found', false],
    ['failed', false],
  ] as const)('enrichment=%s → %s', (enrichment_status, expected) => {
    expect(isPlaceProcessing({ enrichment_status })).toBe(expected);
  });
});
