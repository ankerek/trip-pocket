import {
  openDatabase,
  runMigrations,
  insertSource,
  type Database,
} from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import { linkPlaceSource } from '@/modules/storage/place_sources';
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

async function seedSource(
  db: Database,
  id: string,
  ocrText: string = `OCR text ${id}`,
): Promise<void> {
  await insertSource(db, {
    id,
    tripId: null,
    filePath: `/tmp/${id}.jpg`,
    contentHash: `h-${id}`,
    origin: 'manual',
    capturedAt: NOW,
    ownerId: 'owner-1',
  });
  await db.runAsync(
    `UPDATE sources
        SET ocr_status = 'done', ocr_text = ?, extraction_status = 'done', updated_at = ?
      WHERE id = ?`,
    ocrText,
    NOW,
    id,
  );
}

type SeedPlace = {
  id: string;
  name: string;
  city: string | null;
  tripId?: string | null;
  category?: 'place' | 'food' | 'activity';
  status?: 'pending' | 'enriched' | 'not-found' | 'failed';
  externalPlaceId?: string | null;
};

async function seedPlace(db: Database, p: SeedPlace): Promise<void> {
  const normalizedKey = `${p.name.trim().toLowerCase()}|${(p.city ?? '').trim().toLowerCase()}`;
  await db.runAsync(
    `INSERT INTO places (
       id, trip_id, name, city, category, normalized_key,
       external_place_id, enrichment_status,
       owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', ?, ?)`,
    p.id,
    p.tripId ?? null,
    p.name,
    p.city,
    p.category ?? 'food',
    normalizedKey,
    p.externalPlaceId ?? null,
    p.status ?? 'pending',
    NOW,
    NOW,
  );
}

async function attachSourceToPlace(
  db: Database,
  placeId: string,
  sourceId: string,
  extractedAddress: string | null,
): Promise<void> {
  await linkPlaceSource(db, {
    placeId,
    sourceId,
    extractedAt: NOW,
    extractedAddress,
    extractionModel: 'gemini-2.5-flash-lite',
    ownerId: 'owner-1',
  });
}

async function getPlace(
  db: Database,
  id: string,
): Promise<{
  enrichment_status: string;
  external_place_id: string | null;
  enriched_at: string | null;
  description: string | null;
  latitude: number | null;
  trip_id: string | null;
  deleted_at: string | null;
}> {
  const row = await db.getFirstAsync<{
    enrichment_status: string;
    external_place_id: string | null;
    enriched_at: string | null;
    description: string | null;
    latitude: number | null;
    trip_id: string | null;
    deleted_at: string | null;
  }>(
    `SELECT enrichment_status, external_place_id, enriched_at, description, latitude, trip_id, deleted_at
       FROM places WHERE id = ?`,
    id,
  );
  if (!row) throw new Error(`row ${id} missing`);
  return row;
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

function makeEnricher(db: Database, enrich: EnrichmentRunner): Enricher {
  return createEnricher({ db, enrich, ownerId: 'owner-1', now: () => NOW });
}

describe('createEnricher', () => {
  describe('happy path', () => {
    it('writes enrichment columns directly onto the place row on success', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'tea house in jiyugaoka');
      await seedPlace(db, { id: 'p1', name: 'Kosoan', city: 'Tokyo' });
      await attachSourceToPlace(db, 'p1', 's1', '1 Chome-24-23');

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.enrichment_status).toBe('enriched');
      expect(row.external_place_id).toBe('ChIJ-test');
      expect(row.enriched_at).toBe(NOW);
      expect(row.description).toBe('Cozy 1950s tea house.');
      expect(row.latitude).toBeCloseTo(35.6076, 4);
      expect(enrich).toHaveBeenCalledTimes(1);
    });

    it("uses the most-recent non-null place_sources.extracted_address as the address hint", async () => {
      const db = await freshDb();
      await seedSource(db, 's-old', 'old caption');
      await seedSource(db, 's-new', 'new caption');
      await seedPlace(db, { id: 'p1', name: 'Kosoan', city: 'Tokyo' });

      // Older junction with NULL address; newer with non-null address.
      await db.runAsync(
        `INSERT INTO place_sources (
           place_id, source_id, extracted_at, extracted_address,
           extraction_model, owner_id, created_at, updated_at
         ) VALUES ('p1', 's-old', '2026-05-01T00:00:00Z', NULL, 'gemini', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      await db.runAsync(
        `INSERT INTO place_sources (
           place_id, source_id, extracted_at, extracted_address,
           extraction_model, owner_id, created_at, updated_at
         ) VALUES ('p1', 's-new', '2026-05-08T00:00:00Z', '999 New St', 'gemini', 'owner-1', ?, ?)`,
        NOW, NOW,
      );

      const enrich: EnrichmentRunner = jest
        .fn<Promise<EnrichOutcome>, [import('../enrichment').EnrichRequestPayload]>()
        .mockResolvedValue(enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      expect(enrich).toHaveBeenCalledTimes(1);
      const payload = (enrich as jest.Mock).mock.calls[0]?.[0] as
        | import('../enrichment').EnrichRequestPayload
        | undefined;
      expect(payload?.address).toBe('999 New St');
    });

    it("marks 'not-found' when worker returns not-found", async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      await seedPlace(db, { id: 'p1', name: 'Mystery', city: 'Z' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enricher = makeEnricher(db, async () => ({ kind: 'not-found' }));
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.enrichment_status).toBe('not-found');
      expect(row.external_place_id).toBeNull();
    });

    it('marks failed on retryable error and retries on next open', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      await seedPlace(db, { id: 'p1', name: 'X', city: 'Y' });
      await attachSourceToPlace(db, 'p1', 's1', null);

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

      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();
      expect((await getPlace(db, 'p1')).enrichment_status).toBe('enriched');
      expect(enrich).toHaveBeenCalledTimes(2);
    });

    it('skips rows already in enriched/not-found state on re-open', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      await seedPlace(db, {
        id: 'p1',
        name: 'X',
        city: 'Y',
        status: 'enriched',
        externalPlaceId: 'ChIJ-already',
      });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      expect(enrich).not.toHaveBeenCalled();
    });

    it("marks 'not-found' (no /enrich call) when no source has OCR text", async () => {
      const db = await freshDb();
      await seedSource(db, 's1', '   ');
      await seedPlace(db, { id: 'p1', name: 'X', city: 'Y' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      expect(enrich).not.toHaveBeenCalled();
      expect((await getPlace(db, 'p1')).enrichment_status).toBe('not-found');
    });

    it('coalesces simultaneous enqueues on the same place into one /enrich call', async () => {
      const db = await freshDb();
      await seedSource(db, 's1');
      await seedPlace(db, { id: 'p1', name: 'Kosoan', city: 'Tokyo' });
      await attachSourceToPlace(db, 'p1', 's1', null);

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

      // Microtask flush so the first call kicks off but doesn't yet resolve.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(enrich).toHaveBeenCalledTimes(1);

      resolveCall!(enrichedOutcome);
      await enricher._awaitIdle();

      expect((await getPlace(db, 'p1')).external_place_id).toBe('ChIJ-test');
    });
  });

  describe('post-enrichment merge', () => {
    it('absorbs incoming into existing when external_place_id collides and trip-rule is met (existing has trip)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      // Existing already enriched, on a trip.
      await seedPlace(db, {
        id: 'p-existing',
        name: 'Cozy 1950s tea house',
        city: 'Tokyo',
        tripId: 't1',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      // Incoming: NULL trip, will collide on resolved external_place_id.
      await seedSource(db, 's-incoming');
      await seedPlace(db, { id: 'p-incoming', name: 'Kosoan', city: 'Tokyo' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      // Existing wins: it had the trip context.
      const winner = await getPlace(db, 'p-existing');
      expect(winner.enrichment_status).toBe('enriched');
      expect(winner.trip_id).toBe('t1');
      expect(winner.deleted_at).toBeNull();

      // Incoming is hard-deleted: row is gone entirely.
      const loserRow = await db.getFirstAsync(
        `SELECT id FROM places WHERE id = 'p-incoming'`,
      );
      expect(loserRow).toBeNull();

      // Junction migrated: the incoming source is now attached to the winner.
      const j = await db.getAllAsync<{ place_id: string; source_id: string }>(
        `SELECT place_id, source_id FROM place_sources
          WHERE source_id = 's-incoming'`,
      );
      expect(j.map((r) => r.place_id)).toEqual(['p-existing']);
    });

    it('promotes incoming and copies enrichment from existing when only incoming has trip', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      // Existing already enriched, NO trip.
      await seedPlace(db, {
        id: 'p-existing',
        name: 'Old Name',
        city: 'Tokyo',
        tripId: null,
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      // Incoming: has a trip and is fresh.
      await seedSource(db, 's-incoming');
      await seedPlace(db, { id: 'p-incoming', name: 'Kosoan', city: 'Tokyo', tripId: 't1' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      // Incoming wins: it had the trip context.
      const winner = await getPlace(db, 'p-incoming');
      expect(winner.enrichment_status).toBe('enriched');
      expect(winner.trip_id).toBe('t1');
      expect(winner.external_place_id).toBe('ChIJ-test');
      expect(winner.deleted_at).toBeNull();

      // Existing is hard-deleted: row is gone entirely.
      const loserRow = await db.getFirstAsync(
        `SELECT id FROM places WHERE id = 'p-existing'`,
      );
      expect(loserRow).toBeNull();
    });

    it('skips merge when both places have non-null but DIFFERENT trip_ids; keeps both alive', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?), ('t2', 'Spain', 'owner-1', ?, ?)`,
        NOW, NOW, NOW, NOW,
      );
      await seedPlace(db, {
        id: 'p-existing',
        name: 'Kosoan',
        city: 'Tokyo',
        tripId: 't1',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      await seedSource(db, 's-incoming');
      await seedPlace(db, { id: 'p-incoming', name: 'Kosoan', city: 'Tokyo', tripId: 't2' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      const existing = await getPlace(db, 'p-existing');
      const incoming = await getPlace(db, 'p-incoming');
      expect(existing.deleted_at).toBeNull();
      expect(incoming.deleted_at).toBeNull();
      expect(existing.external_place_id).toBe('ChIJ-test');
      // Incoming is left without external_place_id (UNIQUE forbids two live rows).
      expect(incoming.external_place_id).toBeNull();
    });

    it('junction merge handles a source attached to both places via ON CONFLICT DO NOTHING', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      await seedSource(db, 's-shared');
      await seedPlace(db, {
        id: 'p-existing',
        name: 'A',
        city: 'Tokyo',
        tripId: 't1',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      await seedPlace(db, { id: 'p-incoming', name: 'B', city: 'Tokyo' });
      // Shared source attached to BOTH places.
      await attachSourceToPlace(db, 'p-existing', 's-shared', null);
      await attachSourceToPlace(db, 'p-incoming', 's-shared', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      // Existing wins; incoming is gone. The shared junction stays on the winner.
      const j = await db.getAllAsync<{ place_id: string; source_id: string }>(
        `SELECT place_id, source_id FROM place_sources
          WHERE source_id = 's-shared'
       ORDER BY place_id`,
      );
      expect(j.map((r) => r.place_id)).toEqual(['p-existing']);
    });

    it('hard-deletes the loser place row entirely (no soft-delete vestige)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      await seedPlace(db, {
        id: 'p-existing',
        name: 'A',
        city: 'Tokyo',
        tripId: 't1',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      await seedSource(db, 's-incoming');
      await seedPlace(db, { id: 'p-incoming', name: 'B', city: 'Tokyo' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      // Loser is gone; only winner survives.
      const surviving = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM places WHERE id IN ('p-existing', 'p-incoming')`,
      );
      expect(surviving).toHaveLength(1);
      expect(surviving[0]?.id).toBe('p-existing');
    });

    it('winner takes over external_place_id without UNIQUE violation', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW, NOW,
      );
      // Existing has trip but is NOT yet enriched. Incoming will resolve to
      // ChIJ-test, which existing already holds.
      await seedPlace(db, {
        id: 'p-existing',
        name: 'A',
        city: 'Tokyo',
        tripId: null, // null so incoming wins via tie-break logic
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      await seedSource(db, 's-incoming');
      await seedPlace(db, { id: 'p-incoming', name: 'B', city: 'Tokyo', tripId: 't1' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      const winner = await getPlace(db, 'p-incoming');
      expect(winner.external_place_id).toBe('ChIJ-test');
    });
  });
});
