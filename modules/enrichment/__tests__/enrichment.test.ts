import {
  openDatabase,
  runMigrations,
  insertScreenshot,
  type Database,
} from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import {
  createEnricher,
  EnrichmentError,
  type EnrichmentRunner,
  type EnrichOutcome,
  type Enricher,
} from '../enrichment';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

const NOW = '2026-05-08T12:00:00.000Z';

async function seedScreenshot(
  db: Database,
  id: string,
  ocrText: string = `OCR text ${id}`,
): Promise<void> {
  await insertScreenshot(db, {
    id,
    tripId: null,
    filePath: `/tmp/${id}.jpg`,
    contentHash: `h-${id}`,
    source: 'manual',
    capturedAt: NOW,
    ownerId: 'owner-1',
  });
  await db.runAsync(
    `UPDATE screenshots
        SET ocr_status = 'done', ocr_text = ?, extraction_status = 'done', updated_at = ?
      WHERE id = ?`,
    ocrText,
    NOW,
    id,
  );
}

type SeedPlace = {
  id: string;
  screenshotId: string;
  name: string;
  city: string;
  address: string | null;
  category?: 'place' | 'food' | 'activity';
  status?: 'pending' | 'enriched' | 'not-found' | 'failed';
  externalPlaceId?: string | null;
};

async function seedPlace(db: Database, p: SeedPlace): Promise<void> {
  await db.runAsync(
    `INSERT INTO extracted_places (
       id, screenshot_id, name, city, address, category,
       external_place_id, enrichment_status, owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', ?, ?)`,
    p.id,
    p.screenshotId,
    p.name,
    p.city,
    p.address,
    p.category ?? 'food',
    p.externalPlaceId ?? null,
    p.status ?? 'pending',
    NOW,
    NOW,
  );
}

async function getPlace(
  db: Database,
  id: string,
): Promise<{
  enrichment_status: string;
  external_place_id: string | null;
  enriched_at: string | null;
}> {
  const row = await db.getFirstAsync<{
    enrichment_status: string;
    external_place_id: string | null;
    enriched_at: string | null;
  }>(
    `SELECT enrichment_status, external_place_id, enriched_at
       FROM extracted_places WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`row ${id} missing`);
  return row;
}

async function getEnrichment(
  db: Database,
  externalPlaceId: string,
): Promise<{ photo_name: string | null; description: string | null } | null> {
  return db.getFirstAsync(
    `SELECT photo_name, description FROM place_enrichments
      WHERE external_place_id = ?`,
    externalPlaceId,
  );
}

const enrichedOutcome: Extract<EnrichOutcome, { kind: 'enriched' }> = {
  kind: 'enriched',
  external_place_id: 'ChIJ-test',
  latitude: 35.6076,
  longitude: 139.668,
  formatted_address: '1 Chome Jiyugaoka, Tokyo',
  photo_name: 'places/ChIJ-test/photos/abc',
  description: 'Cozy 1950s tea house.',
  rating: 4.5,
  price_level: 2,
  external_url: 'https://maps.google.com/?cid=1',
  model: 'gemini-2.5-flash-lite',
};

function makeEnricher(
  db: Database,
  enrich: EnrichmentRunner,
): Enricher {
  return createEnricher({ db, enrich, now: () => NOW });
}

// Wait until `predicate` returns true, flushing microtasks each iteration.
// The runner's DB reads are in-memory and resolve in microtasks; this
// avoids `_awaitIdle` (which would block on a deliberately-pending mock).
async function waitFor(
  predicate: () => boolean,
  iterations = 50,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('waitFor: predicate never satisfied');
}

describe('createEnricher', () => {
  it('marks rows enriched and writes place_enrichments on success', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1', 'tea house in jiyugaoka');
    await seedPlace(db, {
      id: 'p1',
      screenshotId: 's1',
      name: 'Kosoan',
      city: 'Tokyo',
      address: '1 Chome-24-23',
    });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    const row = await getPlace(db, 'p1');
    expect(row.enrichment_status).toBe('enriched');
    expect(row.external_place_id).toBe('ChIJ-test');
    expect(row.enriched_at).toBe(NOW);

    const enr = await getEnrichment(db, 'ChIJ-test');
    expect(enr?.photo_name).toBe('places/ChIJ-test/photos/abc');
    expect(enr?.description).toContain('tea house');
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it("marks 'not-found' when worker returns not-found", async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'Mystery', city: 'Z', address: null });

    const enricher = makeEnricher(db, async () => ({ kind: 'not-found' }));
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    const row = await getPlace(db, 'p1');
    expect(row.enrichment_status).toBe('not-found');
    expect(row.external_place_id).toBeNull();
  });

  it('marks failed on retryable error and propagates retry on next open', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'X', city: 'Y', address: null });

    const enrich: EnrichmentRunner = jest
      .fn<Promise<EnrichOutcome>, []>()
      .mockImplementationOnce(async () => {
        throw new EnrichmentError('boom', 'retryable');
      })
      .mockImplementationOnce(async () => enrichedOutcome);

    const enricher = makeEnricher(db, enrich);

    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();
    expect((await getPlace(db, 'p1')).enrichment_status).toBe('failed');

    // Second open: trigger condition includes 'failed', so the runner retries.
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();
    expect((await getPlace(db, 'p1')).enrichment_status).toBe('enriched');
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it('skips rows already in enriched/not-found state on re-open', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedPlace(db, {
      id: 'p1',
      screenshotId: 's1',
      name: 'X',
      city: 'Y',
      address: null,
      status: 'enriched',
      externalPlaceId: 'ChIJ-already',
    });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    expect(enrich).not.toHaveBeenCalled();
  });

  it('pre-flight venue check copies external_place_id from a resolved sibling', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedScreenshot(db, 's2');
    await seedPlace(db, {
      id: 'p1',
      screenshotId: 's1',
      name: 'Kosoan',
      city: 'Tokyo',
      address: '1 Chome',
      status: 'enriched',
      externalPlaceId: 'ChIJ-test',
    });
    // Insert the place_enrichments row so the join would render.
    await db.runAsync(
      `INSERT INTO place_enrichments (
         external_place_id, fetched_at, model
       ) VALUES ('ChIJ-test', ?, 'gemini')`,
      NOW,
    );
    await seedPlace(db, {
      id: 'p2',
      screenshotId: 's2',
      name: 'Kosoan',
      city: 'Tokyo',
      address: '1 Chome',
    });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p2');
    await enricher._awaitIdle();

    expect(enrich).not.toHaveBeenCalled();
    const row = await getPlace(db, 'p2');
    expect(row.enrichment_status).toBe('enriched');
    expect(row.external_place_id).toBe('ChIJ-test');
  });

  it('pre-flight venue check is case- and whitespace-insensitive', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedScreenshot(db, 's2');
    await seedPlace(db, {
      id: 'p1',
      screenshotId: 's1',
      name: 'Kosoan',
      city: 'Tokyo',
      address: '1 Chome',
      status: 'enriched',
      externalPlaceId: 'ChIJ-test',
    });
    await seedPlace(db, {
      id: 'p2',
      screenshotId: 's2',
      // Different case + extra whitespace; should still match.
      name: 'KOSOAN',
      city: ' tokyo ',
      address: ' 1 chome ',
    });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p2');
    await enricher._awaitIdle();

    expect(enrich).not.toHaveBeenCalled();
    expect((await getPlace(db, 'p2')).external_place_id).toBe('ChIJ-test');
  });

  it('propagates a successful enrichment to OCR-key sibling rows', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedScreenshot(db, 's2');
    await seedScreenshot(db, 's3');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });
    await seedPlace(db, { id: 'p2', screenshotId: 's2', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });
    await seedPlace(db, {
      id: 'p3',
      screenshotId: 's3',
      name: 'Kosoan',
      city: 'Tokyo',
      address: '1 Chome',
      status: 'failed',
    });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    expect(enrich).toHaveBeenCalledTimes(1);
    expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
    expect((await getPlace(db, 'p2')).external_place_id).toBe('ChIJ-test');
    // 'failed' siblings get back-filled too, so their next open is a no-op.
    expect((await getPlace(db, 'p3')).external_place_id).toBe('ChIJ-test');
    expect((await getPlace(db, 'p3')).enrichment_status).toBe('enriched');
  });

  it('does NOT propagate to siblings with a different OCR key', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedScreenshot(db, 's2');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });
    await seedPlace(db, { id: 'p2', screenshotId: 's2', name: 'Kosoan', city: 'Tokyo', address: '99 Different Street' });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
    expect((await getPlace(db, 'p2')).external_place_id).toBeNull();
    expect((await getPlace(db, 'p2')).enrichment_status).toBe('pending');
  });

  it('coalesces simultaneous enqueues on the same row into one /enrich call', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });

    let resolveCall: ((v: EnrichOutcome) => void) | null = null;
    const enrich = jest.fn(
      () =>
        new Promise<EnrichOutcome>((resolve) => {
          resolveCall = resolve;
        }),
    );
    const enricher = makeEnricher(db, enrich);

    enricher.enqueueEnrichment('p1');
    enricher.enqueueEnrichment('p1');
    enricher.enqueueEnrichment('p1');

    await waitFor(() => enrich.mock.calls.length === 1);
    expect(enrich).toHaveBeenCalledTimes(1);
    resolveCall!(enrichedOutcome);
    await enricher._awaitIdle();

    expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
  });

  it('coalesces simultaneous enqueues on OCR-key-equivalent rows into one /enrich call', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedScreenshot(db, 's2');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });
    await seedPlace(db, { id: 'p2', screenshotId: 's2', name: 'Kosoan', city: 'Tokyo', address: '1 Chome' });

    let resolveCall: ((v: EnrichOutcome) => void) | null = null;
    const enrich = jest.fn(
      () =>
        new Promise<EnrichOutcome>((resolve) => {
          resolveCall = resolve;
        }),
    );
    const enricher = makeEnricher(db, enrich);

    enricher.enqueueEnrichment('p1');
    enricher.enqueueEnrichment('p2');
    await waitFor(() => enrich.mock.calls.length === 1);
    expect(enrich).toHaveBeenCalledTimes(1);

    resolveCall!(enrichedOutcome);
    await enricher._awaitIdle();

    expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
    expect((await getPlace(db, 'p2')).external_place_id).toBe('ChIJ-test');
  });

  it("marks 'not-found' (no /enrich call) when the screenshot has empty OCR", async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1', '   ');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'X', city: 'Y', address: null });

    const enrich = jest.fn(async () => enrichedOutcome);
    const enricher = makeEnricher(db, enrich);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    expect(enrich).not.toHaveBeenCalled();
    expect((await getPlace(db, 'p1')).enrichment_status).toBe('not-found');
  });

  it('uses INSERT OR IGNORE so a sibling race does not crash', async () => {
    const db = await freshDb();
    await seedScreenshot(db, 's1');
    await seedPlace(db, { id: 'p1', screenshotId: 's1', name: 'X', city: 'Y', address: null });

    // Pre-populate the enrichment row to simulate a sibling having raced and
    // already inserted.
    await db.runAsync(
      `INSERT INTO place_enrichments (
         external_place_id, photo_name, fetched_at, model
       ) VALUES ('ChIJ-test', 'pre-existing', ?, 'gemini')`,
      NOW,
    );

    const enricher = makeEnricher(db, async () => enrichedOutcome);
    enricher.enqueueEnrichment('p1');
    await enricher._awaitIdle();

    // Status updated to enriched but the existing enrichment row is preserved.
    expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
    const enr = await getEnrichment(db, 'ChIJ-test');
    expect(enr?.photo_name).toBe('pre-existing');
  });
});
