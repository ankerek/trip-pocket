import type { Migration } from '../db';

export const init: Migration = {
  version: 1,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE screenshots (
        id TEXT PRIMARY KEY NOT NULL,
        trip_id TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('share','auto','manual')),
        ocr_status TEXT NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending','done','failed')),
        ocr_text TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','done','failed')),
        captured_at TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      CREATE INDEX idx_screenshots_trip ON screenshots(trip_id) WHERE deleted_at IS NULL;
      CREATE INDEX idx_screenshots_captured_at ON screenshots(captured_at DESC) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX idx_screenshots_hash ON screenshots(content_hash) WHERE deleted_at IS NULL;

      CREATE TABLE tags (
        id TEXT PRIMARY KEY NOT NULL,
        screenshot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('place','food','activity')),
        value TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (screenshot_id) REFERENCES screenshots(id)
      );

      CREATE TABLE extracted_places (
        id TEXT PRIMARY KEY NOT NULL,
        screenshot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        city TEXT,
        category TEXT,
        raw_text TEXT,
        confidence REAL,
        extraction_model TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (screenshot_id) REFERENCES screenshots(id)
      );

      CREATE TABLE pending_imports (
        id TEXT PRIMARY KEY NOT NULL,
        app_group_path TEXT NOT NULL,
        suggested_trip_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );

      CREATE VIRTUAL TABLE screenshots_fts USING fts5(
        screenshot_id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  },
};
