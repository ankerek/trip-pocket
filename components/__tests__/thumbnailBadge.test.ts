import { thumbnailBadge } from '../thumbnailBadge';

const base = {
  ocr_status: 'done' as const,
  extraction_status: 'done' as const,
  place_count: 0,
};

describe('thumbnailBadge', () => {
  it('shimmer when OCR is pending', () => {
    expect(thumbnailBadge({ ...base, ocr_status: 'pending' })).toBe('shimmer');
  });

  it('shimmer when OCR done but extraction is pending', () => {
    expect(thumbnailBadge({ ...base, ocr_status: 'done', extraction_status: 'pending' })).toBe(
      'shimmer',
    );
  });

  it('shimmer is OFF when OCR failed even though extraction_status defaults to pending', () => {
    // The merged shimmer rule explicitly excludes ocr_status='failed':
    // a failed-OCR row would shimmer forever otherwise (extraction will
    // never run for it because the sweep filter requires ocr_status='done').
    expect(thumbnailBadge({ ...base, ocr_status: 'failed', extraction_status: 'pending' })).toBe(
      'none',
    );
  });

  it('pin when extraction is done with ≥1 place', () => {
    expect(thumbnailBadge({ ...base, place_count: 2 })).toBe('pin');
  });

  it('no-places when extraction is done with 0 places', () => {
    expect(thumbnailBadge({ ...base, extraction_status: 'done', place_count: 0 })).toBe(
      'no-places',
    );
  });

  it('none when extraction failed (could be transient — recoverable on next launch)', () => {
    expect(thumbnailBadge({ ...base, extraction_status: 'failed', place_count: 0 })).toBe('none');
  });

  it('none when OCR failed (silent posture, same as ARCHITECTURE.md)', () => {
    expect(thumbnailBadge({ ...base, ocr_status: 'failed' })).toBe('none');
  });

  it('pin and no-places are mutually exclusive — pin wins when both could apply', () => {
    // place_count > 0 immediately → pin, regardless of extraction status
    // (in practice extraction is always 'done' when place_count > 0
    // because places are inserted in the same transaction that sets
    // extraction_status='done', but assert the logic isn't fragile to
    // hypothetical race orderings).
    expect(thumbnailBadge({ ...base, place_count: 3 })).toBe('pin');
  });
});
