import type { Migration } from '../db';

// Day-one (0001) created `screenshots_fts` with `tokenize = 'porter unicode61'`,
// which only matches token prefixes — `MATCH '定食*'` against indexed `とんかつ定食`
// returns nothing. The product promise is "find a fragment of any text", and
// Japanese OCR is in scope, so we rebuild with the trigram tokenizer.
//
// The day-one FTS table is empty (no migration ever wrote to it), so DROP-and-
// recreate is lossless.
export const ocrFts: Migration = {
  version: 2,
  up: async (db) => {
    await db.execAsync(`
      DROP TABLE IF EXISTS screenshots_fts;

      CREATE VIRTUAL TABLE screenshots_fts USING fts5(
        screenshot_id UNINDEXED,
        content,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS screenshots_fts_ai
      AFTER INSERT ON screenshots
      WHEN NEW.deleted_at IS NULL AND NEW.ocr_text IS NOT NULL
      BEGIN
        INSERT INTO screenshots_fts (screenshot_id, content)
        VALUES (NEW.id, NEW.ocr_text);
      END;

      CREATE TRIGGER IF NOT EXISTS screenshots_fts_au
      AFTER UPDATE OF ocr_text, deleted_at ON screenshots
      BEGIN
        DELETE FROM screenshots_fts WHERE screenshot_id = OLD.id;
        INSERT INTO screenshots_fts (screenshot_id, content)
          SELECT NEW.id, NEW.ocr_text
           WHERE NEW.deleted_at IS NULL AND NEW.ocr_text IS NOT NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS screenshots_fts_ad
      AFTER DELETE ON screenshots
      BEGIN
        DELETE FROM screenshots_fts WHERE screenshot_id = OLD.id;
      END;
    `);
  },
};
