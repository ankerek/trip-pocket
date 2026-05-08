import type { Migration } from '../db';

// Persist the OCR-extracted street address on extracted_places. Today it
// drives the Apple Maps search-URL deep link in PlaceRow (without it, the
// `?q=` query is just name+city — too ambiguous for foreign cities).
// Tomorrow it's the input to the v1.x place-enrichment call (Google
// Places "Find Place from Text"); see
// docs/superpowers/specs/2026-05-08-place-enrichment-design.md.
export const extractedAddress: Migration = {
  version: 4,
  up: async (db) => {
    await db.execAsync(`
      ALTER TABLE extracted_places ADD COLUMN address TEXT;
    `);
  },
};
