import {
  openDatabase,
  runMigrations,
  insertSource,
  softDeleteSource,
  type Database,
} from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import * as liveQuery from '@/modules/storage/live-query';
import { createProcessor, type OcrRunner, type Processor } from '../processing';
import {
  provideExtractor,
  _resetExtractorForTests,
  type Extractor,
} from '@/modules/extraction';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
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

async function getStatus(db: Database, id: string): Promise<{ status: string; text: string | null }> {
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
      const ocr = jest.fn<Promise<string>, [string]>().mockRejectedValue(new Error('decode failed'));
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

    it('skips rows that were soft-deleted between enqueue and run', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      const ocr: OcrRunner = jest.fn().mockResolvedValue('text');
      const p = createProcessor({ db, ocr });

      p.enqueueOcr('s1');
      // Soft delete before the chain reaches it.
      await softDeleteSource(db, 's1');
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

    it('does not touch soft-deleted rows', async () => {
      const db = await freshDb();
      await seedSource(db, 'f1', { status: 'failed' });
      await db.runAsync(`UPDATE sources SET deleted_at = ? WHERE id = ?`, '2026-05-07T11:00:00Z', 'f1');
      const p = createProcessor({ db, ocr: jest.fn() });

      await p.runStartupRecovery();

      // Status remains 'failed' because the recovery only touches non-deleted rows.
      const row = await db.getFirstAsync<{ ocr_status: string }>(
        `SELECT ocr_status FROM sources WHERE id = ?`, 'f1',
      );
      expect(row?.ocr_status).toBe('failed');
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
        _awaitIdle: jest.fn().mockResolvedValue(undefined),
      };
      provideExtractor(fakeExtractor);

      const ocr: OcrRunner = jest.fn().mockRejectedValue(new Error('decode failed'));
      const p = createProcessor({ db, ocr, maxRetries: 3 });
      p.enqueueOcr('s1');
      await drain(p);

      expect(enqueueExtraction).not.toHaveBeenCalled();
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
