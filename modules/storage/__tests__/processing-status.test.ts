import {
  PROCESSING_SOURCES_WHERE,
  isPlaceProcessing,
  isSourceProcessing,
} from '../processing-status';

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
  ] as const)(
    'ocr=%s extraction=%s (no paused reason) → %s',
    (ocr_status, extraction_status, expected) => {
      expect(
        isSourceProcessing({
          ocr_status,
          extraction_status,
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
        }),
      ).toBe(expected);
    },
  );

  it('is not processing when extraction is paused on entitlement', () => {
    expect(
      isSourceProcessing({
        ocr_status: 'done',
        extraction_status: 'pending',
        extraction_paused_reason: 'entitlement',
        url_fetch_paused_reason: null,
      }),
    ).toBe(false);
  });

  it('is not processing when url fetch is paused on entitlement', () => {
    expect(
      isSourceProcessing({
        ocr_status: 'pending',
        extraction_status: 'pending',
        extraction_paused_reason: null,
        url_fetch_paused_reason: 'entitlement',
      }),
    ).toBe(false);
  });

  it('is not processing when both paused reasons are set', () => {
    expect(
      isSourceProcessing({
        ocr_status: 'pending',
        extraction_status: 'pending',
        extraction_paused_reason: 'entitlement',
        url_fetch_paused_reason: 'entitlement',
      }),
    ).toBe(false);
  });
});

describe('isPlaceProcessing', () => {
  it.each([
    ['pending', true],
    ['enriched', false],
    ['not-found', false],
    ['failed', false],
  ] as const)('enrichment=%s (no paused reason) → %s', (enrichment_status, expected) => {
    expect(
      isPlaceProcessing({
        enrichment_status,
        enrichment_paused_reason: null,
      }),
    ).toBe(expected);
  });

  it('is not processing when enrichment is paused on entitlement', () => {
    expect(
      isPlaceProcessing({
        enrichment_status: 'pending',
        enrichment_paused_reason: 'entitlement',
      }),
    ).toBe(false);
  });
});

describe('PROCESSING_SOURCES_WHERE', () => {
  it('excludes entitlement-paused rows', () => {
    expect(PROCESSING_SOURCES_WHERE).toContain('extraction_paused_reason IS NULL');
    expect(PROCESSING_SOURCES_WHERE).toContain('url_fetch_paused_reason IS NULL');
  });

  it('still counts pending ocr/extraction', () => {
    expect(PROCESSING_SOURCES_WHERE).toContain("ocr_status = 'pending'");
    expect(PROCESSING_SOURCES_WHERE).toContain("extraction_status = 'pending'");
  });
});
