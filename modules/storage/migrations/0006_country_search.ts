import type { Migration } from '../db';
import { COUNTRY_NAMES } from '@/components/CountryDisplay';

// Index country names into places_fts so search can hit a country term like
// "Japan" or "Italy" even though `places.country_code` stores the ISO alpha-2
// code. The English name lives only in a JS map (components/CountryDisplay),
// so we mirror it into a `country_names(code, name)` table and have the
// places_fts triggers JOIN it.
//
// The places_fts_au watch list gains `country_code` so a later enrichment
// that flips the code rebuilds the FTS doc. The three place_sources triggers
// also pick up the country term — they already rebuild the full doc when a
// source is linked / updated / unlinked.
//
// New countries can be added in a follow-up migration that INSERTs into
// country_names; the triggers don't need to change for that.

export const countrySearch: Migration = {
  version: 6,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE country_names (
        code TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL
      );
    `);

    for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
      await db.runAsync(
        'INSERT INTO country_names (code, name) VALUES (?, ?)',
        code,
        name,
      );
    }

    await db.execAsync(`
      DROP TRIGGER IF EXISTS places_fts_ai;
      DROP TRIGGER IF EXISTS places_fts_au;
      DROP TRIGGER IF EXISTS place_sources_fts_ai;
      DROP TRIGGER IF EXISTS place_sources_fts_au;
      DROP TRIGGER IF EXISTS place_sources_fts_ad;

      CREATE TRIGGER places_fts_ai
      AFTER INSERT ON places
      BEGIN
        INSERT INTO places_fts (place_id, content) VALUES (
          NEW.id,
          NEW.name || ' ' || coalesce(NEW.city, '') || ' ' ||
          coalesce(NEW.description, '') || ' ' ||
          coalesce((SELECT name FROM country_names WHERE code = NEW.country_code), '')
        );
      END;

      CREATE TRIGGER places_fts_au
      AFTER UPDATE OF name, city, description, country_code ON places
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.id;
        INSERT INTO places_fts (place_id, content)
          SELECT NEW.id,
                 NEW.name || ' ' || coalesce(NEW.city, '') || ' ' ||
                 coalesce(NEW.description, '') || ' ' ||
                 coalesce((SELECT name FROM country_names WHERE code = NEW.country_code), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id), '');
      END;

      CREATE TRIGGER place_sources_fts_ai
      AFTER INSERT ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' ||
                 coalesce(p.description, '') || ' ' ||
                 coalesce((SELECT name FROM country_names WHERE code = p.country_code), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = NEW.place_id;
      END;

      CREATE TRIGGER place_sources_fts_au
      AFTER UPDATE OF raw_text, extracted_address ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' ||
                 coalesce(p.description, '') || ' ' ||
                 coalesce((SELECT name FROM country_names WHERE code = p.country_code), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = NEW.place_id;
      END;

      CREATE TRIGGER place_sources_fts_ad
      AFTER DELETE ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' ||
                 coalesce(p.description, '') || ' ' ||
                 coalesce((SELECT name FROM country_names WHERE code = p.country_code), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = OLD.place_id;
      END;

      DELETE FROM places_fts;
      INSERT INTO places_fts (place_id, content)
        SELECT p.id,
               p.name || ' ' || coalesce(p.city, '') || ' ' ||
               coalesce(p.description, '') || ' ' ||
               coalesce((SELECT name FROM country_names WHERE code = p.country_code), '') ||
               coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                           FROM place_sources
                          WHERE place_id = p.id), '') ||
               coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                           FROM place_sources
                          WHERE place_id = p.id), '')
          FROM places p;
    `);
  },
};
