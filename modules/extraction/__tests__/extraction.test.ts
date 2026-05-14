import { openDatabase, runMigrations, insertSource, type Database } from '@/modules/storage';
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

async function seedSource(
  db: Database,
  id: string,
  opts: {
    ocrText?: string | null;
    ocrStatus?: 'pending' | 'done' | 'failed';
    extractionStatus?: 'pending' | 'done' | 'failed';
    capturedAt?: string;
    tripId?: string | null;
  } = {},
): Promise<void> {
  await insertSource(db, {
    id,
    tripId: opts.tripId ?? null,
    filePath: `/tmp/${id}.jpg`,
    contentHash: `hash-${id}`,
    origin: 'manual',
    capturedAt: opts.capturedAt ?? NOW,
    ownerId: 'owner-1',
  });
  await db.runAsync(
    `UPDATE sources
        SET ocr_status = ?, ocr_text = ?, extraction_status = ?, updated_at = ?
      WHERE id = ?`,
    opts.ocrStatus ?? 'done',
    opts.ocrText === undefined ? `text-${id}` : opts.ocrText,
    opts.extractionStatus ?? 'pending',
    NOW,
    id,
  );
}

async function getStatus(db: Database, id: string): Promise<{ status: string }> {
  const row = await db.getFirstAsync<{ extraction_status: string }>(
    `SELECT extraction_status FROM sources WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`row ${id} missing`);
  return { status: row.extraction_status };
}

type PlaceJoin = {
  place_id: string;
  name: string;
  city: string | null;
  country_code: string | null;
  category: string | null;
  normalized_key: string;
  trip_id: string | null;
  enrichment_status: string;
  extracted_address: string | null;
  raw_text: string | null;
  confidence: number | null;
};

async function getPlacesForSource(db: Database, sourceId: string): Promise<PlaceJoin[]> {
  return db.getAllAsync<PlaceJoin>(
    `SELECT p.id AS place_id, p.name, p.city, p.country_code, p.category, p.normalized_key,
            p.trip_id, p.enrichment_status,
            ps.extracted_address, ps.raw_text, ps.confidence
       FROM place_sources ps
       JOIN places p ON p.id = ps.place_id
      WHERE ps.source_id = ?
   ORDER BY p.created_at ASC`,
    sourceId,
  );
}

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
    country_code?: string;
  }>,
): ExtractionRunner =>
  jest.fn(async () => ({
    places: places.map((p) => ({ address: '', country_code: '', ...p })),
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
    it('inserts canonical places + junctions, sets sources.extraction_status=done, fires notifyChange', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', { ocrText: 'Maru Tonkatsu, Shibuya. Try Tsukiji.' });
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
      const rows = await getPlacesForSource(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe('Maru Tonkatsu');
      expect(rows[0]?.normalized_key).toBe('maru tonkatsu|tokyo');
      expect(rows[0]?.enrichment_status).toBe('pending');
      expect(rows[1]?.name).toBe('Tsukiji Outer Market');
      expect(notifySpy).toHaveBeenCalledWith('places');
      expect(notifySpy).toHaveBeenCalledWith('place_sources');
      expect(notifySpy).toHaveBeenCalledWith('sources');
    });

    it('persists extracted_address on the junction row, leaves enrichment fields NULL on the place', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
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

      const rows = await getPlacesForSource(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.extracted_address).toBe(
        '1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan',
      );
      expect(rows[1]?.extracted_address).toBe('');

      // Enrichment-derived fields stay NULL until /enrich runs.
      const enrichment = await db.getAllAsync<{
        latitude: number | null;
        external_place_id: string | null;
        formatted_address: string | null;
      }>(
        `SELECT latitude, external_place_id, formatted_address FROM places ORDER BY created_at ASC`,
      );
      expect(enrichment[0]?.latitude).toBeNull();
      expect(enrichment[0]?.external_place_id).toBeNull();
      expect(enrichment[0]?.formatted_address).toBeNull();
    });

    it('persists country_code from the LLM on the new place row, normalising empty string to NULL', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([
          { name: 'Kosoan', city: 'Tokyo', category: 'food', country_code: 'JP' },
          { name: 'Mystery', city: '', category: 'place', country_code: '' },
        ]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlacesForSource(db, 's1');
      expect(rows[0]?.name).toBe('Kosoan');
      expect(rows[0]?.country_code).toBe('JP');
      expect(rows[1]?.name).toBe('Mystery');
      expect(rows[1]?.country_code).toBeNull();
    });

    it('inherits trip_id from the source onto newly-created places', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1', { tripId: 't1' });

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlacesForSource(db, 's1');
      expect(rows[0]?.trip_id).toBe('t1');
    });
  });

  describe('sole-match dedup against existing places', () => {
    it('reuses an existing live place when exactly one match exists by (normalized_key, owner_id)', async () => {
      const db = await freshDb();
      // Pre-existing place from a prior extraction.
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p-existing', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 'pending', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'kosoan', city: 'Tokyo ', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlacesForSource(db, 's1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.place_id).toBe('p-existing');

      const placeCount = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM places`);
      expect(placeCount?.n).toBe(1);
    });

    it('creates a new place when ≥2 live matches already exist (ambiguous → defer to enrichment)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p1', NULL, 'Starbucks', 'Tokyo', 'food', 'starbucks|tokyo', 'pending', 'owner-1', ?, ?),
                ('p2', NULL, 'Starbucks', 'Tokyo', 'food', 'starbucks|tokyo', 'pending', 'owner-1', ?, ?)`,
        NOW,
        NOW,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Starbucks', city: 'Tokyo', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlacesForSource(db, 's1');
      expect(rows).toHaveLength(1);
      // Distinct from the two existing rows.
      expect(['p1', 'p2'].includes(rows[0]!.place_id)).toBe(false);

      const placeCount = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM places`);
      expect(placeCount?.n).toBe(3);
    });

    it('does not match across owner boundaries', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p-other', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 'pending', 'someone-else', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const rows = await getPlacesForSource(db, 's1');
      expect(rows[0]?.place_id).not.toBe('p-other');

      const myCount = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM places WHERE owner_id = 'owner-1'`,
      );
      expect(myCount?.n).toBe(1);
    });

    it("flips a sole-matched place's enrichment_status from 'not-found' back to 'pending' (retry hint)", async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             enrichment_status, enriched_at, owner_id,
                             created_at, updated_at)
         VALUES ('p-nf', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 'not-found', ?, 'owner-1', ?, ?)`,
        NOW,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const place = await db.getFirstAsync<{ enrichment_status: string }>(
        `SELECT enrichment_status FROM places WHERE id = 'p-nf'`,
      );
      expect(place?.enrichment_status).toBe('pending');
    });

    it('asymmetric-fill: NULL country_code on existing place is filled when new extraction supplies a non-empty value', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             country_code, enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p-nullcc', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 NULL, 'pending', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([
          { name: 'Kosoan', city: 'Tokyo', category: 'food', country_code: 'JP' },
        ]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const place = await db.getFirstAsync<{ country_code: string | null }>(
        `SELECT country_code FROM places WHERE id = 'p-nullcc'`,
      );
      expect(place?.country_code).toBe('JP');
    });

    it('asymmetric-fill: existing non-NULL country_code is preserved even when a new extraction disagrees', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             country_code, enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p-jp', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 'JP', 'pending', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        // Re-extraction "disagrees" — should NOT overwrite the existing 'JP'.
        extract: okExtract([
          { name: 'Kosoan', city: 'Tokyo', category: 'food', country_code: 'KR' },
        ]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const place = await db.getFirstAsync<{ country_code: string | null }>(
        `SELECT country_code FROM places WHERE id = 'p-jp'`,
      );
      expect(place?.country_code).toBe('JP');
    });

    it('asymmetric-fill: empty new value does not clobber an existing NULL (still NULL)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             country_code, enrichment_status, owner_id, created_at, updated_at)
         VALUES ('p-nullcc', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 NULL, 'pending', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food', country_code: '' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const place = await db.getFirstAsync<{ country_code: string | null }>(
        `SELECT country_code FROM places WHERE id = 'p-nullcc'`,
      );
      expect(place?.country_code).toBeNull();
    });

    it("does NOT reset 'enriched' places when a new source attaches", async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO places (id, trip_id, name, city, category, normalized_key,
                             enrichment_status, enriched_at, external_place_id,
                             owner_id, created_at, updated_at)
         VALUES ('p-en', NULL, 'Kosoan', 'Tokyo', 'food', 'kosoan|tokyo',
                 'enriched', ?, 'gp-123', 'owner-1', ?, ?)`,
        NOW,
        NOW,
        NOW,
      );
      await seedSource(db, 's1');

      const e = createExtractor({
        db,
        extract: okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food' }]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      e.enqueueExtraction('s1');
      await drain(e);

      const place = await db.getFirstAsync<{ enrichment_status: string }>(
        `SELECT enrichment_status FROM places WHERE id = 'p-en'`,
      );
      expect(place?.enrichment_status).toBe('enriched');
    });
  });

  describe('empty-OCR short-circuit', () => {
    it('skips the proxy entirely and marks done with 0 places', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', { ocrText: '' });
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
      expect(await getPlacesForSource(db, 's1')).toEqual([]);
    });

    it('treats whitespace-only OCR as empty', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', { ocrText: '   \n\t   ' });
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
      await seedSource(db, 's1');
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

      const rows = await getPlacesForSource(db, 's1');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.name).sort()).toEqual(['Starbucks', 'Tsukiji']);
    });
  });

  describe('failure + retry', () => {
    it('retries a retryable error up to maxRetries and then marks failed', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
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
      await seedSource(db, 's1');
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
      await seedSource(db, 's1');
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
      expect(extract).toHaveBeenCalledTimes(6);
    });
  });

  describe('429 deferral', () => {
    it('does NOT consume retry budget; re-enqueues after retryAfterMs; row stays pending during the wait', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
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
      await seedSource(db, 's1');
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

      e.enqueueExtraction('s1');
      e.enqueueExtraction('s1');
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(timer.pendingCount()).toBe(1);
    });
  });

  describe('queue dedup + serialization', () => {
    it('two concurrent enqueueExtraction(id) only invoke extract once', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
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
      await seedSource(db, 'sA');
      await seedSource(db, 'sB');
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

  describe('hard-delete handling', () => {
    it('skips sources that were deleted between enqueue and run', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      await db.runAsync(`DELETE FROM sources WHERE id = 's1'`);

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
      expect(await getPlacesForSource(db, 's1')).toEqual([]);
    });
  });

  describe('runExtractionSweep', () => {
    it('picks only extraction_status=pending AND ocr_status=done, ordered by captured_at ASC', async () => {
      const db = await freshDb();
      await seedSource(db, 'sA', {
        ocrStatus: 'done',
        extractionStatus: 'pending',
        capturedAt: '2026-05-01T10:00:00.000Z',
      });
      await seedSource(db, 'sB', {
        ocrStatus: 'done',
        extractionStatus: 'pending',
        capturedAt: '2026-05-02T10:00:00.000Z',
      });
      await seedSource(db, 'sC', {
        ocrStatus: 'pending',
        extractionStatus: 'pending',
        capturedAt: '2026-05-03T10:00:00.000Z',
      });
      await seedSource(db, 'sD', {
        ocrStatus: 'done',
        extractionStatus: 'done',
        capturedAt: '2026-05-04T10:00:00.000Z',
      });
      await seedSource(db, 'sE', {
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

  describe('resumeEntitlementPaused', () => {
    it('skips paused rows during sweep, clears the reason on resume, and processes the row', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', { extractionStatus: 'pending', ocrStatus: 'done' });
      await db.runAsync(
        `UPDATE sources SET extraction_paused_reason = 'entitlement' WHERE id = 's1'`,
      );

      const extract = okExtract([{ name: 'Kosoan', city: 'Tokyo', category: 'food' }]);
      const e = createExtractor({
        db,
        extract,
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });

      // Sweep must not touch the paused row.
      await e.runExtractionSweep();
      await drain(e);
      expect(extract).not.toHaveBeenCalled();
      expect((await getStatus(db, 's1')).status).toBe('pending');

      // Resume must clear the paused reason and trigger extraction.
      await e.resumeEntitlementPaused();
      await drain(e);
      expect(extract).toHaveBeenCalledTimes(1);

      const row = await db.getFirstAsync<{ extraction_paused_reason: string | null }>(
        `SELECT extraction_paused_reason FROM sources WHERE id = 's1'`,
      );
      expect(row?.extraction_paused_reason).toBeNull();
      expect((await getStatus(db, 's1')).status).toBe('done');
    });
  });

  describe('runStartupRecovery', () => {
    it('flips failed extractions back to pending exactly once per process', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', { extractionStatus: 'failed' });
      await seedSource(db, 's2', { extractionStatus: 'failed' });
      await seedSource(db, 's3', { extractionStatus: 'done' });

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

      await e.runStartupRecovery();
      expect((await getStatus(db, 's1')).status).toBe('pending');
    });

    it('does NOT flip a paused-failed row back to pending, but still flips a plain failed row', async () => {
      const db = await freshDb();
      // Paused row: failed + entitlement reason (invariant: recovery must leave it alone).
      await seedSource(db, 'paused', { extractionStatus: 'failed' });
      await db.runAsync(
        `UPDATE sources SET extraction_paused_reason = 'entitlement' WHERE id = 'paused'`,
      );
      // Plain failed row: no paused reason (should be flipped to pending).
      await seedSource(db, 'plain', { extractionStatus: 'failed' });

      const e = createExtractor({
        db,
        extract: okExtract([]),
        ownerId: 'owner-1',
        uuid: seqUuid,
        now: () => NOW,
      });
      await e.runStartupRecovery();

      // Paused row must stay failed — recovery must not touch it.
      expect((await getStatus(db, 'paused')).status).toBe('failed');
      // Plain failed row must be reset so it can be retried.
      expect((await getStatus(db, 'plain')).status).toBe('pending');
    });
  });

  describe('entitlement-required (401) full pipeline path', () => {
    it('sets extraction_paused_reason=entitlement, keeps status pending, and does not retry', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');

      const extract = jest.fn(async () => {
        throw new ExtractionError('401', { kind: 'entitlement-required' });
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

      // Status stays pending — entitlement rows are NOT failures.
      expect((await getStatus(db, 's1')).status).toBe('pending');

      // The paused reason is stamped by markPaused via classifyFailure.
      const row = await db.getFirstAsync<{ extraction_paused_reason: string | null }>(
        `SELECT extraction_paused_reason FROM sources WHERE id = 's1'`,
      );
      expect(row?.extraction_paused_reason).toBe('entitlement');

      // extract must have been called exactly once — no retry storm.
      expect(extract).toHaveBeenCalledTimes(1);
    });
  });
});
