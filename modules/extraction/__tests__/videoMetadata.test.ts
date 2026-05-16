import {
  _clearVideoMetadata,
  _peekVideoMetadata,
  rememberVideoMetadata,
  takeVideoMetadata,
} from '../videoMetadata';

beforeEach(() => {
  _clearVideoMetadata();
});

describe('videoMetadata cache', () => {
  it('remembers and takes a metadata entry', () => {
    rememberVideoMetadata('src-1', 'https://cdn/r.mp4', 28);
    const out = takeVideoMetadata('src-1');
    expect(out?.videoUrl).toBe('https://cdn/r.mp4');
    expect(out?.videoDuration).toBe(28);
  });

  it('take is single-shot — a second take returns null', () => {
    rememberVideoMetadata('src-2', 'https://cdn/r.mp4', null);
    expect(takeVideoMetadata('src-2')).not.toBeNull();
    expect(takeVideoMetadata('src-2')).toBeNull();
  });

  it('returns null on cache miss', () => {
    expect(takeVideoMetadata('never-cached')).toBeNull();
  });

  it('expires after the TTL', () => {
    const original = Date.now;
    const t0 = 1_000_000_000;
    let now = t0;
    Date.now = () => now;
    try {
      rememberVideoMetadata('src-3', 'https://cdn/r.mp4', 10);
      now = t0 + 31 * 60 * 1000; // 31 minutes later, past the 30 min TTL
      expect(takeVideoMetadata('src-3')).toBeNull();
      // Expired entry should be evicted on the failed take.
      expect(_peekVideoMetadata('src-3')).toBeNull();
    } finally {
      Date.now = original;
    }
  });

  it('null videoDuration is preserved', () => {
    rememberVideoMetadata('src-4', 'https://cdn/r.mp4', null);
    expect(takeVideoMetadata('src-4')?.videoDuration).toBeNull();
  });
});
