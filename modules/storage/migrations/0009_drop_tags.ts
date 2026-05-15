import type { Migration } from '../db';

// Drops the `tags` table (introduced in 0001_init, never written to by app
// code) and rebuilds the `sources_fts_ai`/`_au`/`_ad` triggers without the
// dead `FROM tags` subquery. Spec:
// docs/superpowers/specs/2026-05-15-place-category-taxonomy-design.md.
//
// Ordering matters: the existing triggers reference the table via a
// correlated subquery, so we must drop the triggers before the table,
// then recreate them with the tag-less content expression.
//
// `sources_fts_ad` doesn't reference `tags` — it's recreated for symmetry
// so the three triggers stay a coherent unit in one place.
//
// Existing `sources_fts` rows are not rebuilt. The tags subquery always
// returned empty (no rows were ever inserted into `tags`), so the indexed
// content is bit-for-bit identical to what the new triggers will produce.
export const dropTags: Migration = {
  version: 9,
  up: async (db) => {
    await db.execAsync(`
      DROP TRIGGER IF EXISTS sources_fts_ai;
      DROP TRIGGER IF EXISTS sources_fts_au;
      DROP TRIGGER IF EXISTS sources_fts_ad;

      DROP TABLE IF EXISTS tags;

      CREATE TRIGGER sources_fts_ai
      AFTER INSERT ON sources
      BEGIN
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '');
      END;

      CREATE TRIGGER sources_fts_au
      AFTER UPDATE OF ocr_text, trip_id ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '');
      END;

      CREATE TRIGGER sources_fts_ad
      AFTER DELETE ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
      END;
    `);
  },
};
