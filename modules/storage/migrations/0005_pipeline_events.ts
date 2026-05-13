import type { Migration } from '../db';

// pipeline_events backs the per-source pipeline observability layer
// described in docs/superpowers/specs/2026-05-13-pipeline-observability-design.md.
// One row per stage transition (per-attempt, including retries). The table
// holds no content fields — only stages, statuses, timing, and a closed-vocab
// error class — so on-device storage stays bounded and the privacy posture
// stays the same as `sources.ocr_status` does today.
//
// `source_id` is nullable. The standard pattern is to pre-allocate the source
// UUID at the start of share_import / url_share_import and thread it through
// every downstream stage so every row for one import groups under one id.
// NULL is the fallback for the (currently out-of-scope) case where a row is
// emitted before any id is allocatable.

export const pipelineEvents: Migration = {
  version: 5,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE pipeline_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id     TEXT,
        stage         TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('done','failed')),
        occurred_at   TEXT NOT NULL,
        duration_ms   INTEGER NOT NULL,
        error_summary TEXT
      );

      CREATE INDEX idx_pipeline_events_source
        ON pipeline_events(source_id);
      CREATE INDEX idx_pipeline_events_occurred
        ON pipeline_events(occurred_at DESC);
    `);
  },
};
