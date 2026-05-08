import type { Migration } from '../db';

// Single, fresh schema. The places-first restructure (see
// docs/superpowers/specs/2026-05-08-places-first-restructure-design.md)
// landed before any users existed, so we collapsed every prior migration
// into one init instead of carrying old shapes forward. Anyone with a
// pre-restructure dev DB needs to delete it (`trip-pocket.db` in the
// simulator app sandbox).
//
// Tables, in dependency order:
//   trips           — collections owned by the user
//   sources         — every captured input (today only kind='screenshot';
//                     future kinds: 'url', 'pasted'). Generalised name so
//                     Instagram-post / URL ingestion lands in this slot
//                     instead of forcing another rename later.
//   places          — canonical Place. Each row is one real-world venue,
//                     keyed for dedup by normalized_key (pre-enrichment,
//                     non-unique — sole-match enforced in app code) and
//                     by external_place_id once enrichment resolves it
//                     (UNIQUE per owner among live rows).
//   place_sources   — many-to-many junction. Carries per-extraction
//                     metadata (raw_text, extracted_address, confidence,
//                     extraction_model) and the standard syncable
//                     columns. The only path between a place and the
//                     source(s) it came from.
//   tags            — kept on the source row for the transition; will
//                     migrate to place-keyed tags in a follow-up.
//   pending_imports — share-extension hand-off mailbox. Not synced.
//   meta            — single-row settings table.
//
// FTS:
//   places_fts      — name + city + description + concatenated raw_text
//                     (capped 2KB per source) + extracted_address.
//   sources_fts     — ocr_text + parent trip name + tag values.
//
// Triggers maintain both FTS docs across writes to places, place_sources,
// sources, and indirectly trips/tags.
export const init: Migration = {
  version: 1,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS trips (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        color       TEXT,
        owner_id    TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS sources (
        id                TEXT PRIMARY KEY NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('screenshot','url','pasted')),
        trip_id           TEXT,
        file_path         TEXT,
        url               TEXT,
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
        deleted_at        TEXT,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sources_trip
        ON sources(trip_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sources_captured_at
        ON sources(captured_at DESC) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash
        ON sources(content_hash) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS places (
        id                 TEXT PRIMARY KEY NOT NULL,
        trip_id            TEXT,
        name               TEXT NOT NULL,
        city               TEXT,
        category           TEXT,
        normalized_key     TEXT NOT NULL,

        -- Enrichment-derived (NULL until /enrich resolves).
        external_place_id  TEXT,
        photo_name         TEXT,
        description        TEXT,
        rating             REAL,
        price_level        INTEGER,
        external_url       TEXT,
        latitude           REAL,
        longitude          REAL,
        formatted_address  TEXT,
        enrichment_status  TEXT NOT NULL DEFAULT 'pending'
                           CHECK (enrichment_status IN ('pending','enriched','not-found','failed')),
        enriched_at        TEXT,
        enrichment_model   TEXT,

        owner_id           TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        deleted_at         TEXT,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      -- Non-unique: sole-match dedup is enforced in modules/extraction
      -- so same-name chains (Starbucks-in-Tokyo) don't silently collapse.
      CREATE INDEX IF NOT EXISTS idx_places_normalized_key
        ON places(normalized_key, owner_id) WHERE deleted_at IS NULL;

      -- Owner-scoped uniqueness, partial index lets the merge soft-delete
      -- a loser without violating the constraint.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_places_external_place_id
        ON places(external_place_id, owner_id)
        WHERE external_place_id IS NOT NULL AND deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_places_trip
        ON places(trip_id) WHERE deleted_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_places_enrichment_pending
        ON places(enrichment_status)
        WHERE enrichment_status = 'pending' AND deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS place_sources (
        place_id          TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        extracted_at      TEXT NOT NULL,
        raw_text          TEXT,
        extracted_address TEXT,
        confidence        REAL,
        extraction_model  TEXT NOT NULL,
        owner_id          TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        deleted_at        TEXT,
        PRIMARY KEY (place_id, source_id),
        FOREIGN KEY (place_id)  REFERENCES places(id),
        FOREIGN KEY (source_id) REFERENCES sources(id)
      );

      CREATE INDEX IF NOT EXISTS idx_place_sources_source
        ON place_sources(source_id) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS tags (
        id            TEXT PRIMARY KEY NOT NULL,
        source_id     TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('place','food','activity')),
        value         TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id)
      );

      CREATE TABLE IF NOT EXISTS pending_imports (
        id                TEXT PRIMARY KEY NOT NULL,
        app_group_path    TEXT NOT NULL,
        suggested_trip_id TEXT,
        created_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(
        place_id UNINDEXED,
        content,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS places_fts_ai
      AFTER INSERT ON places
      WHEN NEW.deleted_at IS NULL
      BEGIN
        INSERT INTO places_fts (place_id, content) VALUES (
          NEW.id,
          NEW.name || ' ' || coalesce(NEW.city, '') || ' ' || coalesce(NEW.description, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS places_fts_au
      AFTER UPDATE OF name, city, description, deleted_at ON places
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.id;
        INSERT INTO places_fts (place_id, content)
          SELECT NEW.id,
                 NEW.name || ' ' || coalesce(NEW.city, '') || ' ' || coalesce(NEW.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id AND deleted_at IS NULL), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id AND deleted_at IS NULL), '')
           WHERE NEW.deleted_at IS NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS places_fts_ad
      AFTER DELETE ON places
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS place_sources_fts_ai
      AFTER INSERT ON place_sources
      WHEN NEW.deleted_at IS NULL
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '')
            FROM places p
           WHERE p.id = NEW.place_id AND p.deleted_at IS NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS place_sources_fts_au
      AFTER UPDATE OF raw_text, extracted_address, deleted_at ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '')
            FROM places p
           WHERE p.id = NEW.place_id AND p.deleted_at IS NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS place_sources_fts_ad
      AFTER DELETE ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id AND deleted_at IS NULL), '')
            FROM places p
           WHERE p.id = OLD.place_id AND p.deleted_at IS NULL;
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
        source_id UNINDEXED,
        content,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS sources_fts_ai
      AFTER INSERT ON sources
      WHEN NEW.deleted_at IS NULL
      BEGIN
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '') ||
                 coalesce(' ' || (SELECT GROUP_CONCAT(value, ' ')
                                    FROM tags
                                   WHERE source_id = NEW.id AND deleted_at IS NULL), '');
      END;

      CREATE TRIGGER IF NOT EXISTS sources_fts_au
      AFTER UPDATE OF ocr_text, trip_id, deleted_at ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
        INSERT INTO sources_fts (source_id, content)
          SELECT NEW.id,
                 coalesce(NEW.ocr_text, '') ||
                 coalesce(' ' || (SELECT name FROM trips WHERE id = NEW.trip_id), '') ||
                 coalesce(' ' || (SELECT GROUP_CONCAT(value, ' ')
                                    FROM tags
                                   WHERE source_id = NEW.id AND deleted_at IS NULL), '')
           WHERE NEW.deleted_at IS NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS sources_fts_ad
      AFTER DELETE ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
      END;
    `);
  },
};
