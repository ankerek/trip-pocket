import { openDatabase, runMigrations, insertSource, type Database } from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import {
  createEnricher,
  EnrichmentError,
  type EnrichmentRunner,
  type EnrichOutcome,
  type Enricher,
} from '../enrichment';
import { getEntitlementUserId } from '@/lib/entitlement/userId';
import { enrichFromProxy } from '../proxy';

jest.mock('@/lib/entitlement/userId', () => ({
  getEntitlementUserId: jest.fn(async () => '$RCAnonymousID:0123456789abcdef0123456789abcdef'),
}));

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
  countryCode?: string | null;
  tripId?: string | null;
  category?: 'place' | 'food' | 'activity';
  status?: 'pending' | 'enriched' | 'not-found' | 'failed';
  externalPlaceId?: string | null;
  description?: string | null;
};

async function seedPlace(db: Database, p: SeedPlace): Promise<void> {
  const normalizedKey = `${p.name.trim().toLowerCase()}|${(p.city ?? '').trim().toLowerCase()}`;
  await db.runAsync(
    `INSERT INTO places (
       id, trip_id, name, city, country_code, category, normalized_key,
       external_place_id, description, enrichment_status,
       owner_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', ?, ?)`,
    p.id,
    p.tripId ?? null,
    p.name,
    p.city,
    p.countryCode ?? null,
    p.category ?? 'food',
    normalizedKey,
    p.externalPlaceId ?? null,
    p.description ?? null,
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
  name: string;
  normalized_key: string;
  enrichment_status: string;
  external_place_id: string | null;
  enriched_at: string | null;
  description: string | null;
  latitude: number | null;
  trip_id: string | null;
  city: string | null;
  country_code: string | null;
}> {
  const row = await db.getFirstAsync<{
    name: string;
    normalized_key: string;
    enrichment_status: string;
    external_place_id: string | null;
    enriched_at: string | null;
    description: string | null;
    latitude: number | null;
    trip_id: string | null;
    city: string | null;
    country_code: string | null;
  }>(
    `SELECT name, normalized_key, enrichment_status, external_place_id, enriched_at,
            description, latitude, trip_id, city, country_code
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
  city: 'Tokyo',
  country_code: 'JP',
  display_name: null,
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

    it('overrides LLM city + country_code with Google Places values on enrichment', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'tea house');
      // LLM had said "Tokyo" / no-country-code. Google Places resolved to
      // Tokyo / JP. Both should land on the row authoritatively after enrich.
      await seedPlace(db, { id: 'p1', name: 'Kosoan', city: 'Shibuya', countryCode: null });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enricher = makeEnricher(db, async () => enrichedOutcome);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.city).toBe('Tokyo');
      expect(row.country_code).toBe('JP');
    });

    it('preserves LLM city + country_code when Google Places returns null for both (COALESCE)', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'rural ramen');
      await seedPlace(db, { id: 'p1', name: 'Rural Ramen', city: 'Backwater', countryCode: 'JP' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const outcomeNullFields = { ...enrichedOutcome, city: null, country_code: null };
      const enricher = makeEnricher(db, async () => outcomeNullFields);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.city).toBe('Backwater');
      expect(row.country_code).toBe('JP');
    });

    it('partial override: Google supplies country but not city, so city is preserved', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'partial');
      await seedPlace(db, { id: 'p1', name: 'Half Place', city: 'GuessedCity', countryCode: null });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const partial = { ...enrichedOutcome, city: null };
      const enricher = makeEnricher(db, async () => partial);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.city).toBe('GuessedCity');
      expect(row.country_code).toBe('JP');
    });

    it('uses the most-recent non-null place_sources.extracted_address as the address hint', async () => {
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
        NOW,
        NOW,
      );
      await db.runAsync(
        `INSERT INTO place_sources (
           place_id, source_id, extracted_at, extracted_address,
           extraction_model, owner_id, created_at, updated_at
         ) VALUES ('p1', 's-new', '2026-05-08T00:00:00Z', '999 New St', 'gemini', 'owner-1', ?, ?)`,
        NOW,
        NOW,
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
        // A fully-enriched place (with a description) short-circuits the
        // re-run. The description=null case is the blurb-retry path, tested
        // separately below.
        description: 'A previously generated blurb.',
      });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      expect(enrich).not.toHaveBeenCalled();
    });

    describe('blurb-retry path (enriched + description=null)', () => {
      // First /enrich got Google Places data back but Gemini's blurb call
      // failed → description stays null, enrichment_status='enriched'. The
      // detail-screen open is the user-visible retry signal; the runner
      // re-fires /enrich and the throttle map gates rapid re-renders.

      const enrichedWithBlurb: EnrichOutcome = {
        kind: 'enriched',
        external_place_id: 'ChIJ-x',
        latitude: 1,
        longitude: 2,
        formatted_address: 'addr',
        photo_name: 'photos/x',
        description: 'a blurb appeared this time',
        rating: 4.2,
        price_level: 2,
        external_url: 'https://maps/x',
        city: null,
        country_code: null,
        display_name: null,
        model: 'gemini-2.5-flash-lite',
      };

      it('re-runs /enrich when description is null and back-fills the description', async () => {
        const db = await freshDb();
        await seedSource(db, 's1');
        await seedPlace(db, {
          id: 'p1',
          name: 'X',
          city: 'Y',
          status: 'enriched',
          externalPlaceId: 'ChIJ-already',
          description: null,
        });
        await attachSourceToPlace(db, 'p1', 's1', null);

        const enrich = jest.fn(async () => enrichedWithBlurb);
        const enricher = makeEnricher(db, enrich);
        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();

        expect(enrich).toHaveBeenCalledTimes(1);
        const after = await getPlace(db, 'p1');
        expect(after.description).toBe('a blurb appeared this time');
        expect(after.enrichment_status).toBe('enriched');
      });

      it('throttles rapid back-to-back re-enrich attempts to one /enrich call', async () => {
        const db = await freshDb();
        await seedSource(db, 's1');
        await seedPlace(db, {
          id: 'p1',
          name: 'X',
          city: 'Y',
          status: 'enriched',
          externalPlaceId: 'ChIJ-already',
          description: null,
        });
        await attachSourceToPlace(db, 'p1', 's1', null);

        // The blurb still doesn't fill — simulating Gemini being out for a
        // while. We expect exactly one /enrich call across multiple enqueues.
        const enrich = jest.fn(async () => ({ ...enrichedWithBlurb, description: null }));
        const enricher = makeEnricher(db, enrich);

        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();
        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();
        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();

        expect(enrich).toHaveBeenCalledTimes(1);
      });

      it('does not downgrade an enriched row to "not-found" when re-run search comes back empty', async () => {
        const db = await freshDb();
        await seedSource(db, 's1');
        await seedPlace(db, {
          id: 'p1',
          name: 'X',
          city: 'Y',
          status: 'enriched',
          externalPlaceId: 'ChIJ-already',
          description: null,
        });
        await attachSourceToPlace(db, 'p1', 's1', null);

        const enrich = jest.fn(async () => ({ kind: 'not-found' as const }));
        const enricher = makeEnricher(db, enrich);
        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();

        const after = await getPlace(db, 'p1');
        expect(after.enrichment_status).toBe('enriched');
      });

      it('does not downgrade an enriched row to "failed" when re-run throws', async () => {
        const db = await freshDb();
        await seedSource(db, 's1');
        await seedPlace(db, {
          id: 'p1',
          name: 'X',
          city: 'Y',
          status: 'enriched',
          externalPlaceId: 'ChIJ-already',
          description: null,
        });
        await attachSourceToPlace(db, 'p1', 's1', null);

        const enrich = jest.fn(async () => {
          throw new EnrichmentError('boom', 'retryable');
        });
        const enricher = makeEnricher(db, enrich);
        enricher.enqueueEnrichment('p1');
        await enricher._awaitIdle();

        const after = await getPlace(db, 'p1');
        expect(after.enrichment_status).toBe('enriched');
      });
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

  describe('canonical name from Google display_name', () => {
    it('writes Google display_name into places.name on first enrichment', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'cozy tea house');
      // LLM extracted a quirky variant; Google has the canonical name.
      await seedPlace(db, { id: 'p1', name: "joe's pizza & bar", city: 'New York' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enrich = jest.fn(async () => ({
        ...enrichedOutcome,
        display_name: "Joe's Pizza",
      }));
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.name).toBe("Joe's Pizza");
      // normalized_key follows the final name and final city.
      expect(row.normalized_key).toBe("joe's pizza|tokyo");
      expect(row.external_place_id).toBe('ChIJ-test');
    });

    it('refreshes places.name on re-enrichment when Google display_name changes', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'caption');
      // Seed an already-enriched row with description=null so the blurb-retry
      // path fires a second /enrich call.
      await seedPlace(db, {
        id: 'p1',
        name: 'Old Name',
        city: 'Tokyo',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
        description: null,
      });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enricher = makeEnricher(db, async () => ({
        ...enrichedOutcome,
        display_name: 'Refreshed Name',
      }));
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.name).toBe('Refreshed Name');
      expect(row.normalized_key).toBe('refreshed name|tokyo');
    });

    it('keeps the existing name when worker returns display_name=null', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'caption');
      await seedPlace(db, { id: 'p1', name: 'LLM Name', city: 'Tokyo' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enricher = makeEnricher(db, async () => ({
        ...enrichedOutcome,
        display_name: null,
      }));
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.name).toBe('LLM Name');
      expect(row.normalized_key).toBe('llm name|tokyo');
      // Other enrichment columns are still written.
      expect(row.description).toBe('Cozy 1950s tea house.');
      expect(row.external_place_id).toBe('ChIJ-test');
    });

    it('uses Google city when recomputing normalized_key', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'caption');
      // LLM misspelled the city; Google's addressComponents has the canonical form.
      await seedPlace(db, { id: 'p1', name: 'Tower', city: 'tokio' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enricher = makeEnricher(db, async () => ({
        ...enrichedOutcome,
        display_name: 'Tokyo Tower',
        city: 'Tokyo',
      }));
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await getPlace(db, 'p1');
      expect(row.name).toBe('Tokyo Tower');
      expect(row.city).toBe('Tokyo');
      // normalized_key uses Google's city, not the stale LLM "tokio".
      expect(row.normalized_key).toBe('tokyo tower|tokyo');
    });

    it('writes Google name onto the merge winner', async () => {
      const db = await freshDb();
      // Same trip, two LLM-name variants for the same Google place.
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'NYC', 'owner-1', ?, ?)`,
        NOW,
        NOW,
      );
      // p-existing is older, will become winner (older created_at).
      await seedPlace(db, {
        id: 'p-existing',
        name: "joe's pizza",
        city: 'New York',
        tripId: 't1',
        status: 'enriched',
        externalPlaceId: 'ChIJ-test',
      });
      await seedSource(db, 's-incoming');
      // p-incoming has a different LLM-rendered name; same Google ID will collide.
      await seedPlace(db, {
        id: 'p-incoming',
        name: "joe's pizza & bar",
        city: 'New York',
        tripId: 't1',
      });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => ({
        ...enrichedOutcome,
        display_name: "Joe's Pizza",
      }));
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      // Winner is p-existing (older, already enriched). Its prior enrichment
      // already chose a canonical name from its own /enrich pass; the merge
      // does NOT overwrite that with this attempt's display_name (the existing
      // row may have richer data this attempt couldn't reproduce). The
      // incoming row is gone.
      const winner = await getPlace(db, 'p-existing');
      expect(winner.external_place_id).toBe('ChIJ-test');
      expect(winner.name).toBe("joe's pizza"); // not overwritten — collision wins
      await expect(getPlace(db, 'p-incoming')).rejects.toThrow();
    });

    it('writes Google name + descriptive cols on incoming when merge is skipped (different trips)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?), ('t2', 'Spain', 'owner-1', ?, ?)`,
        NOW,
        NOW,
        NOW,
        NOW,
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
      await seedPlace(db, { id: 'p-incoming', name: 'kosoan tea', city: 'Tokyo', tripId: 't2' });
      await attachSourceToPlace(db, 'p-incoming', 's-incoming', null);

      const enricher = makeEnricher(db, async () => ({
        ...enrichedOutcome,
        display_name: 'Kosoan',
      }));
      enricher.enqueueEnrichment('p-incoming');
      await enricher._awaitIdle();

      const existing = await getPlace(db, 'p-existing');
      const incoming = await getPlace(db, 'p-incoming');
      // Both rows still exist — different trips, merge skipped.
      expect(existing.external_place_id).toBe('ChIJ-test');
      expect(incoming.external_place_id).toBeNull(); // UNIQUE forbids two live.
      // Incoming gets Google's canonical name + descriptive cols, just no ID.
      expect(incoming.name).toBe('Kosoan');
      expect(incoming.normalized_key).toBe('kosoan|tokyo');
      expect(incoming.description).toBe('Cozy 1950s tea house.');
      expect(incoming.enrichment_status).toBe('enriched');
    });
  });

  describe('post-enrichment merge', () => {
    it('absorbs incoming into existing when external_place_id collides and trip-rule is met (existing has trip)', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW,
        NOW,
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

      // Incoming is hard-deleted: row is gone entirely.
      const loserRow = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'p-incoming'`);
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
        NOW,
        NOW,
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

      // Existing is hard-deleted: row is gone entirely.
      const loserRow = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'p-existing'`);
      expect(loserRow).toBeNull();
    });

    it('skips merge when both places have non-null but DIFFERENT trip_ids; keeps both alive', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?), ('t2', 'Spain', 'owner-1', ?, ?)`,
        NOW,
        NOW,
        NOW,
        NOW,
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
      // Both rows still exist (skip-merge path).
      expect(existing.external_place_id).toBe('ChIJ-test');
      // Incoming is left without external_place_id (UNIQUE forbids two live rows).
      expect(incoming.external_place_id).toBeNull();
    });

    it('junction merge handles a source attached to both places via ON CONFLICT DO NOTHING', async () => {
      const db = await freshDb();
      await db.runAsync(
        `INSERT INTO trips (id, name, owner_id, created_at, updated_at)
         VALUES ('t1', 'Japan', 'owner-1', ?, ?)`,
        NOW,
        NOW,
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
        NOW,
        NOW,
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
        NOW,
        NOW,
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

  describe('entitlement-paused dispatcher', () => {
    it('401 path: dispatcher writes enrichment_paused_reason=entitlement (not failed)', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'some ocr text');
      await seedPlace(db, { id: 'p1', name: 'X', city: 'Y', status: 'pending' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      const enrich = jest.fn(async () => {
        throw new EnrichmentError('paused', 'entitlement-required');
      });
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      const row = await db.getFirstAsync<{
        enrichment_status: string;
        enrichment_paused_reason: string | null;
      }>(`SELECT enrichment_status, enrichment_paused_reason FROM places WHERE id = 'p1'`);
      expect(row?.enrichment_paused_reason).toBe('entitlement');
      expect(row?.enrichment_status).toBe('pending');
    });

    it('processOne short-circuits on paused row', async () => {
      const db = await freshDb();
      await seedSource(db, 's1', 'some ocr text');
      await seedPlace(db, { id: 'p1', name: 'X', city: 'Y', status: 'pending' });
      await attachSourceToPlace(db, 'p1', 's1', null);

      await db.runAsync(
        `UPDATE places SET enrichment_paused_reason = 'entitlement' WHERE id = 'p1'`,
      );

      const enrich = jest.fn(async () => enrichedOutcome);
      const enricher = makeEnricher(db, enrich);
      enricher.enqueueEnrichment('p1');
      await enricher._awaitIdle();

      expect(enrich).not.toHaveBeenCalled();
      const row = await db.getFirstAsync<{ enrichment_paused_reason: string | null }>(
        `SELECT enrichment_paused_reason FROM places WHERE id = 'p1'`,
      );
      expect(row?.enrichment_paused_reason).toBe('entitlement');
    });

    it('resumeEntitlementPaused re-enqueues paused rows', async () => {
      const db = await freshDb();
      // Two paused places.
      await seedSource(db, 's1', 'ocr text 1');
      await seedPlace(db, { id: 'p1', name: 'A', city: 'Tokyo', status: 'pending' });
      await attachSourceToPlace(db, 'p1', 's1', null);
      await db.runAsync(
        `UPDATE places SET enrichment_paused_reason = 'entitlement' WHERE id = 'p1'`,
      );

      await seedSource(db, 's2', 'ocr text 2');
      await seedPlace(db, { id: 'p2', name: 'B', city: 'Osaka', status: 'pending' });
      await attachSourceToPlace(db, 'p2', 's2', null);
      await db.runAsync(
        `UPDATE places SET enrichment_paused_reason = 'entitlement' WHERE id = 'p2'`,
      );

      // One non-paused place.
      await seedSource(db, 's3', 'ocr text 3');
      await seedPlace(db, { id: 'p3', name: 'C', city: 'Kyoto', status: 'pending' });
      await attachSourceToPlace(db, 'p3', 's3', null);

      // Runner returns not-found (simplest success path that doesn't collide).
      const enrich = jest.fn(async () => ({ kind: 'not-found' as const }));
      const enricher = makeEnricher(db, enrich) as Enricher & {
        resumeEntitlementPaused: () => Promise<void>;
      };

      await enricher.resumeEntitlementPaused();
      await enricher._awaitIdle();

      // Runner called exactly twice — once per resumed place.
      expect(enrich).toHaveBeenCalledTimes(2);

      // Both paused columns cleared.
      const p1Row = await db.getFirstAsync<{ enrichment_paused_reason: string | null }>(
        `SELECT enrichment_paused_reason FROM places WHERE id = 'p1'`,
      );
      const p2Row = await db.getFirstAsync<{ enrichment_paused_reason: string | null }>(
        `SELECT enrichment_paused_reason FROM places WHERE id = 'p2'`,
      );
      expect(p1Row?.enrichment_paused_reason).toBeNull();
      expect(p2Row?.enrichment_paused_reason).toBeNull();
    });
  });
});

const PROXY_URL = 'https://proxy.example.com/enrich';

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('enrichFromProxy', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Reset mock back to the default success impl between tests.
    (getEntitlementUserId as jest.Mock).mockResolvedValue(
      '$RCAnonymousID:0123456789abcdef0123456789abcdef',
    );
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('401 from the worker classifies as entitlement-required', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(401, { error: 'entitlement-required' }),
    ) as unknown as typeof fetch;

    await expect(
      enrichFromProxy(
        {
          place_id: 'p1',
          name: 'X',
          city: 'Tokyo',
          address: null,
          ocr_caption: 'some caption',
        },
        PROXY_URL,
      ),
    ).rejects.toMatchObject({ classification: 'entitlement-required' });
  });

  it('attaches X-RC-User-Id header on every fetch call', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResp(200, { status: 'not-found' }),
    ) as unknown as typeof fetch;

    await enrichFromProxy(
      {
        place_id: 'p1',
        name: 'X',
        city: 'Tokyo',
        address: null,
        ocr_caption: 'some caption',
      },
      PROXY_URL,
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      PROXY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-RC-User-Id': '$RCAnonymousID:0123456789abcdef0123456789abcdef',
        }),
      }),
    );
  });

  it('throws entitlement-required (without fetching) when getEntitlementUserId rejects', async () => {
    (getEntitlementUserId as jest.Mock).mockRejectedValueOnce(new Error('rc-not-ready'));
    globalThis.fetch = jest.fn() as unknown as typeof fetch;

    await expect(
      enrichFromProxy(
        {
          place_id: 'p1',
          name: 'X',
          city: 'Tokyo',
          address: null,
          ocr_caption: 'some caption',
        },
        PROXY_URL,
      ),
    ).rejects.toMatchObject({ classification: 'entitlement-required' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
