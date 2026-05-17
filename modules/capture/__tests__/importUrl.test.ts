import { openDatabase, runMigrations, listSources, type Database } from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import { _resetProcessorForTests, provideProcessor, type Processor } from '@/modules/processing';
import { detectPlatformFromUrl, importUrl, normalizeUrl } from '../importUrl';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

function makeFakeProcessor(): {
  processor: Processor;
  enqueueUrlFetch: jest.Mock<void, [string]>;
} {
  const enqueueUrlFetch = jest.fn<void, [string]>();
  const processor: Processor = {
    enqueueOcr: jest.fn<void, [string]>(),
    enqueueUrlFetch,
    runOcrSweep: jest.fn().mockResolvedValue(undefined),
    runUrlFetchSweep: jest.fn().mockResolvedValue(undefined),
    runStartupRecovery: jest.fn().mockResolvedValue(undefined),
    resumeUrlFetchEntitlementPaused: jest.fn().mockResolvedValue(undefined),
    _awaitIdle: jest.fn().mockResolvedValue(undefined),
  };
  return { processor, enqueueUrlFetch };
}

describe('detectPlatformFromUrl', () => {
  it.each([
    ['https://www.instagram.com/p/ABC/', 'instagram'],
    ['https://m.instagram.com/reel/XYZ/', 'instagram'],
    ['https://instagr.am/p/ABC/', 'instagram'],
    ['https://www.tiktok.com/@u/video/123', 'tiktok'],
    ['https://vm.tiktok.com/abc', 'tiktok'],
    ['https://vt.tiktok.com/xyz', 'tiktok'],
  ])('classifies %s as %s', (url, expected) => {
    expect(detectPlatformFromUrl(url)).toBe(expected);
  });

  it.each([['https://youtube.com/watch?v=1'], ['not-a-url'], ['https://twitter.com/x/status/1']])(
    'returns null for unsupported url %s',
    (url) => {
      expect(detectPlatformFromUrl(url)).toBeNull();
    },
  );
});

describe('normalizeUrl', () => {
  it('lowercases host, strips www., query, hash, and trailing slash', () => {
    expect(normalizeUrl('https://WWW.Instagram.com/p/ABC/?igshid=1#frag')).toBe(
      'https://instagram.com/p/ABC',
    );
  });

  it('strips m. (mobile web) prefix so desktop+mobile shares dedup', () => {
    expect(normalizeUrl('https://m.instagram.com/p/ABC/')).toBe(
      normalizeUrl('https://instagram.com/p/ABC/'),
    );
  });

  it('preserves TikTok short-link subdomains (vm./vt. carry meaning)', () => {
    expect(normalizeUrl('https://vm.tiktok.com/abc')).toBe('https://vm.tiktok.com/abc');
    expect(normalizeUrl('https://vt.tiktok.com/xyz')).toBe('https://vt.tiktok.com/xyz');
  });

  it('keeps a bare https://host/ slash', () => {
    expect(normalizeUrl('https://instagram.com/')).toBe('https://instagram.com/');
  });

  it('returns input unchanged when not a parseable URL', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('importUrl', () => {
  afterEach(() => {
    _resetProcessorForTests();
  });

  it('inserts a kind="url" source row in pending state', async () => {
    const db = await freshDb();
    // The legacy processor.enqueueUrlFetch call has been removed —
    // URL sources are now driven by pollExtractForUrlSources, which
    // runs in runForegroundIngest after ingestPendingImports. The fake
    // processor stays wired so a hidden re-introduction of the call
    // would still be observable.
    const { processor, enqueueUrlFetch } = makeFakeProcessor();
    provideProcessor(processor);

    const result = await importUrl(db, {
      url: 'https://www.instagram.com/p/ABC/?igshid=tracking',
      origin: 'share',
      ownerId,
      capturedAt: '2026-05-12T10:00:00.000Z',
    });

    expect(result.status).toBe('imported');
    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'url',
      platform: 'instagram',
      filePath: null,
      url: 'https://instagram.com/p/ABC',
      ocrStatus: 'pending',
      extractionStatus: 'pending',
      caption: null,
    });
    expect(enqueueUrlFetch).not.toHaveBeenCalled();
  });

  it('treats the same post shared twice (different tracking params) as a duplicate', async () => {
    const db = await freshDb();
    const { processor } = makeFakeProcessor();
    provideProcessor(processor);

    await importUrl(db, {
      url: 'https://instagram.com/p/ABC/?igshid=v1',
      origin: 'share',
      ownerId,
      capturedAt: '2026-05-12T10:00:00.000Z',
    });
    const second = await importUrl(db, {
      url: 'https://instagram.com/p/ABC/?igshid=v2',
      origin: 'share',
      ownerId,
      capturedAt: '2026-05-12T10:01:00.000Z',
    });

    expect(second.status).toBe('duplicate');
    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(1);
  });

  it('returns unsupported for non-IG/TikTok hosts', async () => {
    const db = await freshDb();
    const result = await importUrl(db, {
      url: 'https://youtube.com/shorts/abc',
      origin: 'share',
      ownerId,
      capturedAt: '2026-05-12T10:00:00.000Z',
    });
    expect(result.status).toBe('unsupported');
    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(0);
  });
});
