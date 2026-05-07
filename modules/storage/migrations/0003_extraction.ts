import type { Migration } from '../db';

// The day-one (0001) `extracted_places` table reserved the data columns
// (name, city, category, raw_text, confidence, extraction_model) but no
// geocoding fields — those land here, alongside an index on screenshot_id
// so the per-thumbnail place-count LEFT JOIN scales as the dataset grows.
export const extraction: Migration = {
  version: 3,
  up: async (db) => {
    await db.execAsync(`
      ALTER TABLE extracted_places ADD COLUMN latitude REAL;
      ALTER TABLE extracted_places ADD COLUMN longitude REAL;
      ALTER TABLE extracted_places ADD COLUMN formatted_address TEXT;
      ALTER TABLE extracted_places ADD COLUMN apple_maps_url TEXT;

      CREATE INDEX IF NOT EXISTS idx_extracted_places_screenshot
        ON extracted_places(screenshot_id) WHERE deleted_at IS NULL;
    `);
  },
};
