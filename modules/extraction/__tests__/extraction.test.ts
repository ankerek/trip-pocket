import {
  openDatabase,
  runMigrations,
  insertScreenshot,
  type Database,
} from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import * as liveQuery from '@/modules/storage/live-query';
import {
  createExtractor,
  ExtractionError,
  type ExtractionRunner,
  type Extractor,
} from '../extraction';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

const NOW = '2026-05-08T10:00:00.000Z';

async function seedScreenshot(
  db: Database,
  id: string,
  opts: {
    ocrText?: string | null;
    ocrStatus?: 'pending' | 'done' | 'failed';
    extractionStatus?: 'pending' | 'done' | 'failed';
    capturedAt?: string;
  } = {},
): Promise<void> {
  await insertScreenshot(db, {
    id,
    tripId: null,
    filePath: `/tmp/${id}.jpg`,
    contentHash: `hash-${id}`,
    source: 'manual',
    capturedAt: opts.capturedAt ?? NOW,
    ownerId: 'owner-1',
  });
  await db.runAsync(
    `UPDATE screenshots
        SET ocr_status = ?, ocr_text = ?, extraction_status = ?, updated_at = ?
      WHERE id = ?`,
    opts.ocrStatus ?? 'done',
    opts.ocrText === undefined ? `text-${id}` : opts.ocrText,
    opts.extractionStatus ?? 'pending',
    NOW,
    id,
  );
}

async function getStatus(
  db: Database,
  id: string,
): Promise<{ status: string }> {
  const row = await db.getFirstAsync<{ extraction_status: string }>(
    `SELECT extraction_status FROM screenshots WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`row ${id} missing`);
  return { status: row.extraction_status };
}

async function getPlaces(
  db: Database,
  screenshotId: string,
): Promise<
  Array<{
    name: string;
    city: string;
    address: string | null;
    category: string;
    latitude: number | null;
    apple_maps_url: string | null;
  }>
> {
  return db.getAllAsync(
    `SELECT name, city, address, category, latitude, apple_maps_url
       FROM extracted_places WHERE screenshot_id = ? ORDER BY created_at ASC`,
    screenshotId,
  );
}

// Drive setTimeout substitution: tests can capture pending timers and fire
// them deterministically without globally faking the Jest clock.
function mockTimer() {
  type Pending = { cb: () => void; ms: number };
  const pending: Pending[] = [];
  const setTimer = (cb: () => void, ms: number): unknown => {
    pending.push({ cb, ms });
    return pending.length - 1;
  };
  return {
    setTimer,
    fireAll: () => {
      while (pending.length) pending.shift()!.cb();
    },
    fireFirst: () => pending.shift()?.cb(),
    pendingCount: () => pending.length,
    pendingDelays: () => pending.map((p) => p.ms),
  };
}

const okExtract = (
  places: Array<{
    name: string;
    city: string;
    category: 'place' | 'food' | 'activity';
    address?: string;
  }>,
): ExtractionRunner =>
  jest.fn(async () => ({
    places: places.map((p) => ({ address: '', ...p })),
    model: 'gemini-2.5-flash-lite',
  }));

let counter = 0;
const seqUuid = (): string => {
  counter += 1;
  return `uuid-${counter}`;
};

beforeEach(() => {
  counter = 0;
});

async function drain(e: Extractor): Promise<void> {
  await e._awaitIdle();
}

describe('createExtractor', () => {
  let notifySpy: jest.SpyInstance;
  beforeEach(() => {
    notifySpy = jest.spyOn(liveQuery, 'notifyChange');
  });
  afterEach(() => {
    notifySpy.mockRestore();
  });

  describe('processOne happy path', () => {
    it('inserts places + sets extraction_status=done + fires notifyChange', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1', { ocrText: 'Maru Tonkatsu, Shibuya. Try Tsukiji.' });
      const extract = okExtract([
        { name: 'Maru Tonkatsu', city: 'Tokyo', category: 'food' },
        { name: 'Tsukiji Outer Market', city: 'Tokyo', category: 'place' },
      ]);
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect((await getStatus(db, 's1')).status).toBe('done');
      const rows = await getPlaces(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe('Maru Tonkatsu');
      expect(rows[1]?.name).toBe('Tsukiji Outer Market');
      expect(notifySpy).toHaveBeenCalledWith('extracted_places');
      expect(notifySpy).toHaveBeenCalledWith('screenshots');
    });

    it('persists the address column and leaves geocode fields NULL', async () => {
      // MVP intentionally skips geocoding (Apple's CLGeocoder/MKLocalSearch
      // are unreliable for non-English-script countries). Address is what
      // PlaceRow's tap-to-Maps fallback uses to build a precise search URL,
      // and is the input to the v1.x place-enrichment call.
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const e = createExtractor({
        db,
        extract: okExtract([
          {
            name: 'Kosoan',
            city: 'Tokyo',
            address: '1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan',
            category: 'food',
          },
          { name: 'No Address Place', city: 'Kyoto', category: 'place' },
        ]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlaces(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.address).toBe(
        '1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan',
      );
      expect(rows[1]?.address).toBe('');
      // Geocode fields stay NULL — they're filled by future v1.x enrichment.
      expect(rows[0]?.latitude).toBeNull();
      expect(rows[0]?.apple_maps_url).toBeNull();
      expect(rows[1]?.latitude).toBeNull();
      expect(rows[1]?.apple_maps_url).toBeNull();
    });
  });

  describe('empty-OCR short-circuit', () => {
    it('skips the proxy entirely and marks done with 0 places', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1', { ocrText: '' });
      const extract = jest.fn() as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).not.toHaveBeenCalled();
      expect((await getStatus(db, 's1')).status).toBe('done');
      expect(await getPlaces(db, 's1')).toEqual([]);
    });

    it('treats whitespace-only OCR as empty', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1', { ocrText: '   \n\t   ' });
      const extract = jest.fn() as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).not.toHaveBeenCalled();
      expect((await getStatus(db, 's1')).status).toBe('done');
    });
  });

  describe('per-call dedup of LLM output', () => {
    it('drops case-insensitive name + trimmed-city duplicates before INSERT', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const extract = okExtract([
        { name: 'Starbucks', city: 'Tokyo', category: 'food' },
        { name: 'starbucks', city: 'Tokyo ', category: 'food' },
        { name: 'Tsukiji', city: 'Tokyo', category: 'place' },
      ]);
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlaces(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['Starbucks', 'Tsukiji']);
    });
  });

  describe('failure + retry', () => {
    it('retries a retryable error up to maxRetries and then marks failed', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const extract = jest.fn(async () => {
        throw new ExtractionError('upstream burning', { kind: 'retryable' });
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        maxRetries: 3,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).toHaveBeenCalledTimes(3);
      expect((await getStatus(db, 's1')).status).toBe('failed');
    });

    it('marks a permanent error as failed immediately, no retries', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const extract = jest.fn(async () => {
        throw new ExtractionError('bad request', { kind: 'permanent' });
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        maxRetries: 3,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).toHaveBeenCalledTimes(1);
      expect((await getStatus(db, 's1')).status).toBe('failed');
    });

    it('a fresh extractor (simulated relaunch) gets a new retry budget', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const extract = jest.fn(async () => {
        throw new ExtractionError('boom', { kind: 'retryable' });
      }) as unknown as ExtractionRunner;
      const e1 = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        maxRetries: 3,
      });
      e1.enqueueExtraction('s1');
      await drain(e1);
      expect(extract).toHaveBeenCalledTimes(3);

      // Simulate relaunch: startup recovery flips failed → pending.
      await e1.runStartupRecovery();
      const e2 = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        maxRetries: 3,
      });
      e2.enqueueExtraction('s1');
      await drain(e2);
      expect(extract).toHaveBeenCalledTimes(6); // 3 more for the new budget
    });
  });

  describe('429 deferral', () => {
    it('does NOT consume retry budget; re-enqueues after retryAfterMs; row stays pending during the wait', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const timer = mockTimer();
      let calls = 0;
      const extract = jest.fn(async () => {
        calls += 1;
        if (calls < 4) {
          throw new ExtractionError('rate limited', {
            kind: 'deferred',
            retryAfterMs: 60000,
          });
        }
        return { places: [], model: 'gemini-2.5-flash-lite' };
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        setTimer: timer.setTimer,
        maxRetries: 3,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      // After the first call, we should be waiting on a timer.
      expect(extract).toHaveBeenCalledTimes(1);
      expect(timer.pendingCount()).toBe(1);
      expect(timer.pendingDelays()).toEqual([60000]);
      expect((await getStatus(db, 's1')).status).toBe('pending');

      timer.fireFirst();
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(2);
      expect(timer.pendingCount()).toBe(1);
      expect((await getStatus(db, 's1')).status).toBe('pending');

      timer.fireFirst();
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(3);

      timer.fireFirst();
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(4);
      expect((await getStatus(db, 's1')).status).toBe('done');
    });

    it('re-enqueue from a sweep is deduped while a 429 deferral timer is pending', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const timer = mockTimer();
      const extract = jest.fn(async () => {
        throw new ExtractionError('429', { kind: 'deferred', retryAfterMs: 60000 });
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
        setTimer: timer.setTimer,
      });

      e.enqueueExtraction('s1');
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(timer.pendingCount()).toBe(1);

      // Foreground sweep tries to re-enqueue while we're still waiting.
      e.enqueueExtraction('s1');
      e.enqueueExtraction('s1');
      await drain(e);
      // No additional calls — the dedup set kept it engaged.
      expect(extract).toHaveBeenCalledTimes(1);
      expect(timer.pendingCount()).toBe(1);
    });
  });

  describe('queue dedup + serialization', () => {
    it('two concurrent enqueueExtraction(id) only invoke extract once', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      const extract = okExtract([]);
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).toHaveBeenCalledTimes(1);
    });

    it('processes ids strictly serially', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 'sA');
      await seedScreenshot(db, 'sB');
      const order: string[] = [];
      const extract = jest.fn(async (text: string) => {
        order.push(text.startsWith('text-sA') ? 'A-start' : 'B-start');
        await new Promise((r) => setImmediate(r));
        order.push(text.startsWith('text-sA') ? 'A-end' : 'B-end');
        return { places: [], model: 'gemini-2.5-flash-lite' };
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('sA');
      e.enqueueExtraction('sB');
      await drain(e);

      expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    });
  });

  describe('soft-delete handling', () => {
    it('skips screenshots that were soft-deleted between enqueue and run', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1');
      await db.runAsync(`UPDATE screenshots SET deleted_at = ? WHERE id = 's1'`, NOW);

      const extract = okExtract([{ name: 'X', city: 'Y', category: 'place' }]);
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      e.enqueueExtraction('s1');
      await drain(e);

      expect(extract).not.toHaveBeenCalled();
      expect(await getPlaces(db, 's1')).toEqual([]);
    });
  });

  describe('runExtractionSweep', () => {
    it('picks only extraction_status=pending AND ocr_status=done, ordered by captured_at ASC', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 'sA', {
        ocrStatus: 'done',
        extractionStatus: 'pending',
        capturedAt: '2026-05-01T10:00:00.000Z',
      });
      await seedScreenshot(db, 'sB', {
        ocrStatus: 'done',
        extractionStatus: 'pending',
        capturedAt: '2026-05-02T10:00:00.000Z',
      });
      // OCR not done: skipped.
      await seedScreenshot(db, 'sC', {
        ocrStatus: 'pending',
        extractionStatus: 'pending',
        capturedAt: '2026-05-03T10:00:00.000Z',
      });
      // extraction already done: skipped.
      await seedScreenshot(db, 'sD', {
        ocrStatus: 'done',
        extractionStatus: 'done',
        capturedAt: '2026-05-04T10:00:00.000Z',
      });
      // failed: skipped (mid-session sweep posture).
      await seedScreenshot(db, 'sE', {
        ocrStatus: 'done',
        extractionStatus: 'failed',
        capturedAt: '2026-05-05T10:00:00.000Z',
      });

      const seen: string[] = [];
      const extract = jest.fn(async (text: string) => {
        const id = text.replace('text-', '');
        seen.push(id);
        return { places: [], model: 'gemini-2.5-flash-lite' };
      }) as unknown as ExtractionRunner;
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      await e.runExtractionSweep();
      await drain(e);

      expect(seen).toEqual(['sA', 'sB']);
    });
  });

  describe('runStartupRecovery', () => {
    it('flips failed extractions back to pending exactly once per process', async () => {
      const db = await freshDb();
      await seedScreenshot(db, 's1', { extractionStatus: 'failed' });
      await seedScreenshot(db, 's2', { extractionStatus: 'failed' });
      await seedScreenshot(db, 's3', { extractionStatus: 'done' });

      const e = createExtractor({
        db,
        extract: okExtract([]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      await e.runStartupRecovery();

      expect((await getStatus(db, 's1')).status).toBe('pending');
      expect((await getStatus(db, 's2')).status).toBe('pending');
      expect((await getStatus(db, 's3')).status).toBe('done');

      // Subsequent calls in the same process are a no-op.
      await e.runStartupRecovery();
      expect((await getStatus(db, 's1')).status).toBe('pending');
    });
  });
});
