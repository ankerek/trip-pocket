import type { Migration } from '../db';

// Place enrichment schema. Two tables work together:
//
//   place_enrichments: venue-keyed, one row per Google Places venue. Holds
//   the data we get back from /enrich (photo_name, blurb, rating, lat/lng,
//   etc.). Multiple extracted_places rows pointing at the same venue share
//   one enrichment row, so "saved Kosoan three times" pays for one
//   enrichment, not three.
//
//   extracted_places.external_place_id: the per-row link to the venue.
//   NULL until the row's first /enrich resolves. extracted_places gains
//   two more per-row tracking columns:
//     - enrichment_status: 'pending' | 'enriched' | 'not-found' | 'failed'.
//       Per-row attempt state — a venue may be 'not-found' for one row's
//       OCR-key but 'enriched' for a sibling row whose OCR was sharper.
//     - enriched_at: timestamp of the row's last successful resolution.
//
// `latitude` / `longitude` / `formatted_address` / `apple_maps_url` columns
// from migration 0003 stay on extracted_places but are no longer written:
// the venue-level values live in place_enrichments and are joined at
// query time. Cleanup migration deferred to keep this small.
//
// See docs/superpowers/specs/2026-05-08-place-enrichment-design.md.
export const placeEnrichments: Migration = {
  version: 5,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS place_enrichments (
        external_place_id  TEXT PRIMARY KEY NOT NULL,
        photo_name         TEXT,
        description        TEXT,
        rating             REAL,
        price_level        INTEGER,
        external_url       TEXT,
        latitude           REAL,
        longitude          REAL,
        formatted_address  TEXT,
        fetched_at         TEXT NOT NULL,
        model              TEXT NOT NULL
      );

      ALTER TABLE extracted_places ADD COLUMN external_place_id TEXT;
      ALTER TABLE extracted_places ADD COLUMN enrichment_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE extracted_places ADD COLUMN enriched_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_extracted_places_external_place_id
        ON extracted_places(external_place_id) WHERE deleted_at IS NULL;
    `);
  },
};
