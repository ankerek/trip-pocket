import type { Migration } from '../db';

// Adds three nullable `*_paused_reason` columns to the pipeline tables.
// Filled with the literal `'entitlement'` when the worker returns 401;
// null otherwise. Sweep filters add `AND <col> IS NULL` so paused rows
// are skipped; the resume sweep flips them back to null when entitlement
// is re-acquired. The URL-fetch column lives on `sources` (not on
// `pending_imports`) because by the time url-fetch runs, the pending row
// has been DELETEd by `ingestPendingImports`.

export const entitlementPausedReason: Migration = {
  version: 7,
  up: async (db) => {
    await db.execAsync(`ALTER TABLE sources ADD COLUMN extraction_paused_reason TEXT`);
    await db.execAsync(`ALTER TABLE sources ADD COLUMN url_fetch_paused_reason TEXT`);
    await db.execAsync(`ALTER TABLE places ADD COLUMN enrichment_paused_reason TEXT`);
  },
};
