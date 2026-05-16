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

  describe('extraction_strategy gating of ocr_status', () => {
    it('ignores pending ocr_status for vision strategy (OCR is intentionally skipped)', () => {
      expect(
        isSourceProcessing({
          ocr_status: 'pending',
          extraction_status: 'done',
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
          extraction_strategy: 'vision',
        }),
      ).toBe(false);
    });

    it('ignores pending ocr_status for captionPlusVision strategy', () => {
      expect(
        isSourceProcessing({
          ocr_status: 'pending',
          extraction_status: 'done',
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
          extraction_strategy: 'captionPlusVision',
        }),
      ).toBe(false);
    });

    it('still counts pending extraction_status for vision strategy', () => {
      expect(
        isSourceProcessing({
          ocr_status: 'pending',
          extraction_status: 'pending',
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
          extraction_strategy: 'vision',
        }),
      ).toBe(true);
    });

    it('legacy NULL strategy keeps the old ocr_status behavior', () => {
      expect(
        isSourceProcessing({
          ocr_status: 'pending',
          extraction_status: 'done',
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
          extraction_strategy: null,
        }),
      ).toBe(true);
    });

    it('ocrTextLLM strategy keeps the old ocr_status behavior', () => {
      expect(
        isSourceProcessing({
          ocr_status: 'pending',
          extraction_status: 'done',
          extraction_paused_reason: null,
          url_fetch_paused_reason: null,
          extraction_strategy: 'ocrTextLLM',
        }),
      ).toBe(true);
    });
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

  it('gates the ocr_status arm on the OCR-using strategies', () => {
    // ocr_status='pending' is only "live work" when the row's strategy
    // actually runs OCR (legacy NULL or ocrTextLLM). Vision/captionPlusVision
    // rows leave ocr_status at 'pending' permanently.
    expect(PROCESSING_SOURCES_WHERE).toContain(
      "extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM'",
    );
  });
});
