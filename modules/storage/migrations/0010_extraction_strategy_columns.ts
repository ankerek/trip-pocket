import type { Migration } from '../db';

// Adds two nullable columns to `sources` for the composable extraction
// pipeline (spec 2026-05-16-extraction-pipeline-composability-design.md):
//
//   - extraction_strategy: which strategy will run / ran for this source.
//     Stamped at row-creation time from `forceStrategy` in app.config.
//     NULL on legacy rows (pre-migration); orchestrator treats NULL as
//     'ocrTextLLM'.
//
//   - fetched_via: which LinkFetcher in the worker chain returned the URL
//     fetch result. Telemetry / debugging. NULL on rows that haven't been
//     URL-fetched (image sources) or were fetched before the chain landed.
//
// Both nullable, no CHECK constraint — Zod at the boundary enforces typing.
// `ALTER TABLE ADD COLUMN` is a metadata-only change in SQLite (no table
// rebuild), so this migration is fast even on a populated database.

export const extractionStrategyColumns: Migration = {
  version: 10,
  up: async (db) => {
    await db.execAsync(`ALTER TABLE sources ADD COLUMN extraction_strategy TEXT`);
    await db.execAsync(`ALTER TABLE sources ADD COLUMN fetched_via TEXT`);
  },
};
