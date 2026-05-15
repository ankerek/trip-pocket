import type { Migration } from '../db';

// Renames the legacy `places.category` enum (`place`/`food`/`activity`) onto
// the six-bucket taxonomy: food / drinks / stays / sights / activities / shops.
// Spec: docs/superpowers/specs/2026-05-15-place-category-taxonomy-design.md.
//
// 'food' rows keep their value (meaning preserved).
// 'activity' rows become 'activities' (same bucket, new spelling).
// 'place' rows become NULL — the legacy junk drawer mapped to too many of the
// new buckets to auto-assign safely; the existing fallback (generic pin icon)
// covers them, and a new save in the same place will reclassify under the new
// taxonomy.
//
// Idempotent on re-run: the WHERE filters miss after the first pass.
export const categoryRename: Migration = {
  version: 8,
  up: async (db) => {
    await db.execAsync(`
      UPDATE places SET category = 'activities' WHERE category = 'activity';
      UPDATE places SET category = NULL         WHERE category = 'place';
    `);
  },
};
