import type { Migration } from '../db';

// Pre-2026-05-13, file-based sources used `kind='screenshot'`. The name was
// misleading — the column also covers photographed pictures, downloaded
// images, and worker-fetched cover thumbnails. The umbrella term across all
// of these is "image" (matches the existing `importImage.ts` module name).
//
// SQLite CHECK constraints can't be altered in place, so this rebuilds the
// `sources` table with the new CHECK and rewrites existing rows from
// 'screenshot' to 'image'. `place_sources.source_id` references `sources(id)`,
// and SQLite ignores PRAGMA foreign_keys toggles inside a transaction, so the
// migration declares `disableForeignKeys: true` — runMigrations turns FK off
// before BEGIN and back on after COMMIT, around just this migration.

export const renameScreenshotToImage: Migration = {
  version: 4,
  disableForeignKeys: true,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE sources_new (
        id                TEXT PRIMARY KEY NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('image','url','pasted')),
        platform          TEXT CHECK (platform IS NULL OR platform IN ('instagram','tiktok')),
        trip_id           TEXT,
        file_path         TEXT,
        url               TEXT,
        caption           TEXT,
        content_hash      TEXT NOT NULL,
        origin            TEXT NOT NULL CHECK (origin IN ('share','auto','manual')),
        ocr_status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK (ocr_status IN ('pending','done','failed')),
        ocr_text          TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'pending'
                          CHECK (extraction_status IN ('pending','done','failed')),
        captured_at       TEXT NOT NULL,
        owner_id          TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      INSERT INTO sources_new (
        id, kind, platform, trip_id, file_path, url, caption,
        content_hash, origin, ocr_status, ocr_text,
        extraction_status, captured_at, owner_id, created_at, updated_at
      )
      SELECT
        id,
        CASE WHEN kind = 'screenshot' THEN 'image' ELSE kind END,
        platform, trip_id, file_path, url, caption,
        content_hash, origin, ocr_status, ocr_text,
        extraction_status, captured_at, owner_id, created_at, updated_at
      FROM sources;

      -- DROP cascades and removes the old indexes + FTS triggers attached to
      -- the table. The sources_fts virtual table is independent and survives;
      -- its rows still point at the (preserved) source ids.
      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;

      CREATE INDEX IF NOT EXISTS idx_sources_trip
        ON sources(trip_id);
      CREATE INDEX IF NOT EXISTS idx_sources_captured_at
        ON sources(captured_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash
        ON sources(content_hash);

      -- Re-attach the FTS maintenance triggers. These mirror 0001_init.ts
      -- and are dropped along with the old sources table above.
      CREATE TRIGGER sources_fts_ai
      AFTER INSERT ON sources
      BEGIN
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '') ||
                 coalesce(' ' || (SELECT GROUP_CONCAT(value, ' ')
                                    FROM tags
                                   WHERE source_id = NEW.id), '');
      END;

      CREATE TRIGGER sources_fts_au
      AFTER UPDATE OF ocr_text, trip_id ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '') ||
                 coalesce(' ' || (SELECT GROUP_CONCAT(value, ' ')
                                    FROM tags
                                   WHERE source_id = NEW.id), '');
      END;

      CREATE TRIGGER sources_fts_ad
      AFTER DELETE ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
      END;
    `);
  },
};
