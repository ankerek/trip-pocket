import * as Sentry from '@sentry/react-native';

import {
  openDatabase,
  runMigrations,
  insertSource,
  deleteSource,
  type Database,
} from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import * as liveQuery from '@/modules/storage/live-query';
import {
  createProcessor,
  type OcrRunner,
  type Processor,
  type UrlFetcher,
  type ImageDownloader,
} from '../processing';
import { FetchPostError } from '@/modules/capture/fetchPostFromProxy';
import { provideExtractor, _resetExtractorForTests, type Extractor } from '@/modules/extraction';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  // Pipeline-log inserts are fire-and-forget through the module-level handle;
  // wire it up so per-stage rows land in `pipeline_events` for integration
  // assertions and so no-op tests (the majority) keep working unchanged.
  liveQuery.provideDatabase(db);
  return db;
}

async function flushPipelineInserts(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function seedSource(
  db: Database,
  id: string,
  opts: { capturedAt?: string; status?: 'pending' | 'done' | 'failed' } = {},
): Promise<void> {
  await insertSource(db, {
    id,
    tripId: null,
    filePath: `/tmp/${id}.jpg`,
    contentHash: `hash-${id}`,
    origin: 'manual',
    capturedAt: opts.capturedAt ?? '2026-05-07T10:00:00.000Z',
    ownerId: 'owner-1',
  });
  if (opts.status && opts.status !== 'pending') {
    await db.runAsync(
      `UPDATE sources SET ocr_status = ?, updated_at = ? WHERE id = ?`,
      opts.status,
      '2026-05-07T10:00:00.000Z',
      id,
    );
  }
}

async function getStatus(
  db: Database,
  id: string,
): Promise<{ status: string; text: string | null }> {
  const row = await db.getFirstAsync<{ ocr_status: string; ocr_text: string | null }>(
    `SELECT ocr_status, ocr_text FROM sources WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`row ${id} missing`);
  return { status: row.ocr_status, text: row.ocr_text };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Test helper: drain the processor's queue. The `chain` field is internal
// state the processor exposes for tests.
async function drain(p: Processor): Promise<void> {
  await p._awaitIdle();
}

describe('createProcessor', () => {
  let notifySpy: jest.SpyInstance;
  beforeEach(() => {
    notifySpy = jest.spyOn(liveQuery, 'notifyChange');
  });
  afterEach(() => {
    notifySpy.mockRestore();
  });

  describe('processOne happy path', () => {
    it('writes ocr_text + status=done and fires notifyChange("sources")', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockResolvedValue('Maru Tonkatsu, Shibuya');
      const p = createProcessor({ db, ocr });

      p.enqueueOcr('s1');
      await drain(p);

      const after = await getStatus(db, 's1');
      expect(after).toEqual({ status: 'done', text: 'Maru Tonkatsu, Shibuya' });
      expect(ocr).toHaveBeenCalledWith('/tmp/s1.jpg');
      expect(notifySpy).toHaveBeenCalledWith('sources');
    });
  });

  describe('failure + retry', () => {
    it('retries up to maxRetries and then marks the row failed', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockRejectedValue(new Error('decode failed'));
      const p = createProcessor({ db, ocr, maxRetries: 3 });

      p.enqueueOcr('s1');
      await drain(p);

      expect(ocr).toHaveBeenCalledTimes(3);
      const after = await getStatus(db, 's1');
      expect(after.status).toBe('failed');
      expect(after.text).toBeNull();
    });

    it('a fresh processor (simulated relaunch) gets a new retry budget', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr1: OcrRunner = jest.fn().mockRejectedValue(new Error('boom'));
      const p1 = createProcessor({ db, ocr: ocr1, maxRetries: 3 });
      p1.enqueueOcr('s1');
      await drain(p1);
      expect(ocr1).toHaveBeenCalledTimes(3);

      // Manually flip back to pending — production does this via runStartupRecovery.
      await db.runAsync(`UPDATE sources SET ocr_status = 'pending' WHERE id = ?`, 's1');

      const ocr2: OcrRunner = jest.fn().mockRejectedValue(new Error('boom'));
      const p2 = createProcessor({ db, ocr: ocr2, maxRetries: 3 });
      p2.enqueueOcr('s1');
      await drain(p2);
      expect(ocr2).toHaveBeenCalledTimes(3);
    });
  });

  describe('queue dedup', () => {
    it('two enqueueOcr(id) calls only invoke the OCR runner once', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockResolvedValue('hi');
      const p = createProcessor({ db, ocr });

      p.enqueueOcr('s1');
      p.enqueueOcr('s1');
      p.enqueueOcr('s1');
      await drain(p);

      expect(ocr).toHaveBeenCalledTimes(1);
    });
  });

  describe('queue serialization', () => {
    it('processes ids in enqueue order, never two in flight at once', async () => {
      const db = await freshDb();
      await seedSource(db, 'a');
      await seedSource(db, 'b');

      let inFlight = 0;
      let maxInFlight = 0;
      const order: string[] = [];
      const gates = new Map<string, ReturnType<typeof deferred<string>>>();
      gates.set('a', deferred());
      gates.set('b', deferred());

      const ocr: OcrRunner = async (path: string) => {
        const id = path.replace('/tmp/', '').replace('.jpg', '');
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        order.push(`start:${id}`);
        const text = await gates.get(id)!.promise;
        order.push(`end:${id}`);
        inFlight -= 1;
        return text;
      };
      const p = createProcessor({ db, ocr });
      p.enqueueOcr('a');
      p.enqueueOcr('b');

      // Let the chain pick up 'a'; it's now blocked on the gate.
      await new Promise((r) => setImmediate(r));
      gates.get('a')!.resolve('text-a');
      await new Promise((r) => setImmediate(r));
      gates.get('b')!.resolve('text-b');
      await drain(p);

      expect(maxInFlight).toBe(1);
      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });
  });

  describe('runOcrSweep', () => {
    it('only picks up rows in pending state, skipping failed', async () => {
      const db = await freshDb();
      await seedSource(db, 'p1', { status: 'pending', capturedAt: '2026-05-07T10:00:00.000Z' });
      await seedSource(db, 'f1', { status: 'failed', capturedAt: '2026-05-07T10:01:00.000Z' });
      await seedSource(db, 'd1', { status: 'done', capturedAt: '2026-05-07T10:02:00.000Z' });
      const ocr: OcrRunner = jest.fn().mockResolvedValue('text');
      const p = createProcessor({ db, ocr });

      await p.runOcrSweep();
      await drain(p);

      expect(ocr).toHaveBeenCalledTimes(1);
      expect(ocr).toHaveBeenCalledWith('/tmp/p1.jpg');
    });

    it('processes pending rows in captured_at ASC order', async () => {
      const db = await freshDb();
      await seedSource(db, 'older', { capturedAt: '2026-05-01T00:00:00.000Z' });
      await seedSource(db, 'newer', { capturedAt: '2026-05-07T00:00:00.000Z' });
      const calls: string[] = [];
      const ocr: OcrRunner = async (path) => {
        calls.push(path);
        return 'text';
      };
      const p = createProcessor({ db, ocr });

      await p.runOcrSweep();
      await drain(p);

      expect(calls).toEqual(['/tmp/older.jpg', '/tmp/newer.jpg']);
    });

    it('regression: a row marked failed mid-session is NOT re-processed by a follow-up sweep', async () => {
      // The codex-flagged bug. With the old design, the sweep included
      // 'failed' rows, so each foreground would burn an OCR call on a
      // permanently-broken file and immediately re-mark it 'failed'.
      const db = await freshDb();
      await seedSource(db, 'broken');
      const ocr = jest
        .fn<Promise<string>, [string]>()
        .mockRejectedValue(new Error('decode failed'));
      const p = createProcessor({ db, ocr, maxRetries: 3 });

      await p.runOcrSweep();
      await drain(p);
      expect(ocr).toHaveBeenCalledTimes(3);
      expect((await getStatus(db, 'broken')).status).toBe('failed');

      // Second sweep within the same process — should be a no-op.
      ocr.mockClear();
      await p.runOcrSweep();
      await drain(p);
      expect(ocr).not.toHaveBeenCalled();
    });

    it('skips rows that were deleted before the chain runs', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockResolvedValue('text');
      const p = createProcessor({ db, ocr });

      // Hard-delete before enqueueing. processOne's SELECT returns null
      // (row gone), so OCR is skipped without burning a Vision call.
      await deleteSource(db, 's1', { unlinkFile: () => {} });
      p.enqueueOcr('s1');
      await drain(p);

      expect(ocr).not.toHaveBeenCalled();
    });
  });

  describe('runStartupRecovery', () => {
    it('flips all failed rows back to pending in a single call', async () => {
      const db = await freshDb();
      await seedSource(db, 'f1', { status: 'failed' });
      await seedSource(db, 'f2', { status: 'failed' });
      await seedSource(db, 'p1', { status: 'pending' });
      await seedSource(db, 'd1', { status: 'done' });
      const p = createProcessor({ db, ocr: jest.fn() });

      await p.runStartupRecovery();

      expect((await getStatus(db, 'f1')).status).toBe('pending');
      expect((await getStatus(db, 'f2')).status).toBe('pending');
      expect((await getStatus(db, 'p1')).status).toBe('pending');
      expect((await getStatus(db, 'd1')).status).toBe('done');
    });

    it('a follow-up call within the same process is a no-op (no failed rows left)', async () => {
      const db = await freshDb();
      await seedSource(db, 'f1', { status: 'failed' });
      const p = createProcessor({ db, ocr: jest.fn() });

      await p.runStartupRecovery();
      // f1 is now pending. A second recovery shouldn't change anything.
      await p.runStartupRecovery();
      expect((await getStatus(db, 'f1')).status).toBe('pending');
    });

    it('is a no-op for rows that have been hard-deleted', async () => {
      const db = await freshDb();
      await seedSource(db, 'f1', { status: 'failed' });
      await db.runAsync(`DELETE FROM sources WHERE id = ?`, 'f1');
      const p = createProcessor({ db, ocr: jest.fn() });

      await p.runStartupRecovery();

      // Row is gone; recovery has nothing to flip.
      const row = await db.getFirstAsync(`SELECT id FROM sources WHERE id = ?`, 'f1');
      expect(row).toBeNull();
    });
  });

  describe('chains into extractor on success', () => {
    afterEach(() => {
      _resetExtractorForTests();
    });

    it('calls extractor.enqueueExtraction(id) after writing ocr_text=done', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const enqueueExtraction = jest.fn();
      const fakeExtractor: Extractor = {
        enqueueExtraction,
        runExtractionSweep: jest.fn().mockResolvedValue(undefined),
        runStartupRecovery: jest.fn().mockResolvedValue(undefined),
        resumeEntitlementPaused: jest.fn().mockResolvedValue(undefined),
        _awaitIdle: jest.fn().mockResolvedValue(undefined),
      };
      provideExtractor(fakeExtractor);

      const ocr: OcrRunner = jest.fn().mockResolvedValue('Maru Tonkatsu');
      const p = createProcessor({ db, ocr });
      p.enqueueOcr('s1');
      await drain(p);

      expect(enqueueExtraction).toHaveBeenCalledWith('s1');
      expect(enqueueExtraction).toHaveBeenCalledTimes(1);
    });

    it('does NOT call extractor when OCR fails out (status=failed)', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const enqueueExtraction = jest.fn();
      const fakeExtractor: Extractor = {
        enqueueExtraction,
        runExtractionSweep: jest.fn().mockResolvedValue(undefined),
        runStartupRecovery: jest.fn().mockResolvedValue(undefined),
        resumeEntitlementPaused: jest.fn().mockResolvedValue(undefined),
        _awaitIdle: jest.fn().mockResolvedValue(undefined),
      };
      provideExtractor(fakeExtractor);

      const ocr: OcrRunner = jest.fn().mockRejectedValue(new Error('decode failed'));
      const p = createProcessor({ db, ocr, maxRetries: 3 });
      p.enqueueOcr('s1');
      await drain(p);

      expect(enqueueExtraction).not.toHaveBeenCalled();
    });

    describe('URL fetch path (kind="url")', () => {
      async function seedUrlSource(db: Database, id: string, url: string): Promise<void> {
        const now = '2026-05-12T10:00:00.000Z';
        await db.runAsync(
          `INSERT INTO sources (
            id, kind, platform, trip_id, file_path, url, content_hash, origin,
            ocr_status, extraction_status, captured_at,
            owner_id, created_at, updated_at
          ) VALUES (?, 'url', 'instagram', NULL, NULL, ?, ?, 'share', 'pending', 'pending', ?, 'owner-1', ?, ?)`,
          id,
          url,
          `hash-${id}`,
          now,
          now,
          now,
        );
      }

      it('fetches the post, downloads image, writes caption, chains into OCR', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

        const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
          platform: 'instagram',
          permalink: 'https://instagram.com/p/ABC/',
          caption: 'Mt Fuji is gorgeous',
          imageUrls: ['https://cdn.example/cover.jpg'],
          author: 'someone',
        });
        const downloadImage: ImageDownloader = jest.fn().mockResolvedValue('/storage/cover.jpg');
        const ocr: OcrRunner = jest.fn().mockResolvedValue('Mt Fuji');

        const p = createProcessor({ db, ocr, fetchPost, downloadImage });
        p.enqueueUrlFetch('u1');
        await drain(p);

        const row = await db.getFirstAsync<{
          file_path: string | null;
          caption: string | null;
          ocr_status: string;
          ocr_text: string | null;
        }>(`SELECT file_path, caption, ocr_status, ocr_text FROM sources WHERE id = 'u1'`);
        expect(row?.file_path).toBe('/storage/cover.jpg');
        expect(row?.caption).toBe('Mt Fuji is gorgeous');
        expect(row?.ocr_status).toBe('done');
        // OCR + separator + caption
        expect(row?.ocr_text).toBe('Mt Fuji\n---\nMt Fuji is gorgeous');
        expect(downloadImage).toHaveBeenCalledWith('https://cdn.example/cover.jpg');
        expect(ocr).toHaveBeenCalledWith('/storage/cover.jpg');
      });

      it('falls back to caption-only when image download fails', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

        const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
          platform: 'instagram',
          permalink: 'https://instagram.com/p/ABC/',
          caption: 'just the words',
          imageUrls: ['https://cdn.example/cover.jpg'],
          author: null,
        });
        const downloadImage: ImageDownloader = jest.fn().mockRejectedValue(new Error('CDN 404'));
        const ocr: OcrRunner = jest.fn();

        const p = createProcessor({ db, ocr, fetchPost, downloadImage });
        p.enqueueUrlFetch('u1');
        await drain(p);

        const row = await db.getFirstAsync<{
          file_path: string | null;
          caption: string | null;
          ocr_status: string;
          ocr_text: string | null;
        }>(`SELECT file_path, caption, ocr_status, ocr_text FROM sources WHERE id = 'u1'`);
        expect(row?.file_path).toBeNull();
        expect(row?.caption).toBe('just the words');
        expect(row?.ocr_status).toBe('done');
        expect(row?.ocr_text).toBe('just the words');
        expect(ocr).not.toHaveBeenCalled();
      });

      it('skips download when imageUrls is empty', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

        const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
          platform: 'instagram',
          permalink: 'https://instagram.com/p/ABC/',
          caption: 'no cover available',
          imageUrls: [],
          author: null,
        });
        const downloadImage: ImageDownloader = jest.fn();
        const ocr: OcrRunner = jest.fn();

        const p = createProcessor({ db, ocr, fetchPost, downloadImage });
        p.enqueueUrlFetch('u1');
        await drain(p);

        expect(downloadImage).not.toHaveBeenCalled();
        expect(ocr).not.toHaveBeenCalled();
        const row = await db.getFirstAsync<{ ocr_text: string | null }>(
          `SELECT ocr_text FROM sources WHERE id = 'u1'`,
        );
        expect(row?.ocr_text).toBe('no cover available');
      });

      it('retries retryable worker failures up to maxRetries, leaves extraction_status pending', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

        const fetchPost: UrlFetcher = jest
          .fn()
          .mockRejectedValue(new FetchPostError('boom', { kind: 'retryable' }));
        const p = createProcessor({
          db,
          ocr: jest.fn(),
          fetchPost,
          maxRetries: 3,
        });
        p.enqueueUrlFetch('u1');
        await drain(p);

        expect(fetchPost).toHaveBeenCalledTimes(3);
        const row = await db.getFirstAsync<{
          ocr_status: string;
          extraction_status: string;
        }>(`SELECT ocr_status, extraction_status FROM sources WHERE id = 'u1'`);
        expect(row?.ocr_status).toBe('failed');
        // Retryable-exhausted: extraction_status stays 'pending' so startup
        // recovery promotes this row back to 'pending' next launch.
        expect(row?.extraction_status).toBe('pending');
      });

      it('runStartupRecovery skips rows with extraction_status=failed (permanent URL failures)', async () => {
        const db = await freshDb();
        // Seed two URL rows: one permanently failed, one retryable-exhausted.
        await seedUrlSource(db, 'perm', 'https://instagram.com/p/PERM/');
        await seedUrlSource(db, 'retry', 'https://instagram.com/p/RETRY/');
        await db.runAsync(
          `UPDATE sources SET ocr_status='failed', extraction_status='failed' WHERE id='perm'`,
        );
        await db.runAsync(
          `UPDATE sources SET ocr_status='failed', extraction_status='pending' WHERE id='retry'`,
        );

        const p = createProcessor({ db, ocr: jest.fn() });
        await p.runStartupRecovery();

        const perm = await db.getFirstAsync<{ ocr_status: string }>(
          `SELECT ocr_status FROM sources WHERE id='perm'`,
        );
        const retry = await db.getFirstAsync<{ ocr_status: string }>(
          `SELECT ocr_status FROM sources WHERE id='retry'`,
        );
        expect(perm?.ocr_status).toBe('failed');
        expect(retry?.ocr_status).toBe('pending');
      });

      it('does not retry permanent worker failures', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

        const fetchPost: UrlFetcher = jest
          .fn()
          .mockRejectedValue(new FetchPostError('private', { kind: 'permanent', code: 'private' }));
        const p = createProcessor({
          db,
          ocr: jest.fn(),
          fetchPost,
          maxRetries: 3,
        });
        p.enqueueUrlFetch('u1');
        await drain(p);

        expect(fetchPost).toHaveBeenCalledTimes(1);
        const row = await db.getFirstAsync<{
          ocr_status: string;
          extraction_status: string;
        }>(`SELECT ocr_status, extraction_status FROM sources WHERE id = 'u1'`);
        expect(row?.ocr_status).toBe('failed');
        expect(row?.extraction_status).toBe('failed');
      });

      it('tags url_fetch Sentry events with platform + worker_error_code', async () => {
        // Verifies the §Monitoring tag enrichment from the TikTok rehydration
        // spec — Sentry events from url_fetch failures must be filterable by
        // platform and worker_error_code so we can split "TikTok extraction
        // failing" from generic noise. Tags only fire in production, so flip
        // __DEV__ off for the duration of the test.
        const g = globalThis as { __DEV__?: boolean };
        const prev = g.__DEV__;
        g.__DEV__ = false;
        try {
          (Sentry.captureException as jest.Mock).mockClear();

          const db = await freshDb();
          await seedUrlSource(db, 'tt1', 'https://www.tiktok.com/@u/photo/9');

          const fetchPost: UrlFetcher = jest.fn().mockRejectedValue(
            new FetchPostError('not-found', {
              kind: 'permanent',
              code: 'not-found',
            }),
          );
          const p = createProcessor({
            db,
            ocr: jest.fn(),
            fetchPost,
            maxRetries: 3,
          });
          p.enqueueUrlFetch('tt1');
          await drain(p);

          expect(Sentry.captureException).toHaveBeenCalledTimes(1);
          const [, opts] = (Sentry.captureException as jest.Mock).mock.calls[0];
          expect(opts.tags).toEqual({
            pipeline_stage: 'url_fetch',
            platform: 'tiktok',
            worker_error_code: 'not-found',
          });
        } finally {
          g.__DEV__ = prev;
        }
      });

      it('runUrlFetchSweep picks up kind=url rows with NULL file_path AND NULL caption', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');
        // Already-fetched URL row — should be skipped by the sweep.
        await db.runAsync(
          `INSERT INTO sources (
            id, kind, platform, trip_id, file_path, url, caption, content_hash, origin,
            ocr_status, extraction_status, captured_at,
            owner_id, created_at, updated_at
          ) VALUES ('u2', 'url', 'tiktok', NULL, '/p.jpg', ?, 'old caption', 'h2',
                    'share', 'pending', 'pending', ?, 'o', ?, ?)`,
          'https://tiktok.com/@u/video/123',
          '2026-05-11T10:00:00.000Z',
          '2026-05-11T10:00:00.000Z',
          '2026-05-11T10:00:00.000Z',
        );

        const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
          platform: 'instagram',
          permalink: 'https://instagram.com/p/ABC/',
          caption: 'cap',
          imageUrls: [],
          author: null,
        });
        const p = createProcessor({ db, ocr: jest.fn(), fetchPost });
        await p.runUrlFetchSweep();
        await drain(p);

        expect(fetchPost).toHaveBeenCalledTimes(1);
        expect(fetchPost).toHaveBeenCalledWith('https://instagram.com/p/ABC/');
      });

      it('enqueueUrlFetch is a no-op when no fetcher provisioned', async () => {
        const db = await freshDb();
        await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');
        // Provision processor WITHOUT fetchPost — kind='url' rows should be ignored.
        const p = createProcessor({ db, ocr: jest.fn() });
        p.enqueueUrlFetch('u1');
        await drain(p);
        const row = await db.getFirstAsync<{ ocr_status: string }>(
          `SELECT ocr_status FROM sources WHERE id = 'u1'`,
        );
        expect(row?.ocr_status).toBe('pending');
      });

      describe('entitlement-required (401) URL fetch path', () => {
        it('sets url_fetch_paused_reason=entitlement, leaves ocr_status pending, and does not retry', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

          const fetchPost: UrlFetcher = jest
            .fn()
            .mockRejectedValue(
              new FetchPostError('fetch-post-entitlement-required', {
                kind: 'entitlement-required',
              }),
            );
          const p = createProcessor({ db, ocr: jest.fn(), fetchPost, maxRetries: 3 });
          p.enqueueUrlFetch('u1');
          await drain(p);

          // fetchPost called exactly once — no retry storm.
          expect(fetchPost).toHaveBeenCalledTimes(1);

          const row = await db.getFirstAsync<{
            ocr_status: string;
            extraction_status: string;
            url_fetch_paused_reason: string | null;
          }>(
            `SELECT ocr_status, extraction_status, url_fetch_paused_reason FROM sources WHERE id = 'u1'`,
          );
          // Only url_fetch_paused_reason is stamped — status columns are untouched.
          expect(row?.ocr_status).toBe('pending');
          expect(row?.extraction_status).toBe('pending');
          expect(row?.url_fetch_paused_reason).toBe('entitlement');
        });

        it('runUrlFetchSweep does NOT pick up rows with url_fetch_paused_reason set', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');
          // Manually pause the row as if a prior session hit 401.
          await db.runAsync(
            `UPDATE sources SET url_fetch_paused_reason = 'entitlement' WHERE id = 'u1'`,
          );

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/ABC/',
            caption: 'cap',
            imageUrls: [],
            author: null,
          });
          const p = createProcessor({ db, ocr: jest.fn(), fetchPost });
          await p.runUrlFetchSweep();
          await drain(p);

          expect(fetchPost).not.toHaveBeenCalled();
        });

        it('resumeUrlFetchEntitlementPaused clears the column and re-enqueues paused rows', async () => {
          const db = await freshDb();
          // Two paused URL sources.
          await seedUrlSource(db, 'pa', 'https://instagram.com/p/PA/');
          await seedUrlSource(db, 'pb', 'https://instagram.com/p/PB/');
          await db.runAsync(
            `UPDATE sources SET url_fetch_paused_reason = 'entitlement' WHERE id IN ('pa', 'pb')`,
          );
          // One non-paused URL source — must NOT be re-fetched.
          await seedUrlSource(db, 'pc', 'https://instagram.com/p/PC/');

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/PA/',
            caption: 'resumed',
            imageUrls: [],
            author: null,
          });
          const p = createProcessor({ db, ocr: jest.fn(), fetchPost });
          await p.resumeUrlFetchEntitlementPaused();
          await drain(p);

          // fetchPost called exactly twice (one per formerly-paused row).
          expect(fetchPost).toHaveBeenCalledTimes(2);

          // Both paused columns must be cleared.
          const pa = await db.getFirstAsync<{ url_fetch_paused_reason: string | null }>(
            `SELECT url_fetch_paused_reason FROM sources WHERE id = 'pa'`,
          );
          const pb = await db.getFirstAsync<{ url_fetch_paused_reason: string | null }>(
            `SELECT url_fetch_paused_reason FROM sources WHERE id = 'pb'`,
          );
          expect(pa?.url_fetch_paused_reason).toBeNull();
          expect(pb?.url_fetch_paused_reason).toBeNull();
        });

        it('resumeUrlFetchEntitlementPaused is a no-op when no rows are paused', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/ABC/');

          const fetchPost: UrlFetcher = jest.fn();
          const p = createProcessor({ db, ocr: jest.fn(), fetchPost });
          await p.resumeUrlFetchEntitlementPaused();
          await drain(p);

          expect(fetchPost).not.toHaveBeenCalled();
        });

        it('paused entitlement row emits stage.done (not stage.failed) — no Sentry, no failed diagnostic', async () => {
          // Regression guard: urlFetchStage.failed() must NOT be called before
          // the entitlement branch runs, otherwise the pipeline-log records
          // status='failed' (settled flag blocks the subsequent .done()) and
          // Sentry fires a false-positive alert on every 401.
          const g = globalThis as { __DEV__?: boolean };
          const prev = g.__DEV__;
          g.__DEV__ = false;
          try {
            (Sentry.captureException as jest.Mock).mockClear();

            const db = await freshDb();
            await seedUrlSource(db, 'ent1', 'https://instagram.com/p/ENT/');

            const fetchPost: UrlFetcher = jest
              .fn()
              .mockRejectedValue(
                new FetchPostError('fetch-post-entitlement-required', {
                  kind: 'entitlement-required',
                }),
              );
            const p = createProcessor({ db, ocr: jest.fn(), fetchPost, maxRetries: 3 });
            p.enqueueUrlFetch('ent1');
            await drain(p);
            await flushPipelineInserts();

            // 1. No Sentry alert — entitlement pause is expected, not exceptional.
            expect(Sentry.captureException).not.toHaveBeenCalled();

            // 2. Pipeline diagnostic must record the stage as 'done', not 'failed'.
            const events = await db.getAllAsync<{ stage: string; status: string }>(
              `SELECT stage, status FROM pipeline_events WHERE source_id = 'ent1'`,
            );
            expect(events).toHaveLength(1);
            expect(events[0]).toEqual({ stage: 'url_fetch', status: 'done' });
          } finally {
            g.__DEV__ = prev;
          }
        });
      });

      describe('carousel (multi-image) URL sources', () => {
        // Each unique URL gets a unique downloaded path so we can verify
        // which downloads ran. Treat the fake downloader as a permanent-path
        // factory; `disposeFile` is what discriminates "cover persisted" vs
        // "slide cleaned up".
        function pathFor(imageUrl: string) {
          return `/storage/${imageUrl.replace(/[^a-z0-9]/gi, '_')}.jpg`;
        }

        it('downloads all slides, OCRs each, concats with caption, deletes slide files', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/CAR/');

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/CAR/',
            caption: 'Mt Fuji spots',
            imageUrls: [
              'https://cdn/cover.jpg',
              'https://cdn/slide2.jpg',
              'https://cdn/slide3.jpg',
            ],
            author: 'creator',
          });
          const downloadImage: ImageDownloader = jest
            .fn()
            .mockImplementation(async (u: string) => pathFor(u));
          const ocr: OcrRunner = jest.fn().mockImplementation(async (p: string) => {
            if (p.includes('cover')) return 'COVER TEXT';
            if (p.includes('slide2')) return 'SLIDE 2';
            if (p.includes('slide3')) return 'SLIDE 3';
            return '';
          });
          const disposeFile = jest.fn().mockResolvedValue(undefined);

          const p = createProcessor({
            db,
            ocr,
            fetchPost,
            downloadImage,
            disposeFile,
          });
          p.enqueueUrlFetch('u1');
          await drain(p);

          const row = await db.getFirstAsync<{
            file_path: string | null;
            caption: string | null;
            ocr_status: string;
            ocr_text: string | null;
          }>(`SELECT file_path, caption, ocr_status, ocr_text FROM sources WHERE id = 'u1'`);

          expect(row?.file_path).toBe(pathFor('https://cdn/cover.jpg'));
          expect(row?.caption).toBe('Mt Fuji spots');
          expect(row?.ocr_status).toBe('done');
          expect(row?.ocr_text).toBe('COVER TEXT\n---\nSLIDE 2\n---\nSLIDE 3\n---\nMt Fuji spots');

          // Cover stays; slides 2 and 3 are deleted.
          expect(disposeFile).toHaveBeenCalledTimes(2);
          const disposed = (disposeFile.mock.calls as string[][]).map((c) => c[0]);
          expect(disposed).toEqual(
            expect.arrayContaining([
              pathFor('https://cdn/slide2.jpg'),
              pathFor('https://cdn/slide3.jpg'),
            ]),
          );
          expect(disposed).not.toContain(pathFor('https://cdn/cover.jpg'));

          // Per spec §Tests: carousel flow emits url_fetch done →
          // image_download done → 3 × ocr done (cover + 2 slides). Newest
          // first from the table; reverse for chronological order.
          await flushPipelineInserts();
          const events = await db.getAllAsync<{
            stage: string;
            status: string;
            source_id: string | null;
          }>(
            `SELECT stage, status, source_id FROM pipeline_events
              WHERE source_id = 'u1' ORDER BY id ASC`,
          );
          expect(events.map((e) => `${e.stage}:${e.status}`)).toEqual([
            'url_fetch:done',
            'image_download:done',
            'ocr:done',
            'ocr:done',
            'ocr:done',
          ]);
        });

        it('tolerates a slide download failure and continues with the rest', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/CAR/');

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/CAR/',
            caption: 'cap',
            imageUrls: [
              'https://cdn/cover.jpg',
              'https://cdn/slide2.jpg',
              'https://cdn/slide3.jpg',
            ],
            author: null,
          });
          const downloadImage: ImageDownloader = jest.fn().mockImplementation(async (u: string) => {
            if (u.includes('slide2')) throw new Error('CDN 404');
            return pathFor(u);
          });
          const ocr: OcrRunner = jest.fn().mockImplementation(async (p: string) => {
            if (p.includes('cover')) return 'COVER';
            if (p.includes('slide3')) return 'S3';
            return '';
          });
          const disposeFile = jest.fn().mockResolvedValue(undefined);

          const p = createProcessor({
            db,
            ocr,
            fetchPost,
            downloadImage,
            disposeFile,
          });
          p.enqueueUrlFetch('u1');
          await drain(p);

          const row = await db.getFirstAsync<{
            ocr_status: string;
            ocr_text: string | null;
          }>(`SELECT ocr_status, ocr_text FROM sources WHERE id = 'u1'`);
          expect(row?.ocr_status).toBe('done');
          // Slide 2 dropped silently; slide 3 contributes.
          expect(row?.ocr_text).toBe('COVER\n---\nS3\n---\ncap');
          // Only slide 3 was downloaded → only 1 dispose call.
          expect(disposeFile).toHaveBeenCalledTimes(1);
          expect(disposeFile).toHaveBeenCalledWith(pathFor('https://cdn/slide3.jpg'));

          // Per spec §Tests: slide-N download failure surfaces as
          // image_download done with downloadedCount < requestedCount, NOT a
          // failed event. (The `extra` props are firehose-only and not in
          // the row, so we just assert the status.)
          await flushPipelineInserts();
          const downloadEvents = await db.getAllAsync<{ stage: string; status: string }>(
            `SELECT stage, status FROM pipeline_events
              WHERE source_id = 'u1' AND stage = 'image_download'`,
          );
          expect(downloadEvents).toEqual([{ stage: 'image_download', status: 'done' }]);
        });

        it('tolerates per-slide OCR failures', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/CAR/');

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/CAR/',
            caption: 'cap',
            imageUrls: ['https://cdn/cover.jpg', 'https://cdn/slide2.jpg'],
            author: null,
          });
          const downloadImage: ImageDownloader = jest
            .fn()
            .mockImplementation(async (u: string) => pathFor(u));
          const ocr: OcrRunner = jest.fn().mockImplementation(async (p: string) => {
            if (p.includes('slide2')) throw new Error('Vision boom');
            return 'COVER';
          });
          const disposeFile = jest.fn().mockResolvedValue(undefined);

          const p = createProcessor({
            db,
            ocr,
            fetchPost,
            downloadImage,
            disposeFile,
          });
          p.enqueueUrlFetch('u1');
          await drain(p);

          const row = await db.getFirstAsync<{
            ocr_status: string;
            ocr_text: string | null;
          }>(`SELECT ocr_status, ocr_text FROM sources WHERE id = 'u1'`);
          expect(row?.ocr_status).toBe('done');
          expect(row?.ocr_text).toBe('COVER\n---\ncap');
        });

        it('falls back to caption-only when the cover download fails', async () => {
          const db = await freshDb();
          await seedUrlSource(db, 'u1', 'https://instagram.com/p/CAR/');

          const fetchPost: UrlFetcher = jest.fn().mockResolvedValue({
            platform: 'instagram',
            permalink: 'https://instagram.com/p/CAR/',
            caption: 'list of places',
            imageUrls: ['https://cdn/cover.jpg', 'https://cdn/slide2.jpg'],
            author: null,
          });
          const downloadImage: ImageDownloader = jest.fn().mockRejectedValue(new Error('CDN dead'));
          const ocr: OcrRunner = jest.fn();
          const disposeFile = jest.fn();

          const p = createProcessor({
            db,
            ocr,
            fetchPost,
            downloadImage,
            disposeFile,
          });
          p.enqueueUrlFetch('u1');
          await drain(p);

          const row = await db.getFirstAsync<{
            file_path: string | null;
            ocr_status: string;
            ocr_text: string | null;
          }>(`SELECT file_path, ocr_status, ocr_text FROM sources WHERE id = 'u1'`);
          expect(row?.file_path).toBeNull();
          expect(row?.ocr_status).toBe('done');
          expect(row?.ocr_text).toBe('list of places');
          expect(ocr).not.toHaveBeenCalled();
          expect(disposeFile).not.toHaveBeenCalled();
        });
      });
    });

    it('is a no-op when no extractor has been provided', async () => {
      // Default state — provideExtractor was never called this run.
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockResolvedValue('hi');
      const p = createProcessor({ db, ocr });

      // No throw is the assertion. The OCR write should still complete.
      p.enqueueOcr('s1');
      await drain(p);
      const row = await db.getFirstAsync<{ ocr_status: string }>(
        `SELECT ocr_status FROM sources WHERE id = 's1'`,
      );
      expect(row?.ocr_status).toBe('done');
    });
  });
});
