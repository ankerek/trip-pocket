# Delete cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace soft-delete-without-purge with hard-delete + symmetric orphan prune across the four-table schema. Add two trip-delete affordances (gentle untriage default, opt-in cascade) and a tertiary Delete row in triage. Drop the `deleted_at` column entirely.

**Architecture:** Three layers. (1) Storage layer — rewrite `softDelete*` functions to `delete*` with hard-DELETE and cascade rules; rewrite `transferJunctions` for the new schema; resequence the enrichment-merge collision path. (2) Schema — edit `0001_init.ts` in place to drop `deleted_at` from five tables, recreate eight indexes without `deleted_at` predicates, and rebuild nine FTS triggers without `deleted_at` filters; developers wipe their dev DB. (3) UI — orphan-prune-aware confirm dialogs on place detail, source detail, and trip edit; new "Delete" tertiary row in the triage CTA tray.

**Tech Stack:** Expo SQLite, expo-file-system (`File` class), React Native + expo-router, Jest + React Native Testing Library. Spec: `docs/superpowers/specs/2026-05-10-delete-cascade-design.md`.

**Pre-flight before starting:**

1. Wipe the dev DB. Either delete the simulator app, or remove `trip-pocket.db` from the simulator app sandbox. Schema changes won't apply over an existing DB because `runMigrations` skips by version.
2. Confirm baseline test suite is green: `npm test --silent` should report `Test Suites: 23 passed, Tests: 234 passed`.

---

## Task 1: trips — `softDeleteTrip` → `deleteTrip(id, mode)`

**Goal:** Rename and rewrite the trip-delete function. Default `mode='untriage'` matches today's gentle behaviour but hard-deletes the trip row. New `mode='cascade'` removes member sources (with file unlinks), member places (with orphan-prune scoping), tags, and the trip itself.

**Files:**

- Modify: `modules/storage/trips.ts`
- Modify: `modules/storage/index.ts:47-56`
- Modify: `modules/storage/__tests__/trips.test.ts`
- Modify: `app/trips/[id]/edit.tsx:9,104` (consumer update — keep wiring identical to today, full UI rewrite is Task 12)

- [ ] **Step 1.1: Rewrite tests in `modules/storage/__tests__/trips.test.ts`**

Replace the entire file with:

```ts
import { File } from 'expo-file-system';
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { createTrip, listTrips, getTrip, renameTrip, deleteTrip } from '../trips';
import { insertSource, listSources } from '../sources';
import { linkPlaceSource } from '../place_sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedPlace(db: Database, id: string, tripId: string | null): Promise<void> {
  const now = '2026-05-10T10:00:00.000Z';
  await db.runAsync(
    `INSERT INTO places (id, trip_id, name, city, normalized_key,
                         enrichment_status, owner_id, created_at, updated_at)
     VALUES (?, ?, 'Place ' || ?, 'Tokyo', 'p-' || ?, 'pending', ?, ?, ?)`,
    id,
    tripId,
    id,
    id,
    ownerId,
    now,
    now,
  );
}

describe('trips repository', () => {
  it('createTrip inserts a row and listTrips returns it', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    const rows = await listTrips(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't1', name: 'Japan', ownerId });
    expect(rows[0]?.color).toBeNull();
  });

  it('listTrips orders alphabetically case-insensitive', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'iceland', ownerId });
    await createTrip(db, { id: 't2', name: 'Brazil', ownerId });
    await createTrip(db, { id: 't3', name: 'argentina', ownerId });
    const rows = await listTrips(db);
    expect(rows.map((r) => r.name)).toEqual(['argentina', 'Brazil', 'iceland']);
  });

  it('getTrip returns the trip; null for missing or deleted', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    expect((await getTrip(db, 't1'))?.name).toBe('Japan');
    expect(await getTrip(db, 'missing')).toBeNull();

    await deleteTrip(db, 't1');
    expect(await getTrip(db, 't1')).toBeNull();
  });

  it('renameTrip updates name and updated_at', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    const before = await getTrip(db, 't1');
    await new Promise((r) => setTimeout(r, 5));
    await renameTrip(db, { id: 't1', name: 'Nippon' });
    const after = await getTrip(db, 't1');
    expect(after?.name).toBe('Nippon');
    expect(after && before && after.updatedAt > before.updatedAt).toBe(true);
  });

  describe('deleteTrip — untriage (default)', () => {
    it('clears trip_id on member sources and places, removes the trip row', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await insertSource(db, {
        id: 's1',
        tripId: 't1',
        filePath: '/x/s1.jpg',
        contentHash: 'h-s1',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await seedPlace(db, 'p1', 't1');

      await deleteTrip(db, 't1');

      expect(await listTrips(db)).toEqual([]);
      const inbox = await listSources(db, { tripId: null });
      expect(inbox.map((r) => r.id)).toEqual(['s1']);
      const placeRow = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM places WHERE id = 'p1'`,
      );
      expect(placeRow?.trip_id).toBeNull();
    });

    it('explicit mode argument behaves the same as default', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await deleteTrip(db, 't1', 'untriage');
      expect(await getTrip(db, 't1')).toBeNull();
    });
  });

  describe('deleteTrip — cascade', () => {
    it('removes the trip, all member sources, their files, places, junctions, and tags', async () => {
      const db = await freshDb();
      const deletedFiles: string[] = [];
      const fakeUnlink = (path: string) => deletedFiles.push(path);

      await createTrip(db, { id: 't1', name: 'Japan', ownerId });
      await insertSource(db, {
        id: 's1',
        tripId: 't1',
        filePath: '/x/s1.jpg',
        contentHash: 'h-s1',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await insertSource(db, {
        id: 's2',
        tripId: 't1',
        filePath: '/x/s2.jpg',
        contentHash: 'h-s2',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:01Z',
        ownerId,
      });
      await seedPlace(db, 'p1', 't1');
      await seedPlace(db, 'p2', 't1');
      await linkPlaceSource(db, {
        placeId: 'p1',
        sourceId: 's1',
        extractionModel: 'gemini',
        ownerId,
      });
      await linkPlaceSource(db, {
        placeId: 'p2',
        sourceId: 's2',
        extractionModel: 'gemini',
        ownerId,
      });

      await deleteTrip(db, 't1', 'cascade', { unlinkFile: fakeUnlink });

      expect(await getTrip(db, 't1')).toBeNull();
      const sources = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM sources WHERE id IN ('s1', 's2')`,
      );
      expect(sources).toEqual([]);
      const places = await db.getAllAsync<{ id: string }>(
        `SELECT id FROM places WHERE id IN ('p1', 'p2')`,
      );
      expect(places).toEqual([]);
      const junctions = await db.getAllAsync<{ source_id: string }>(
        `SELECT source_id FROM place_sources WHERE source_id IN ('s1', 's2')`,
      );
      expect(junctions).toEqual([]);
      expect(deletedFiles.sort()).toEqual(['/x/s1.jpg', '/x/s2.jpg']);
    });

    it('preserves a place shared with another trip; clears its trip_id only', async () => {
      const db = await freshDb();
      await createTrip(db, { id: 'tA', name: 'Japan', ownerId });
      await createTrip(db, { id: 'tB', name: 'Korea', ownerId });
      // pShared has two sources: sA in trip tA, sB in trip tB.
      await insertSource(db, {
        id: 'sA',
        tripId: 'tA',
        filePath: '/x/sA.jpg',
        contentHash: 'h-A',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:00Z',
        ownerId,
      });
      await insertSource(db, {
        id: 'sB',
        tripId: 'tB',
        filePath: '/x/sB.jpg',
        contentHash: 'h-B',
        origin: 'manual',
        capturedAt: '2026-05-10T10:00:01Z',
        ownerId,
      });
      await seedPlace(db, 'pShared', 'tA');
      await linkPlaceSource(db, {
        placeId: 'pShared',
        sourceId: 'sA',
        extractionModel: 'gemini',
        ownerId,
      });
      await linkPlaceSource(db, {
        placeId: 'pShared',
        sourceId: 'sB',
        extractionModel: 'gemini',
        ownerId,
      });

      await deleteTrip(db, 'tA', 'cascade', { unlinkFile: () => {} });

      // pShared survives because sB still backs it.
      const place = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM places WHERE id = 'pShared'`,
      );
      expect(place).toBeTruthy();
      expect(place?.trip_id).toBeNull(); // defensive untriage
      // sB and tB untouched.
      const sB = await db.getFirstAsync<{ trip_id: string | null }>(
        `SELECT trip_id FROM sources WHERE id = 'sB'`,
      );
      expect(sB?.trip_id).toBe('tB');
      // sA gone, junction sA gone.
      expect(await db.getFirstAsync(`SELECT id FROM sources WHERE id = 'sA'`)).toBeNull();
      const sharedJunctions = await db.getAllAsync<{ source_id: string }>(
        `SELECT source_id FROM place_sources WHERE place_id = 'pShared'`,
      );
      expect(sharedJunctions.map((r) => r.source_id)).toEqual(['sB']);
    });
  });
});
```

- [ ] **Step 1.2: Run tests, verify they fail**

```bash
npx jest modules/storage/__tests__/trips.test.ts 2>&1 | tail -20
```

Expected: tests fail because `deleteTrip` is not exported yet. Errors include `TypeError: deleteTrip is not a function` or `Module has no exported member 'deleteTrip'`.

- [ ] **Step 1.3: Rewrite `modules/storage/trips.ts`**

Replace the file's exports section (the `softDeleteTrip` function at lines 92-122) and add a new `deleteTrip` function. Full replacement of `softDeleteTrip`:

```ts
export type DeleteTripMode = 'untriage' | 'cascade';

export type DeleteTripOptions = {
  /** Override the file-unlink primitive (used by tests to avoid touching disk). */
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    // File-cleanup failure is logged but does not block the DB transaction.
    // The cleanupOrphans worker reconciles disk against live sources on next launch.
    console.warn('[deleteTrip] unlink failed', path, err);
  }
};

export async function deleteTrip(
  db: Database,
  id: string,
  mode: DeleteTripMode = 'untriage',
  opts: DeleteTripOptions = {},
): Promise<void> {
  const now = new Date().toISOString();
  const unlink = opts.unlinkFile ?? defaultUnlink;

  if (mode === 'untriage') {
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE sources SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
        now,
        id,
      );
      await db.runAsync(
        `UPDATE places SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
        now,
        id,
      );
      await db.runAsync(`DELETE FROM trips WHERE id = ?`, id);
    });
    notifyChange('sources');
    notifyChange('places');
    notifyChange('trips');
    return;
  }

  // mode === 'cascade'
  let filePaths: string[] = [];
  await db.withTransactionAsync(async () => {
    // Snapshot before any DELETE.
    const fileRows = await db.getAllAsync<{ file_path: string | null }>(
      `SELECT file_path FROM sources WHERE trip_id = ? AND file_path IS NOT NULL`,
      id,
    );
    filePaths = fileRows.map((r) => r.file_path).filter((p): p is string => p !== null);

    const affectedPlaceRows = await db.getAllAsync<{ place_id: string }>(
      `SELECT DISTINCT place_id FROM place_sources
        WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    const affectedPlaceIds = affectedPlaceRows.map((r) => r.place_id);

    // FK-leaf cleanup: tags first.
    await db.runAsync(
      `DELETE FROM tags WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    // Junctions.
    await db.runAsync(
      `DELETE FROM place_sources WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)`,
      id,
    );
    // Orphan-prune places, scoped to affectedPlaceIds.
    if (affectedPlaceIds.length > 0) {
      const placeholders = affectedPlaceIds.map(() => '?').join(',');
      await db.runAsync(
        `DELETE FROM places
          WHERE id IN (${placeholders})
            AND id NOT IN (SELECT place_id FROM place_sources)`,
        ...affectedPlaceIds,
      );
    }
    // Defensive untriage: places that survived but were assigned to this trip.
    await db.runAsync(
      `UPDATE places SET trip_id = NULL, updated_at = ? WHERE trip_id = ?`,
      now,
      id,
    );
    // Now safe to delete sources (junctions and tags are gone).
    await db.runAsync(`DELETE FROM sources WHERE trip_id = ?`, id);
    await db.runAsync(`DELETE FROM trips WHERE id = ?`, id);
  });

  for (const path of filePaths) unlink(path);

  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('sources');
  notifyChange('trips');
}
```

Also: in the same file, remove the now-unused `softDeleteTrip` export. Replace the line `export async function softDeleteTrip(...)` with the new signatures above. Existing imports of `Database`, `notifyChange` at the top of the file remain.

- [ ] **Step 1.4: Update `modules/storage/index.ts`**

Replace the `softDeleteTrip,` export at line 52 with `deleteTrip,` and add the new types:

```ts
export {
  createTrip,
  listTrips,
  getTrip,
  renameTrip,
  deleteTrip,
  type Trip,
  type DeleteTripMode,
  type DeleteTripOptions,
  type InsertTripInput,
  type UpdateTripNameInput,
} from './trips';
```

- [ ] **Step 1.5: Update consumer in `app/trips/[id]/edit.tsx`**

Edit lines 6-11 (import) and line 104 (call site):

Replace:

```ts
import { getTrip, renameTrip, softDeleteTrip, type Trip } from '@/modules/storage';
```

With:

```ts
import { getTrip, renameTrip, deleteTrip, type Trip } from '@/modules/storage';
```

Replace `await softDeleteTrip(db, id);` (line 104) with `await deleteTrip(db, id);`.

This preserves today's behaviour exactly (untriage by default) — Task 12 reworks the UI to expose the cascade affordance.

- [ ] **Step 1.6: Run tests, verify pass**

```bash
npx jest modules/storage/__tests__/trips.test.ts 2>&1 | tail -10
npx tsc --noEmit 2>&1 | head -10
```

Expected: trips test suite green; tsc no errors.

- [ ] **Step 1.7: Commit**

```bash
git add modules/storage/trips.ts modules/storage/index.ts \
        modules/storage/__tests__/trips.test.ts \
        app/trips/[id]/edit.tsx
git commit -m "$(cat <<'EOF'
feat(storage): replace softDeleteTrip with deleteTrip(mode)

- mode='untriage' (default): hard-DELETE the trip row, untriage members.
- mode='cascade': remove sources + their files + junctions + tags + places
  (with defensive untriage for shared places that have other-trip sources).
- File unlink is injectable for tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: place_sources — `transferJunctions` swaps soft for hard delete

**Goal:** Make `transferJunctions` use hard-DELETE on the loser-side rows. Same shape, no change to call sites yet — the enrichment-merge sequence change is Task 3.

**Files:**

- Modify: `modules/storage/place_sources.ts:123-153`

- [ ] **Step 2.1: Edit `modules/storage/place_sources.ts`**

Replace the body of `transferJunctions` (lines 123-153). Find:

```ts
export async function transferJunctions(
  db: Database,
  loserId: string,
  winnerId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO place_sources (
       place_id, source_id, extracted_at, raw_text, extracted_address,
       confidence, extraction_model, owner_id, created_at, updated_at
     )
     SELECT ?, source_id, extracted_at, raw_text, extracted_address,
            confidence, extraction_model, owner_id, created_at, updated_at
       FROM place_sources
      WHERE place_id = ? AND deleted_at IS NULL
     ON CONFLICT(place_id, source_id) DO NOTHING`,
    winnerId,
    loserId,
  );
  // Soft-delete the loser's junction rows so it has no live attachments.
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE place_sources
        SET deleted_at = ?, updated_at = ?
      WHERE place_id = ? AND deleted_at IS NULL`,
    now,
    now,
    loserId,
  );
  notifyChange('place_sources');
  notifyChange('places');
}
```

Replace with:

```ts
export async function transferJunctions(
  db: Database,
  loserId: string,
  winnerId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO place_sources (
       place_id, source_id, extracted_at, raw_text, extracted_address,
       confidence, extraction_model, owner_id, created_at, updated_at
     )
     SELECT ?, source_id, extracted_at, raw_text, extracted_address,
            confidence, extraction_model, owner_id, created_at, updated_at
       FROM place_sources
      WHERE place_id = ?
     ON CONFLICT(place_id, source_id) DO NOTHING`,
    winnerId,
    loserId,
  );
  await db.runAsync(`DELETE FROM place_sources WHERE place_id = ?`, loserId);
  notifyChange('place_sources');
  notifyChange('places');
}
```

(`AND deleted_at IS NULL` filter removed from both statements; soft-delete `UPDATE` swapped for hard `DELETE`.)

- [ ] **Step 2.2: Run scoped tests**

```bash
npx jest modules/storage 2>&1 | tail -10
```

Expected: all green. `transferJunctions` callers (currently only `enrichment.ts`) still work — the enrichment merge soft-deletes the loser place _before_ calling `transferJunctions`, so the place still has its junctions during the call (now we just hard-DELETE them instead of soft-DELETE).

- [ ] **Step 2.3: Commit**

```bash
git add modules/storage/place_sources.ts
git commit -m "$(cat <<'EOF'
feat(storage): transferJunctions hard-DELETEs loser-side rows

Was: soft-delete via UPDATE deleted_at. Now: DELETE FROM place_sources.
Drops the WHERE deleted_at IS NULL filter from both INSERT-SELECT and
the loser-cleanup statement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: enrichment — resequence the collision merge

**Goal:** Change the collision-merge sequence so the loser place is hard-DELETEd _before_ the winner is promoted to its `external_place_id`. Today's order (soft-delete loser → move junctions → write enrichment) relied on the partial-by-`deleted_at` unique index. The new schema's index has no `deleted_at` predicate, so loser must be physically gone before winner takes the same `external_place_id`.

**Files:**

- Modify: `modules/enrichment/enrichment.ts:245-265`
- Modify: `modules/enrichment/__tests__/enrichment.test.ts` (existing collision tests)

- [ ] **Step 3.1: Read existing collision-merge test cases**

```bash
grep -n "collision\|merge\|external_place_id" modules/enrichment/__tests__/enrichment.test.ts | head -20
```

Use the listed line numbers to read the relevant `describe`/`it` blocks. They're the basis for the existing assertions; you'll keep them and add three new ones below.

- [ ] **Step 3.2: Add three new assertions inside the existing collision describe block**

In `modules/enrichment/__tests__/enrichment.test.ts`, find the existing describe block that covers collision-merge (search for `external_place_id` collision tests). Inside that block, add:

```ts
it('hard-deletes the loser place row entirely', async () => {
  // Set up incoming + existing collision (use whatever helper the existing
  // tests use — likely seedPlace + a stubbed enricher returning a fixed
  // external_place_id matching the existing place's id).
  const { db, incomingId, existingId } = await setupCollision();

  await runEnrichment(incomingId);

  // Whichever side won, the loser is GONE — no row, not soft-deleted.
  const surviving = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM places WHERE id IN (?, ?)`,
    incomingId,
    existingId,
  );
  expect(surviving).toHaveLength(1);
});

it('winner ends up with all junctions from both sides (deduped)', async () => {
  const { db, incomingId, existingId, sharedSourceId, otherSourceId } =
    await setupCollisionWithSharedAndUniqueSources();
  // incoming has links to sharedSourceId + otherSourceId; existing has only sharedSourceId.

  await runEnrichment(incomingId);

  const survivor = (await db.getFirstAsync<{ id: string }>(`SELECT id FROM places LIMIT 1`))!.id;
  const junctions = await db.getAllAsync<{ source_id: string }>(
    `SELECT source_id FROM place_sources WHERE place_id = ? ORDER BY source_id`,
    survivor,
  );
  expect(junctions.map((r) => r.source_id)).toEqual([sharedSourceId, otherSourceId].sort());
});

it('winner has external_place_id set; no UNIQUE violation', async () => {
  const { db, incomingId } = await setupCollision();
  await runEnrichment(incomingId);

  const survivor = await db.getFirstAsync<{ external_place_id: string | null }>(
    `SELECT external_place_id FROM places LIMIT 1`,
  );
  expect(survivor?.external_place_id).not.toBeNull();
});
```

The helpers (`setupCollision`, `setupCollisionWithSharedAndUniqueSources`, `runEnrichment`) likely already exist in the test file — reuse them. If they don't, write minimal versions following the existing test setup pattern.

- [ ] **Step 3.3: Run tests, verify the three new ones fail**

```bash
npx jest modules/enrichment 2>&1 | tail -20
```

Expected: the new tests fail. The "loser still exists as soft-deleted" assertion fires because today's code soft-deletes (row still in table). The junction-dedup test may pass or fail depending on the existing setup. The unique-no-violation test passes today — keep it as a regression guard.

- [ ] **Step 3.4: Resequence the merge in `modules/enrichment/enrichment.ts`**

Find the transaction block at lines 246-265 and replace it. Old:

```ts
const ts = getNow();
await opts.db.withTransactionAsync(async () => {
  // Order matters: soft-delete the loser FIRST so the partial UNIQUE on
  // external_place_id doesn't fire when we promote the winner. Soft-deleted
  // rows are excluded from the UNIQUE index (WHERE deleted_at IS NULL).
  await opts.db.runAsync(
    `UPDATE places SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    ts,
    ts,
    loserId,
  );

  // Move junction rows from loser → winner with PK conflict tolerance.
  await transferJunctions(opts.db, loserId, winnerId);

  // If winner is incoming (place), copy enrichment columns onto it.
  if (winnerId === place.id) {
    await writeEnrichmentColumns(place.id, outcome);
  }
});
```

New:

```ts
await opts.db.withTransactionAsync(async () => {
  // Order matters with hard-delete + non-partial UNIQUE on external_place_id:
  //   1. Re-home all loser junctions onto the winner.
  //   2. DELETE the loser place row (FK-safe now: junctions are on the winner).
  //   3. Promote winner with enrichment columns (external_place_id passes
  //      uniqueness because loser is physically gone).
  await transferJunctions(opts.db, loserId, winnerId);
  await opts.db.runAsync(`DELETE FROM places WHERE id = ?`, loserId);
  if (winnerId === place.id) {
    await writeEnrichmentColumns(place.id, outcome);
  }
});
```

(The `ts` variable used by the now-removed UPDATE is no longer needed inside the transaction; if it's not used elsewhere in this function, remove its declaration.)

- [ ] **Step 3.5: Run tests, verify pass**

```bash
npx jest modules/enrichment 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 3.6: Commit**

```bash
git add modules/enrichment/enrichment.ts modules/enrichment/__tests__/enrichment.test.ts
git commit -m "$(cat <<'EOF'
feat(enrichment): resequence collision merge for hard-delete world

Old order leaned on the partial-by-deleted-at UNIQUE on
external_place_id: soft-delete loser → move junctions → write winner.
With deleted_at on the way out and the index now non-partial, that
sequence would race the UNIQUE check.

New order: transferJunctions (which now hard-DELETEs loser-side rows),
then DELETE loser place row, then promote winner. Winner can take
external_place_id without contention because no other row holds it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: places — `softDeletePlace` → `deletePlace` with orphan-prune sources

**Goal:** Hard-DELETE the place row, hard-DELETE its junctions, and orphan-prune any source whose only junction was to this place.

**Files:**

- Modify: `modules/storage/places.ts:218-228` (softDeletePlace)
- Modify: `modules/storage/index.ts` (export rename)
- Modify: `modules/storage/__tests__/places.test.ts`
- Modify: `app/places/[id].tsx:12,142` (consumer — keep wiring identical, full UI rewrite is Task 11)

- [ ] **Step 4.1: Add `deletePlace` test cases to `modules/storage/__tests__/places.test.ts`**

Append a new describe block at the end of the file (before the final closing of the outermost block — verify with the file's structure):

```ts
import { File } from 'expo-file-system';
import { deletePlace } from '../places';
import { insertSource, getSource } from '../sources';
import { linkPlaceSource } from '../place_sources';

describe('deletePlace — hard delete + symmetric orphan prune', () => {
  const seedSource = async (db: Database, id: string): Promise<void> => {
    const now = '2026-05-10T10:00:00Z';
    await insertSource(db, {
      id,
      tripId: null,
      filePath: `/x/${id}.jpg`,
      contentHash: `h-${id}`,
      origin: 'manual',
      capturedAt: now,
      ownerId,
    });
  };
  const link = async (db: Database, placeId: string, sourceId: string): Promise<void> => {
    await linkPlaceSource(db, {
      placeId,
      sourceId,
      extractionModel: 'gemini',
      ownerId,
    });
  };

  it('removes the place row and its junctions', async () => {
    const db = await freshDb();
    await seedSource(db, 's1');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 's1');

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    const place = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'p1'`);
    expect(place).toBeNull();
    const junctions = await db.getAllAsync(
      `SELECT source_id FROM place_sources WHERE place_id = 'p1'`,
    );
    expect(junctions).toEqual([]);
  });

  it('orphan-prunes a source whose only junction was to this place', async () => {
    const db = await freshDb();
    const deletedFiles: string[] = [];
    await seedSource(db, 'sOnlyHere');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 'sOnlyHere');

    await deletePlace(db, 'p1', {
      unlinkFile: (p) => deletedFiles.push(p),
    });

    expect(await getSource(db, 'sOnlyHere')).toBeNull();
    expect(deletedFiles).toEqual(['/x/sOnlyHere.jpg']);
  });

  it('preserves a source that has another live place', async () => {
    const db = await freshDb();
    await seedSource(db, 'sShared');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await seedPlace(db, 'p2', 'B', 'Tokyo', null);
    await link(db, 'p1', 'sShared');
    await link(db, 'p2', 'sShared');

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    expect(await getSource(db, 'sShared')).toBeTruthy();
    const remaining = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM place_sources WHERE source_id = 'sShared'`,
    );
    expect(remaining.map((r) => r.place_id)).toEqual(['p2']);
  });

  it('handles a place with two sources, each only-linked here, by deleting both', async () => {
    const db = await freshDb();
    const deletedFiles: string[] = [];
    await seedSource(db, 's1');
    await seedSource(db, 's2');
    await seedPlace(db, 'p1', 'A', 'Tokyo', null);
    await link(db, 'p1', 's1');
    await link(db, 'p1', 's2');

    await deletePlace(db, 'p1', {
      unlinkFile: (p) => deletedFiles.push(p),
    });

    expect(await getSource(db, 's1')).toBeNull();
    expect(await getSource(db, 's2')).toBeNull();
    expect(deletedFiles.sort()).toEqual(['/x/s1.jpg', '/x/s2.jpg']);
  });
});
```

Also: in the existing `countPlacesByTrip` test at line 227-237 (the "excludes soft-deleted places" case), since soft-delete no longer exists, change the assertion: instead of `softDeletePlace(db, 'p2')` followed by `expect(counts).toEqual({ t1: 1 })`, rewrite as `deletePlace(db, 'p2', { unlinkFile: () => {} })` and keep the same assertion (deletePlace removes p2 entirely, count drops). Update the import at the top of the file from `softDeletePlace` to `deletePlace`.

Also: the existing `movePlaceToTrip` test at line 172-198 ("skips soft-deleted junctions when picking sources to move") simulates a soft-deleted junction. Rewrite to simulate via `DELETE FROM place_sources` instead of `UPDATE place_sources SET deleted_at`:

Find:

```ts
await db.runAsync(
  `UPDATE place_sources SET deleted_at = ? WHERE place_id = ? AND source_id = ?`,
  '2026-05-08T11:00:00Z',
  'p1',
  's-detached',
);
```

Replace with:

```ts
await db.runAsync(
  `DELETE FROM place_sources WHERE place_id = ? AND source_id = ?`,
  'p1',
  's-detached',
);
```

Rename the test description from `'skips soft-deleted junctions when picking sources to move'` to `'skips already-deleted junctions when picking sources to move'`.

- [ ] **Step 4.2: Run tests, verify they fail**

```bash
npx jest modules/storage/__tests__/places.test.ts 2>&1 | tail -20
```

Expected: new `deletePlace` tests fail (`deletePlace is not a function`). Existing tests pass.

- [ ] **Step 4.3: Replace `softDeletePlace` in `modules/storage/places.ts`**

Find lines 218-228:

```ts
export async function softDeletePlace(db: Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(`UPDATE places SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
  notifyChange('places');
  notifyChange('trips');
}
```

Replace with:

```ts
export type DeletePlaceOptions = {
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    console.warn('[deletePlace] unlink failed', path, err);
  }
};

export async function deletePlace(
  db: Database,
  id: string,
  opts: DeletePlaceOptions = {},
): Promise<void> {
  const unlink = opts.unlinkFile ?? defaultUnlink;
  const filesToUnlink: string[] = [];

  await db.withTransactionAsync(async () => {
    const sourceRows = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM place_sources WHERE place_id = ?`,
      id,
    );
    const affectedSourceIds = sourceRows.map((r) => r.source_id);

    await db.runAsync(`DELETE FROM place_sources WHERE place_id = ?`, id);
    await db.runAsync(`DELETE FROM places WHERE id = ?`, id);

    for (const sourceId of affectedSourceIds) {
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources WHERE source_id = ?`,
        sourceId,
      );
      if ((remaining?.n ?? 0) === 0) {
        const fileRow = await db.getFirstAsync<{ file_path: string | null }>(
          `SELECT file_path FROM sources WHERE id = ?`,
          sourceId,
        );
        await db.runAsync(`DELETE FROM tags WHERE source_id = ?`, sourceId);
        await db.runAsync(`DELETE FROM sources WHERE id = ?`, sourceId);
        if (fileRow?.file_path) filesToUnlink.push(fileRow.file_path);
      }
    }
  });

  for (const path of filesToUnlink) unlink(path);

  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('sources');
  notifyChange('trips');
}
```

- [ ] **Step 4.4: Update `modules/storage/index.ts`**

Replace `softDeletePlace,` (line 25) with `deletePlace,` and add the type export:

```ts
export {
  insertPlace,
  getPlace,
  listPlaces,
  movePlaceToTrip,
  deletePlace,
  applyEnrichment,
  setEnrichmentStatus,
  findSoleMatchByNormalizedKey,
  findCollidingByExternalId,
  countPlacesByTrip,
  normalizePlaceKey,
  type Place,
  type EnrichmentStatus,
  type EnrichmentColumns,
  type InsertPlaceInput,
  type DeletePlaceOptions,
} from './places';
```

- [ ] **Step 4.5: Update consumer in `app/places/[id].tsx`**

Find line 12 (`softDeletePlace,`) and line 142 (`await softDeletePlace(db, place.id);`). Replace `softDeletePlace` with `deletePlace` in both spots. (The orphan-prune-aware Alert copy is added in Task 11.)

- [ ] **Step 4.6: Run tests, verify pass**

```bash
npx jest modules/storage 2>&1 | tail -10
npx tsc --noEmit 2>&1 | head -10
```

Expected: all green.

- [ ] **Step 4.7: Commit**

```bash
git add modules/storage/places.ts modules/storage/index.ts \
        modules/storage/__tests__/places.test.ts \
        app/places/[id].tsx
git commit -m "$(cat <<'EOF'
feat(storage): replace softDeletePlace with deletePlace + orphan-prune sources

deletePlace hard-DELETEs the place + its junctions. For each affected
source: if its junction count drops to zero, the source row + tags + file
are also removed. Mirrors deleteSource's symmetric prune (Task 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: sources — `softDeleteSource` → `deleteSource` with file unlink + tags + orphan-prune places

**Goal:** Hard-DELETE the source row, the file, the tags, and the junctions; orphan-prune any place whose only junction was to this source.

**Files:**

- Modify: `modules/storage/sources.ts:246-256` (softDeleteSource)
- Modify: `modules/storage/index.ts` (export rename)
- Modify: `modules/storage/__tests__/sources.test.ts`
- Modify: `app/sources/[id].tsx:8,114` (consumer — keep wiring identical)
- Modify: `components/PlaceGrid.tsx:5,51` (consumer — keep wiring identical)

- [ ] **Step 5.1: Update existing `softDeleteSource` tests in `modules/storage/__tests__/sources.test.ts`**

In the file, find:

- Line 9: `softDeleteSource,` import — change to `deleteSource,`.
- Line 86 (inside a test that simulates soft-deletion): `'UPDATE sources SET deleted_at = ? WHERE id = ?'` — replace with `'DELETE FROM sources WHERE id = ?'` and remove the `'2026-05-10T11:00:00Z'` arg.
- Line 148: same pattern as 86 — replace UPDATE-deleted-at with DELETE FROM sources.
- Line 243-261 (the `softDeleteSource sets deleted_at` test): replace entirely with:

```ts
it('deleteSource removes the row, junctions, tags, and the file', async () => {
  const db = await freshDb();
  const deletedFiles: string[] = [];
  await insertSource(db, {
    id: 'a',
    tripId: null,
    filePath: '/x/a.jpg',
    contentHash: 'h-a',
    origin: 'manual',
    capturedAt: '2026-05-04T10:00:00Z',
    ownerId,
  });
  await deleteSource(db, 'a', {
    unlinkFile: (p) => deletedFiles.push(p),
  });
  const row = await db.getFirstAsync(`SELECT id FROM sources WHERE id = 'a'`);
  expect(row).toBeNull();
  expect(await listInboxSources(db)).toEqual([]);
  expect(deletedFiles).toEqual(['/x/a.jpg']);
});
```

- Line 293 (existing test that uses `softDeleteSource`): change `await softDeleteSource(db, 'c');` → `await deleteSource(db, 'c', { unlinkFile: () => {} });`. Same at line 386.

- [ ] **Step 5.2: Add new orphan-prune tests at the end of the `describe('sources repository', ...)` block (before its closing brace)**

```ts
describe('deleteSource — orphan-prune places', () => {
  const seedPlace = async (db: Database, placeId: string, tripId: string | null): Promise<void> => {
    const now = '2026-05-10T10:00:00Z';
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, city, normalized_key,
                           enrichment_status, owner_id, created_at, updated_at)
       VALUES (?, ?, 'Place ' || ?, 'Tokyo', 'p-' || ?, 'pending', ?, ?, ?)`,
      placeId,
      tripId,
      placeId,
      placeId,
      ownerId,
      now,
      now,
    );
  };
  const link = async (db: Database, placeId: string, sourceId: string): Promise<void> => {
    await linkPlaceSource(db, {
      placeId,
      sourceId,
      extractionModel: 'gemini',
      ownerId,
    });
  };

  it('orphan-prunes a place whose only source was this one', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 's1',
      tripId: null,
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-10T10:00:00Z',
      ownerId,
    });
    await seedPlace(db, 'pOnlyHere', null);
    await link(db, 'pOnlyHere', 's1');

    await deleteSource(db, 's1', { unlinkFile: () => {} });

    const place = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'pOnlyHere'`);
    expect(place).toBeNull();
  });

  it('preserves a place that has another live source', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 's1',
      tripId: null,
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-10T10:00:00Z',
      ownerId,
    });
    await insertSource(db, {
      id: 's2',
      tripId: null,
      filePath: '/x/s2.jpg',
      contentHash: 'h-s2',
      origin: 'manual',
      capturedAt: '2026-05-10T10:00:01Z',
      ownerId,
    });
    await seedPlace(db, 'pShared', null);
    await link(db, 'pShared', 's1');
    await link(db, 'pShared', 's2');

    await deleteSource(db, 's1', { unlinkFile: () => {} });

    const place = await db.getFirstAsync(`SELECT id FROM places WHERE id = 'pShared'`);
    expect(place).toBeTruthy();
  });

  it('removes tags attached to the deleted source', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 's1',
      tripId: null,
      filePath: '/x/s1.jpg',
      contentHash: 'h-s1',
      origin: 'manual',
      capturedAt: '2026-05-10T10:00:00Z',
      ownerId,
    });
    await db.runAsync(
      `INSERT INTO tags (id, source_id, kind, value, owner_id, created_at, updated_at)
       VALUES ('tag1', 's1', 'food', 'sushi', ?, ?, ?)`,
      ownerId,
      '2026-05-10T10:00:00Z',
      '2026-05-10T10:00:00Z',
    );

    await deleteSource(db, 's1', { unlinkFile: () => {} });

    const tag = await db.getFirstAsync(`SELECT id FROM tags WHERE id = 'tag1'`);
    expect(tag).toBeNull();
  });
});
```

Make sure `linkPlaceSource` is imported at the top of the file (add `import { linkPlaceSource } from '../place_sources';` if missing).

- [ ] **Step 5.3: Update assignSourceTrip with excludePlaceIds tests (lines 442-548)**

These tests assert `deleted_at IS NOT NULL` on junction / place rows. Once the schema and function move to hard-DELETE, the assertion changes from "deleted_at not null" to "row not found". Replace each assertion in this describe block:

For example, line 449-460 becomes:

```ts
const link = await db.getFirstAsync<{ source_id: string }>(
  `SELECT source_id FROM place_sources WHERE source_id = 's1' AND place_id = 'p1'`,
);
expect(link).toBeNull();
const place = await db.getFirstAsync<{ trip_id: string | null }>(
  `SELECT trip_id FROM places WHERE id = 'p1'`,
);
expect(place).toBeNull(); // place was orphan-pruned
```

For the second test (line 462-483, "breaks only the link..."):

```ts
const linkA = await db.getFirstAsync(
  `SELECT source_id FROM place_sources WHERE source_id = 'sA' AND place_id = 'p1'`,
);
const linkB = await db.getFirstAsync(
  `SELECT source_id FROM place_sources WHERE source_id = 'sB' AND place_id = 'p1'`,
);
expect(linkA).toBeNull();
expect(linkB).toBeTruthy();
const place = await db.getFirstAsync<{ trip_id: string | null }>(
  `SELECT trip_id FROM places WHERE id = 'p1'`,
);
expect(place?.trip_id).toBeNull(); // place still alive, still untriaged
```

Apply the same pattern to the remaining tests in this describe block — every `not.toBeNull()` on `deleted_at` becomes `expect(row).toBeNull()` (row gone), and every `toBeNull()` on `deleted_at` becomes `expect(row).toBeTruthy()` (row alive).

For the "notifies places subscribers on a delete-only path" test at line 525-548, the inline `useLiveQuery` SQL on line 537 reads `'SELECT COUNT(*) AS n FROM places WHERE deleted_at IS NULL'` — change to `'SELECT COUNT(*) AS n FROM places'`. Similarly the inbox/trip hook queries on lines 567 and 574.

- [ ] **Step 5.4: Run tests, verify they fail in expected ways**

```bash
npx jest modules/storage/__tests__/sources.test.ts 2>&1 | tail -30
```

Expected: tests fail because `deleteSource` is not a function and because the inline-deleted-at simulations have been swapped for hard-DELETEs that the still-extant `softDeleteSource` doesn't expose.

- [ ] **Step 5.5: Replace `softDeleteSource` in `modules/storage/sources.ts`**

Find lines 246-256:

```ts
export async function softDeleteSource(db: Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(`UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
  notifyChange('sources');
  notifyChange('trips');
}
```

Replace with:

```ts
export type DeleteSourceOptions = {
  unlinkFile?: (path: string) => void;
};

const defaultUnlink = (path: string): void => {
  try {
    new (require('expo-file-system').File)(path).delete();
  } catch (err) {
    console.warn('[deleteSource] unlink failed', path, err);
  }
};

export async function deleteSource(
  db: Database,
  id: string,
  opts: DeleteSourceOptions = {},
): Promise<void> {
  const unlink = opts.unlinkFile ?? defaultUnlink;
  let filePath: string | null = null;

  await db.withTransactionAsync(async () => {
    const placeRows = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM place_sources WHERE source_id = ?`,
      id,
    );
    const affectedPlaceIds = placeRows.map((r) => r.place_id);

    const fileRow = await db.getFirstAsync<{ file_path: string | null }>(
      `SELECT file_path FROM sources WHERE id = ?`,
      id,
    );
    filePath = fileRow?.file_path ?? null;

    await db.runAsync(`DELETE FROM tags WHERE source_id = ?`, id);
    await db.runAsync(`DELETE FROM place_sources WHERE source_id = ?`, id);
    await db.runAsync(`DELETE FROM sources WHERE id = ?`, id);

    for (const placeId of affectedPlaceIds) {
      const remaining = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM place_sources WHERE place_id = ?`,
        placeId,
      );
      if ((remaining?.n ?? 0) === 0) {
        await db.runAsync(`DELETE FROM places WHERE id = ?`, placeId);
      }
    }
  });

  if (filePath) unlink(filePath);

  notifyChange('sources');
  notifyChange('place_sources');
  notifyChange('places');
  notifyChange('trips');
}
```

- [ ] **Step 5.6: Update `modules/storage/index.ts`**

Replace `softDeleteSource,` (line 12) with `deleteSource,` and add the type export:

```ts
export {
  insertSource,
  getSource,
  listSources,
  listAllSources,
  listInboxSources,
  listSourcesByTrip,
  assignSourceTrip,
  deleteSource,
  countSourcesByTrip,
  type Source,
  type SourceKind,
  type SourceOrigin,
  type ProcessingStatus,
  type InsertSourceInput,
  type DeleteSourceOptions,
} from './sources';
```

- [ ] **Step 5.7: Update consumers**

In `app/sources/[id].tsx`:

- Line 8: `softDeleteSource,` → `deleteSource,`.
- Line 114: `await softDeleteSource(db, source.id);` → `await deleteSource(db, source.id);`.

In `components/PlaceGrid.tsx`:

- Line 5: `import { softDeleteSource } from '@/modules/storage';` → `import { deleteSource } from '@/modules/storage';`.
- Line 51: `await softDeleteSource(db, id);` → `await deleteSource(db, id);`.

- [ ] **Step 5.8: Run tests**

```bash
npx jest modules/storage 2>&1 | tail -10
npx tsc --noEmit 2>&1 | head -10
```

Expected: all green.

- [ ] **Step 5.9: Commit**

```bash
git add modules/storage/sources.ts modules/storage/index.ts \
        modules/storage/__tests__/sources.test.ts \
        app/sources/[id].tsx components/PlaceGrid.tsx
git commit -m "$(cat <<'EOF'
feat(storage): replace softDeleteSource with deleteSource

deleteSource hard-DELETEs the source row, its file, tags, and junctions.
For each affected place: if its junction count drops to zero, the place
row is removed too — symmetric prune with deletePlace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: assignSourceTrip — soft → hard delete on junction/place rows

**Goal:** The `excludePlaceIds` path inside `assignSourceTrip` (sources.ts:191-217) currently soft-deletes both the junction and (when the place is orphaned and untriaged) the place row. Swap both to hard-DELETE. The carve-out documented in spec §3.5 — "do not source-prune the source being assigned" — is preserved automatically: this function never inspects the source side's junction count.

**Files:**

- Modify: `modules/storage/sources.ts:183-244`

- [ ] **Step 6.1: Edit `modules/storage/sources.ts`**

Find the inner soft-delete in the `for (const placeId of excludeIds)` loop (lines 192-216):

```ts
for (const placeId of excludeIds) {
  await db.runAsync(
    `UPDATE place_sources
        SET deleted_at = ?, updated_at = ?
      WHERE source_id = ? AND place_id = ? AND deleted_at IS NULL`,
    now,
    now,
    sourceId,
    placeId,
  );
  const remaining = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources
      WHERE place_id = ? AND deleted_at IS NULL`,
    placeId,
  );
  if ((remaining?.n ?? 0) === 0) {
    const result = await db.runAsync(
      `UPDATE places
          SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND trip_id IS NULL AND deleted_at IS NULL`,
      now,
      now,
      placeId,
    );
    if (result.changes > 0) deletedPlaces = true;
  }
}
```

Replace with:

```ts
for (const placeId of excludeIds) {
  await db.runAsync(
    `DELETE FROM place_sources WHERE source_id = ? AND place_id = ?`,
    sourceId,
    placeId,
  );
  const remaining = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources WHERE place_id = ?`,
    placeId,
  );
  if ((remaining?.n ?? 0) === 0) {
    const result = await db.runAsync(
      `DELETE FROM places WHERE id = ? AND trip_id IS NULL`,
      placeId,
    );
    if (result.changes > 0) deletedPlaces = true;
  }
}
```

Also, in the cascade UPDATE that pulls untriaged places into the trip (lines 224-239), drop the `AND deleted_at IS NULL` filters from both the `places` and `place_sources` clauses:

```ts
// Replace:
`UPDATE places
    SET trip_id = ?, updated_at = ?
  WHERE trip_id IS NULL
    AND deleted_at IS NULL
    AND id IN (
      SELECT place_id FROM place_sources
       WHERE source_id = ? AND deleted_at IS NULL
    )`
// With:
`UPDATE places
    SET trip_id = ?, updated_at = ?
  WHERE trip_id IS NULL
    AND id IN (
      SELECT place_id FROM place_sources
       WHERE source_id = ?
    )`;
```

- [ ] **Step 6.2: Run tests**

```bash
npx jest modules/storage/__tests__/sources.test.ts 2>&1 | tail -15
```

Expected: green. The test changes from Step 5.3 (which assert row-not-found instead of `deleted_at` not null) match the new behaviour.

- [ ] **Step 6.3: Commit**

```bash
git add modules/storage/sources.ts
git commit -m "$(cat <<'EOF'
feat(storage): assignSourceTrip junction/place soft-delete → hard-delete

Triage's deselect-to-drop path now DELETEs the junction (and the
orphaned place, when applicable) instead of UPDATE deleted_at. Drops
deleted_at filters from the cascade-pull-into-trip UPDATE.

Carve-out from spec §3.5 preserved automatically: this function never
inspects source-side junction counts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: cleanupOrphans — hard-delete orphan sources + dependent test updates

**Goal:** `cleanupOrphans` currently soft-deletes orphan sources (sources whose file disappeared). Switch to hard-DELETE via `deleteSource` so orphan-prune and file consistency are handled automatically.

**Files:**

- Modify: `modules/capture/cleanupOrphans.ts:33-41`
- Modify: `modules/capture/__tests__/cleanupOrphans.test.ts:61` (simulate orphan via DELETE not UPDATE deleted_at)
- Modify: `modules/processing/__tests__/processing.test.ts:293`
- Modify: `modules/extraction/__tests__/extraction.test.ts:675`

- [ ] **Step 7.1: Update `modules/capture/cleanupOrphans.ts`**

Find lines 30-44:

```ts
const orphans = rows.filter((r) => !fileExists(r.file_path));
if (orphans.length === 0) return 0;

const now = new Date().toISOString();
for (const row of orphans) {
  await db.runAsync(
    `UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    row.id,
  );
}
notifyChange('sources');
notifyChange('trips');
return orphans.length;
```

Replace with:

```ts
const orphans = rows.filter((r) => !fileExists(r.file_path));
if (orphans.length === 0) return 0;

for (const row of orphans) {
  // The file is already gone (we just confirmed that), so suppress the
  // file-unlink path inside deleteSource.
  await deleteSource(db, row.id, { unlinkFile: () => {} });
}
return orphans.length;
```

Add `import { deleteSource } from '@/modules/storage';` at the top of the file. Remove the `import { notifyChange } from '@/modules/storage/live-query';` line (no longer needed — `deleteSource` handles notification).

Also: remove the `WHERE deleted_at IS NULL` filter from the SELECT at line 27:

```ts
// Replace:
const rows = await db.getAllAsync<{ id: string; file_path: string }>(
  `SELECT id, file_path FROM sources
    WHERE deleted_at IS NULL AND file_path IS NOT NULL`,
);
// With:
const rows = await db.getAllAsync<{ id: string; file_path: string }>(
  `SELECT id, file_path FROM sources WHERE file_path IS NOT NULL`,
);
```

- [ ] **Step 7.2: Update `modules/capture/__tests__/cleanupOrphans.test.ts`**

Find the test that uses `UPDATE sources SET deleted_at = ?` (line 61) — that test simulates a _previously_ orphaned source and verifies the worker is idempotent. With hard-delete, "previously soft-deleted" doesn't exist; rewrite the test to simulate the source already being hard-deleted (no row to start with).

Find:

```ts
await db.runAsync(
  `UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ?`,
  '2026-05-04T11:00:00Z',
  '2026-05-04T11:00:00Z',
  's1',
);
```

Replace the surrounding test (whichever it is — find its describe/it block) so that, instead of soft-deleting `s1` then running cleanup, the test asserts that running cleanup twice in a row produces 0 deletions on the second pass. Concretely:

```ts
it('is idempotent on the second pass', async () => {
  const db = await freshDb();
  await insertSource(db, {
    id: 's1',
    tripId: null,
    filePath: '/x/s1.jpg',
    contentHash: 'h-s1',
    origin: 'manual',
    capturedAt: '2026-05-10T10:00:00Z',
    ownerId,
  });
  // First sweep removes the orphan.
  const first = await cleanupOrphanSources(db, { fileExists: () => false });
  expect(first).toBe(1);
  // Second sweep finds nothing.
  const second = await cleanupOrphanSources(db, { fileExists: () => false });
  expect(second).toBe(0);
});
```

(Adapt the imports / `freshDb` / `ownerId` setup to match the existing test file's structure.)

Also update any other test in this file that reads `WHERE deleted_at IS NULL` from sources — change to no filter.

- [ ] **Step 7.3: Update `modules/processing/__tests__/processing.test.ts:293`**

Find the line:

```ts
await db.runAsync(`UPDATE sources SET deleted_at = ? WHERE id = ?`, '2026-05-07T11:00:00Z', 'f1');
```

Replace with:

```ts
await db.runAsync(`DELETE FROM sources WHERE id = ?`, 'f1');
```

If the surrounding test asserts that processing skips the soft-deleted source, the assertion still holds against a hard-deleted (gone) source.

- [ ] **Step 7.4: Update `modules/extraction/__tests__/extraction.test.ts:675`**

Find:

```ts
await db.runAsync(`UPDATE sources SET deleted_at = ? WHERE id = 's1'`, NOW);
```

Replace with:

```ts
await db.runAsync(`DELETE FROM sources WHERE id = 's1'`);
```

Same reasoning.

- [ ] **Step 7.5: Run tests**

```bash
npm test --silent 2>&1 | tail -20
```

Expected: full suite green. All the dependent test files now exercise hard-delete; cleanupOrphans uses deleteSource under the hood.

- [ ] **Step 7.6: Commit**

```bash
git add modules/capture/cleanupOrphans.ts \
        modules/capture/__tests__/cleanupOrphans.test.ts \
        modules/processing/__tests__/processing.test.ts \
        modules/extraction/__tests__/extraction.test.ts
git commit -m "$(cat <<'EOF'
feat(capture): cleanupOrphans uses deleteSource (hard-delete)

Was: UPDATE sources SET deleted_at on rows whose file is missing. Now:
deleteSource with unlinkFile suppressed (file already gone). Drops the
deleted_at IS NULL filter on the candidate SELECT.

Updates dependent tests in processing and extraction modules that were
simulating soft-deleted sources via inline UPDATE-deleted_at to use
plain DELETE FROM instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Schema rewrite + remove all `WHERE deleted_at IS NULL` filters

**Goal:** Edit `0001_init.ts` in place to drop the `deleted_at` column from five tables, the `deleted_at` predicates from eight indexes, and all `deleted_at` mentions from nine FTS triggers. Drop every remaining `WHERE deleted_at IS NULL` filter from storage internal queries, app inline SQL, and component inline SQL. Add schema-shape assertions to `db.test.ts`.

**Pre-flight:** Wipe the simulator app or remove `trip-pocket.db` from the simulator sandbox before running the app after this task. The runner skips already-applied migrations, so the in-place edit only takes effect on a fresh DB.

**Files:**

- Modify: `modules/storage/migrations/0001_init.ts` (whole file)
- Modify: `modules/storage/__tests__/db.test.ts` (add schema-shape assertions)
- Modify: every storage / app / component file with a `WHERE deleted_at IS NULL` clause (24 occurrences)

- [ ] **Step 8.1: Edit `modules/storage/migrations/0001_init.ts`**

Five table definitions: remove the `deleted_at TEXT` column line from `trips`, `sources`, `places`, `place_sources`, `tags`. Eight indexes: remove `WHERE deleted_at IS NULL` from each (keep the `WHERE external_place_id IS NOT NULL` half on `idx_places_external_place_id` and the `WHERE enrichment_status = 'pending'` half on `idx_places_enrichment_pending`). Nine triggers: remove the `WHEN NEW.deleted_at IS NULL` clauses, drop `deleted_at` from each `AFTER UPDATE OF (...)` column list, drop `WHERE deleted_at IS NULL` from every inner sub-query.

The full new file:

```ts
import type { Migration } from '../db';

// Single, fresh schema. The places-first restructure (see
// docs/superpowers/specs/2026-05-08-places-first-restructure-design.md)
// landed before any users existed, so we collapsed every prior migration
// into one init instead of carrying old shapes forward. Anyone with a
// pre-restructure dev DB needs to delete it (`trip-pocket.db` in the
// simulator app sandbox).
//
// Soft-delete column removed (see
// docs/superpowers/specs/2026-05-10-delete-cascade-design.md). Delete is
// hard. Devs with a pre-2026-05-10 dev DB also need to wipe.
//
// Tables, in dependency order:
//   trips, sources, places, place_sources, tags, pending_imports, meta
//
// FTS:
//   places_fts  — name + city + description + concatenated raw_text
//                 (capped 2KB per source) + extracted_address.
//   sources_fts — ocr_text + parent trip name + tag values.
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
        updated_at  TEXT NOT NULL
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
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sources_trip
        ON sources(trip_id);
      CREATE INDEX IF NOT EXISTS idx_sources_captured_at
        ON sources(captured_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_hash
        ON sources(content_hash);

      CREATE TABLE IF NOT EXISTS places (
        id                 TEXT PRIMARY KEY NOT NULL,
        trip_id            TEXT,
        name               TEXT NOT NULL,
        city               TEXT,
        category           TEXT,
        normalized_key     TEXT NOT NULL,

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
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      CREATE INDEX IF NOT EXISTS idx_places_normalized_key
        ON places(normalized_key, owner_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_places_external_place_id
        ON places(external_place_id, owner_id)
        WHERE external_place_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_places_trip
        ON places(trip_id);

      CREATE INDEX IF NOT EXISTS idx_places_enrichment_pending
        ON places(enrichment_status)
        WHERE enrichment_status = 'pending';

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
        PRIMARY KEY (place_id, source_id),
        FOREIGN KEY (place_id)  REFERENCES places(id),
        FOREIGN KEY (source_id) REFERENCES sources(id)
      );

      CREATE INDEX IF NOT EXISTS idx_place_sources_source
        ON place_sources(source_id);

      CREATE TABLE IF NOT EXISTS tags (
        id            TEXT PRIMARY KEY NOT NULL,
        source_id     TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('place','food','activity')),
        value         TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
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
      BEGIN
        INSERT INTO places_fts (place_id, content) VALUES (
          NEW.id,
          NEW.name || ' ' || coalesce(NEW.city, '') || ' ' || coalesce(NEW.description, '')
        );
      END;

      CREATE TRIGGER IF NOT EXISTS places_fts_au
      AFTER UPDATE OF name, city, description ON places
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.id;
        INSERT INTO places_fts (place_id, content)
          SELECT NEW.id,
                 NEW.name || ' ' || coalesce(NEW.city, '') || ' ' || coalesce(NEW.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = NEW.id), '');
      END;

      CREATE TRIGGER IF NOT EXISTS places_fts_ad
      AFTER DELETE ON places
      BEGIN
        DELETE FROM places_fts WHERE place_id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS place_sources_fts_ai
      AFTER INSERT ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = NEW.place_id;
      END;

      CREATE TRIGGER IF NOT EXISTS place_sources_fts_au
      AFTER UPDATE OF raw_text, extracted_address ON place_sources
      BEGIN
        DELETE FROM places_fts WHERE place_id = NEW.place_id;
        INSERT INTO places_fts (place_id, content)
          SELECT p.id,
                 p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.description, '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(substr(coalesce(raw_text, ''), 1, 2000), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = NEW.place_id;
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
                            WHERE place_id = p.id), '') ||
                 coalesce((SELECT ' ' || GROUP_CONCAT(coalesce(extracted_address, ''), ' ')
                             FROM place_sources
                            WHERE place_id = p.id), '')
            FROM places p
           WHERE p.id = OLD.place_id;
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
        source_id UNINDEXED,
        content,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS sources_fts_ai
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

      CREATE TRIGGER IF NOT EXISTS sources_fts_au
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

      CREATE TRIGGER IF NOT EXISTS sources_fts_ad
      AFTER DELETE ON sources
      BEGIN
        DELETE FROM sources_fts WHERE source_id = OLD.id;
      END;
    `);
  },
};
```

- [ ] **Step 8.2: Drop `WHERE deleted_at IS NULL` from storage internal queries**

Use these exact path:line references. For each, delete the `AND deleted_at IS NULL` (or `WHERE deleted_at IS NULL`) clause from the SQL string.

In `modules/storage/places.ts`:

- Line 131 (`getPlace`): `WHERE id = ? AND deleted_at IS NULL` → `WHERE id = ?`.
- Line 148 (`findSoleMatchByNormalizedKey`): drop `AND deleted_at IS NULL`.
- Line 164 (`listPlaces` filter branch): drop `WHERE deleted_at IS NULL AND` (keep the parenthesised tripId clause).
- Line 173 (`listPlaces` no-filter): drop `WHERE deleted_at IS NULL ` and bring `ORDER BY` straight after `places`.
- Line 187 (`movePlaceToTrip`): drop `AND deleted_at IS NULL`.
- Line 201 (`movePlaceToTrip` cascade UPDATE): drop both `AND deleted_at IS NULL` clauses (outer and inner).
- Line 302 (`findCollidingByExternalId`): drop `AND deleted_at IS NULL`.
- Line 315 (`countPlacesByTrip`): drop `AND deleted_at IS NULL` (keep the rest).

In `modules/storage/sources.ts`:

- Line 100 (`getSource`): drop `AND deleted_at IS NULL`.
- Line 113 (`listSources`): drop `WHERE deleted_at IS NULL AND` (keep the tripId predicate).
- Line 124 (`listAllSources`): drop `WHERE deleted_at IS NULL ` (keep the ORDER BY).
- Line 133 (`listInboxSources`): drop `WHERE deleted_at IS NULL AND` (keep `trip_id IS NULL`).
- Line 146 (`listSourcesByTrip`): drop `WHERE deleted_at IS NULL AND` (keep `trip_id = ?`).
- Line 262 (`countSourcesByTrip`): drop `WHERE deleted_at IS NULL AND` (keep `trip_id IS NOT NULL`).

In `modules/storage/trips.ts`:

- Line 65 (`listTrips`): drop `WHERE deleted_at IS NULL` (keep `ORDER BY`).
- Line 75 (`getTrip`): drop `AND deleted_at IS NULL`.

In `modules/storage/place_sources.ts`:

- Line 98 (`listSourcesForPlace`): drop `AND deleted_at IS NULL`.
- Line 112 (`listPlacesForSource`): drop `AND deleted_at IS NULL`.
- Line 136 (`transferJunctions` SELECT — already removed in Task 2). Verify.
- Line 146 (`transferJunctions` DELETE — already changed in Task 2). Verify.
- Line 160 (`countLiveSourcesForPlace`): drop `AND deleted_at IS NULL`.

- [ ] **Step 8.3: Drop `WHERE deleted_at IS NULL` from app/ and components/**

Run:

```bash
grep -rn "deleted_at IS NULL" app components --include="*.ts" --include="*.tsx"
```

Expected: 24 occurrences across the files listed below. Edit each, removing the `AND deleted_at IS NULL` (or `WHERE deleted_at IS NULL`) clause:

- `app/(tabs)/(places)/index.tsx`: `PLACES_SQL` (line ~28), `INBOX_COUNT_SQL` (line ~37), `TRIPS_SQL` (line ~46).
- `app/(tabs)/(search)/index.tsx`: `SEARCH_SQL`, `TRIPS_SQL`.
- `app/(tabs)/(trips)/index.tsx`: `COUNT_SQL`, `PREVIEWS_SQL`.
- `app/triage.tsx`: `EXTRACTED_SQL`.
- `app/trips/[id].tsx`: `TRIP_SOURCES_SQL`, `TRIP_PLACES_SQL`.
- `app/trips/[id]/edit.tsx:31`: `WHERE trip_id = ? AND deleted_at IS NULL` → `WHERE trip_id = ?`.
- `app/sources/[id].tsx`: inline place-count query and any other `deleted_at` mentions.
- `app/sources/[id]/places-found.tsx`: `PLACES_SQL`, `STATUS_SQL`.
- `app/places/[id].tsx`: sources-strip query (`ps.deleted_at IS NULL AND s.deleted_at IS NULL` → just remove both).

For each: search the file for `deleted_at`, edit out the filter clause. Verify the surrounding `WHERE` / `AND` syntax stays valid.

- [ ] **Step 8.4: Final grep for stragglers**

```bash
grep -rn "deleted_at" --include="*.ts" --include="*.tsx" \
  app components modules \
  | grep -v node_modules \
  | grep -v 'docs/' \
  || echo "OK: no remaining deleted_at references"
```

Expected: `OK: no remaining deleted_at references`. If anything turns up, edit it. (Spec / plan markdown matches are fine — the grep above excludes `docs/`.)

- [ ] **Step 8.5: Add schema-shape assertions to `modules/storage/__tests__/db.test.ts`**

Append a new describe block:

```ts
describe('schema shape — post-soft-delete-removal', () => {
  it('no table has a deleted_at column', async () => {
    const db = await freshDb();
    for (const table of ['trips', 'sources', 'places', 'place_sources', 'tags']) {
      const cols = await db.getAllAsync<{ name: string }>(
        `SELECT name FROM pragma_table_info(?)`,
        table,
      );
      expect(cols.find((c) => c.name === 'deleted_at')).toBeUndefined();
    }
  });

  it('no index SQL mentions deleted_at', async () => {
    const db = await freshDb();
    const indexes = await db.getAllAsync<{ name: string; sql: string | null }>(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL`,
    );
    for (const ix of indexes) {
      expect(ix.sql).not.toMatch(/deleted_at/);
    }
  });

  it('FTS triggers populate places_fts on INSERT and rebuild on UPDATE OF name', async () => {
    const db = await freshDb();
    const ownerId = 'o1';
    await db.runAsync(
      `INSERT INTO places (id, trip_id, name, city, normalized_key,
                           enrichment_status, owner_id, created_at, updated_at)
       VALUES ('p1', NULL, 'Sushi Bar', 'Tokyo', 'sushi-bar|tokyo',
               'pending', ?, ?, ?)`,
      ownerId,
      '2026-05-10T10:00:00Z',
      '2026-05-10T10:00:00Z',
    );
    let row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/Sushi Bar/);

    await db.runAsync(
      `UPDATE places SET name = 'Maru Tonkatsu', updated_at = ? WHERE id = 'p1'`,
      '2026-05-10T10:01:00Z',
    );
    row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/Maru Tonkatsu/);
    expect(row?.content).not.toMatch(/Sushi Bar/);
  });
});
```

(`freshDb` already exists in the file; reuse it.)

- [ ] **Step 8.6: Run the full test suite**

```bash
npm test --silent 2>&1 | tail -10
```

Expected: 23 test suites, all passing. Test count goes up from the new schema-shape and orphan-prune cases.

- [ ] **Step 8.7: Commit**

```bash
git add modules/storage/migrations/0001_init.ts \
        modules/storage/__tests__/db.test.ts \
        modules/storage/places.ts modules/storage/sources.ts \
        modules/storage/trips.ts modules/storage/place_sources.ts \
        app components
git commit -m "$(cat <<'EOF'
feat(schema): drop deleted_at from schema + remove all WHERE deleted_at IS NULL

Edits modules/storage/migrations/0001_init.ts in place: removes
deleted_at from the five tables that had it, drops the deleted_at
predicate from eight indexes, and rebuilds nine FTS triggers without
deleted_at filters or WHEN guards. Schema-shape tests in db.test.ts
assert pragma_table_info has no deleted_at column on any table and no
sqlite_master index SQL mentions deleted_at.

Drops every remaining `WHERE deleted_at IS NULL` filter from storage
helpers (places, sources, trips, place_sources), app screens, and
component inline SQL — 24 occurrences total. Final grep confirms no
deleted_at references remain in modules/, app/, or components/.

Pre-flight for any developer running this build: wipe the dev DB
(simulator app delete or remove trip-pocket.db). The runner's
version-skip means the in-place edit only takes effect on a fresh DB.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Triage CTA tray — third "Delete" tertiary row

**Goal:** Add a destructive Delete row to the triage CTA tray, beneath "Skip for now". Confirms with orphan-prune-aware copy and calls `deleteSource`. Advances to next source on success.

**Files:**

- Modify: `app/triage.tsx` (CtaTray component + Triage screen)

- [ ] **Step 9.1: Read `app/triage.tsx` to locate the CtaTray component**

```bash
grep -n "CtaTray\|onPickTrip\|onSkip" app/triage.tsx | head -20
```

The `CtaTray` component is around line 581 in the file (per the spec's read in earlier context). Its props include `onPickTrip`, `onSkip`, `totalCount`, `selectedCount`, `bottomInset`. Target: add `onDelete` and a third row.

- [ ] **Step 9.2: Add `onDelete` prop and the tertiary row to `CtaTray`**

In the `CtaTray` function signature, add `onDelete: () => void` to the props type.

After the "Skip for now" Pressable inside the LinearGradient, add:

```tsx
<Pressable
  onPress={onDelete}
  accessibilityRole="button"
  accessibilityLabel="Delete screenshot"
  accessibilityHint="Permanently delete this screenshot and any extracted places."
  className="mt-2 items-center justify-center"
  style={{ paddingVertical: 10 }}
  hitSlop={8}
>
  <Text style={{ fontSize: 14, fontWeight: '600', color: '#dc2626' }}>Delete</Text>
</Pressable>
```

- [ ] **Step 9.3: Wire the delete handler in the parent Triage component**

Find where `<CtaTray ... onSkip={onSkip} />` is rendered in `Triage`. Above that JSX, add:

```tsx
const onDelete = useCallback(() => {
  if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
  const placesCount = currentPlaces.length;
  const body =
    placesCount === 0
      ? "This can't be undone."
      : `${placesCount} place${placesCount === 1 ? '' : 's'} extracted from it will also be deleted. This can't be undone.`;
  Alert.alert('Delete this screenshot?', body, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: async () => {
        if (!db) return;
        if (process.env.EXPO_OS === 'ios') {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        }
        await deleteSource(db, current.id);
        // Same advance behaviour as Skip — next source, or close if last.
        setItems((prev) => prev?.filter((s) => s.id !== current.id) ?? prev);
        const remaining = (items?.length ?? 0) - 1;
        if (index >= remaining) {
          router.back();
        } else {
          listRef.current?.scrollToIndex({ index, animated: true });
        }
      },
    },
  ]);
}, [db, current, currentPlaces, index, items, router]);
```

Add to the imports at the top of the file:

```tsx
import { Alert } from 'react-native';
import { deleteSource } from '@/modules/storage';
```

(`Alert` may already be imported; check first.)

Pass the new handler to `CtaTray`:

```tsx
<CtaTray
  totalCount={totalCount}
  selectedCount={selectedCount}
  bottomInset={insets.bottom}
  onPickTrip={() => setPickerVisible(true)}
  onSkip={onSkip}
  onDelete={onDelete}
/>
```

- [ ] **Step 9.4: Run typecheck and lint**

```bash
npx tsc --noEmit 2>&1 | head -10
npx eslint app/triage.tsx 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 9.5: Manual smoke (optional, only if dev build is running)**

Open triage with at least one untriaged source. Tap Delete. Confirm dialog appears with correct copy. Confirm → screenshot is gone, advances to next source.

- [ ] **Step 9.6: Commit**

```bash
git add app/triage.tsx
git commit -m "$(cat <<'EOF'
feat(triage): tertiary Delete row in CTA tray with orphan-prune-aware copy

Below "Skip for now": Delete (red text-link, no fill, 44pt hit target).
Confirm dialog body shows the orphan-prune count when ≥1 places were
extracted from the source. Confirmed → deleteSource + advance, same
flow as Skip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Source detail — orphan-prune-aware Delete dialog

**Goal:** Update the existing source-detail Delete dialog to mention orphan-pruned places when applicable. The wiring (menu → confirm → deleteSource) already exists from Task 5.

**Files:**

- Modify: `app/sources/[id].tsx` (the `confirmDelete` function and the place-count query)

- [ ] **Step 10.1: Read `app/sources/[id].tsx` confirmDelete to locate the existing Alert**

The `confirmDelete` function is around line 100. Today it shows: title "Delete this source?", body "This can't be undone.".

- [ ] **Step 10.2: Add a pre-dialog count query and update the Alert**

Replace the existing `confirmDelete` function with:

```tsx
const confirmDelete = async () => {
  if (!db) return;
  // Count places that will be orphan-pruned: places whose only live
  // junction is to this source.
  const countRow = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources ps1
      WHERE ps1.source_id = ?
        AND NOT EXISTS (
              SELECT 1 FROM place_sources ps2
               WHERE ps2.place_id = ps1.place_id
                 AND ps2.source_id != ?
            )`,
    source.id,
    source.id,
  );
  const orphanCount = countRow?.n ?? 0;
  const body =
    orphanCount === 0
      ? "This can't be undone."
      : `${orphanCount} place${orphanCount === 1 ? '' : 's'} extracted from it will also be deleted. This can't be undone.`;

  Alert.alert(
    'Delete this screenshot?',
    body,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          }
          await deleteSource(db, source.id);
          router.back();
        },
      },
    ],
    { cancelable: true },
  );
};
```

(Verify `Haptics` import is present; it was on line 5 in the existing file.)

- [ ] **Step 10.3: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: clean.

- [ ] **Step 10.4: Commit**

```bash
git add app/sources/[id].tsx
git commit -m "$(cat <<'EOF'
feat(source-detail): orphan-prune-aware Delete dialog

Dialog body now mentions the count of places that will be deleted
alongside the source (places whose only live junction is to this
source). Pre-dialog count via NOT EXISTS sub-query against place_sources.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Place detail — orphan-prune-aware Delete dialog

**Goal:** Mirror Task 10 in the other direction. The dialog body mentions the count of sources that will be orphan-pruned.

**Files:**

- Modify: `app/places/[id].tsx` (the `confirmDelete` or equivalent — find via grep)

- [ ] **Step 11.1: Locate the existing delete handler**

```bash
grep -n "Alert.alert\|Delete\|deletePlace" app/places/[id].tsx | head -10
```

Find the menu-action that calls `deletePlace`. The exact line varies; the pattern in the file follows `app/sources/[id].tsx` (a `confirmDelete`-style helper).

- [ ] **Step 11.2: Update the dialog with orphan-prune-aware copy**

Replace the existing delete confirm logic with:

```tsx
const confirmDelete = async () => {
  if (!db) return;
  // Count sources that will be orphan-pruned: sources whose only live
  // junction is to this place.
  const countRow = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM place_sources ps1
      WHERE ps1.place_id = ?
        AND NOT EXISTS (
              SELECT 1 FROM place_sources ps2
               WHERE ps2.source_id = ps1.source_id
                 AND ps2.place_id != ?
            )`,
    place.id,
    place.id,
  );
  const orphanCount = countRow?.n ?? 0;
  const body =
    orphanCount === 0
      ? "This can't be undone."
      : `${orphanCount} screenshot${orphanCount === 1 ? '' : 's'} it came from will also be deleted. This can't be undone.`;

  Alert.alert(
    'Delete this place?',
    body,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          }
          await deletePlace(db, place.id);
          router.back();
        },
      },
    ],
    { cancelable: true },
  );
};
```

Wire `confirmDelete` from wherever the menu currently calls `deletePlace` directly.

- [ ] **Step 11.3: Run typecheck and commit**

```bash
npx tsc --noEmit 2>&1 | head -10
git add app/places/[id].tsx
git commit -m "$(cat <<'EOF'
feat(place-detail): orphan-prune-aware Delete dialog

Mirror of source-detail's dialog: body mentions the count of
screenshots that will be deleted alongside the place (sources whose
only live junction is to this place).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Trip edit — two delete affordances (untriage default + cascade opt-in)

**Goal:** Replace the single Delete button on the trip edit screen with two distinct rows: a primary "Delete trip" (gentle untriage) and a destructive secondary "Delete trip and everything in it" (cascade). Each has its own confirm dialog with accurate counts.

**Files:**

- Modify: `app/trips/[id]/edit.tsx`

- [ ] **Step 12.1: Add count queries when the screen loads**

In the existing `useEffect` (lines 25-41), the load fetches the trip name + place count. Extend it to also fetch:

- `sourceCount` — sources in this trip.
- `cascadeDeletedPlaces` — places that will actually be deleted by cascade (every junction to a source in this trip).
- `cascadeSurvivingShared` — places that survive cascade because they have other-trip junctions.

Replace the `useEffect` body with:

```tsx
useEffect(() => {
  let cancelled = false;
  if (!db || !id) return;
  (async () => {
    const t = await getTrip(db, id);
    if (!t) {
      if (!cancelled) setLoad({ kind: 'loaded', trip: null, counts: null });
      return;
    }
    const placeCountRow = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM places WHERE trip_id = ?`,
      id,
    );
    const sourceCountRow = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sources WHERE trip_id = ?`,
      id,
    );
    const cascadeDeletedRow = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM places p
        WHERE p.id IN (
          SELECT DISTINCT place_id FROM place_sources
           WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)
        )
          AND NOT EXISTS (
            SELECT 1 FROM place_sources ps
             WHERE ps.place_id = p.id
               AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
          )`,
      id,
      id,
    );
    const cascadeSharedRow = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM places p
        WHERE (p.trip_id = ?
               OR p.id IN (SELECT DISTINCT place_id FROM place_sources
                            WHERE source_id IN (SELECT id FROM sources WHERE trip_id = ?)))
          AND EXISTS (
            SELECT 1 FROM place_sources ps
             WHERE ps.place_id = p.id
               AND ps.source_id NOT IN (SELECT id FROM sources WHERE trip_id = ?)
          )`,
      id,
      id,
      id,
    );
    if (cancelled) return;
    setLoad({
      kind: 'loaded',
      trip: t,
      counts: {
        places: placeCountRow?.n ?? 0,
        sources: sourceCountRow?.n ?? 0,
        cascadeDeletedPlaces: cascadeDeletedRow?.n ?? 0,
        cascadeSurvivingShared: cascadeSharedRow?.n ?? 0,
      },
    });
    setName(t.name);
  })();
  return () => {
    cancelled = true;
  };
}, [db, id]);
```

Update the `LoadState` type:

```tsx
type CountSet = {
  places: number;
  sources: number;
  cascadeDeletedPlaces: number;
  cascadeSurvivingShared: number;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; trip: Trip | null; counts: CountSet | null };
```

Update references downstream from `load.count` to `load.counts.places` (and similar). The existing `if (load.trip === null)` early-return path can pass `counts: null` since no counts are needed.

- [ ] **Step 12.2: Replace the existing Delete button with two rows**

Find the existing single delete button (lines 187-205). Replace with:

```tsx
<Pressable
  onPress={onDeleteUntriage}
  accessibilityRole="button"
  accessibilityLabel="Delete trip"
  style={{
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.30)',
    backgroundColor: 'rgba(254,242,242,0.6)',
  }}
>
  <Text className="text-center" style={{ fontSize: 14, fontWeight: '600', color: '#dc2626' }}>
    Delete trip
  </Text>
</Pressable>;

{
  counts && (counts.sources > 0 || counts.cascadeDeletedPlaces > 0) ? (
    <>
      <View style={{ height: 8 }} />
      <Pressable
        onPress={onDeleteCascade}
        accessibilityRole="button"
        accessibilityLabel="Delete trip and everything in it"
        style={{ paddingVertical: 10 }}
        hitSlop={8}
      >
        <Text className="text-center" style={{ fontSize: 13, fontWeight: '500', color: '#dc2626' }}>
          Delete trip and everything in it
        </Text>
      </Pressable>
    </>
  ) : null;
}
```

`counts` is `load.counts` once loaded; pass it down or read from local state. The destructive cascade row is hidden when there's nothing to cascade (matches the spec's §4.3 rule).

- [ ] **Step 12.3: Add the two handlers**

Replace the existing `onDelete` function with two handlers:

```tsx
const onDeleteUntriage = () => {
  if (!db || !id || !counts) return;
  const { sources: n, places: m } = counts;
  const body =
    n === 0 && m === 0
      ? "This can't be undone."
      : `${n} screenshot${n === 1 ? '' : 's'} and ${m} place${m === 1 ? '' : 's'} will move back to your Inbox.`;
  Alert.alert(`Delete '${trip.name}'?`, body, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: async () => {
        try {
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          }
          await deleteTrip(db, id, 'untriage');
          router.back();
          setTimeout(() => router.back(), 0);
        } catch (err) {
          Alert.alert('Could not delete trip', String(err));
        }
      },
    },
  ]);
};

const onDeleteCascade = () => {
  if (!db || !id || !counts) return;
  const { sources: n, cascadeDeletedPlaces: m, cascadeSurvivingShared: s } = counts;
  const lines = [
    `Delete '${trip.name}' and ${n} screenshot${n === 1 ? '' : 's'}, ${m} place${m === 1 ? '' : 's'}?`,
  ];
  if (s > 0) {
    lines.push(
      `${s} place${s === 1 ? '' : 's'} shared with other trips will be moved to your Inbox.`,
    );
  }
  lines.push("This can't be undone.");
  Alert.alert(lines[0]!, lines.slice(1).join('\n\n'), [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete everything',
      style: 'destructive',
      onPress: async () => {
        try {
          if (process.env.EXPO_OS === 'ios') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          }
          await deleteTrip(db, id, 'cascade');
          router.back();
          setTimeout(() => router.back(), 0);
        } catch (err) {
          Alert.alert('Could not delete trip', String(err));
        }
      },
    },
  ]);
};
```

`counts` and `trip` are read from `load.counts` and `load.trip` (after the `if (load.kind === 'loading')` early return). Adapt variable references to match the existing component's scope.

- [ ] **Step 12.4: Run typecheck and the test suite**

```bash
npx tsc --noEmit 2>&1 | head -10
npm test --silent 2>&1 | tail -10
```

Expected: clean compile, all tests pass.

- [ ] **Step 12.5: Commit**

```bash
git add app/trips/[id]/edit.tsx
git commit -m "$(cat <<'EOF'
feat(trip-edit): two delete affordances (untriage default + cascade opt-in)

Primary "Delete trip" (red text on light bg) → deleteTrip(id, 'untriage'):
N screenshots and M places move back to Inbox.

Destructive secondary "Delete trip and everything in it" (small red
text-link, hidden when there's nothing to cascade) → deleteTrip(id,
'cascade'): N screenshots and M places gone, S shared-with-other-trips
places moved to Inbox.

Counts computed via SQL on screen load: COUNT places where every
junction is in this trip's sources (M), and COUNT places where any
junction is outside (S).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: FTS sanity tests for cascade behaviour

**Goal:** Add four FTS tests that exercise the cascade paths against the rebuilt triggers.

**Files:**

- Create: `modules/search/__tests__/fts-cascade.test.ts`

- [ ] **Step 13.1: Create `modules/search/__tests__/fts-cascade.test.ts`**

```ts
import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { insertSource } from '@/modules/storage/sources';
import { linkPlaceSource } from '@/modules/storage/place_sources';
import { deletePlace } from '@/modules/storage/places';
import { deleteSource } from '@/modules/storage/sources';
import { deleteTrip } from '@/modules/storage/trips';
import { createTrip } from '@/modules/storage/trips';
import { assignSourceTrip } from '@/modules/storage/sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedPlace(
  db: Database,
  id: string,
  name: string,
  tripId: string | null = null,
): Promise<void> {
  const now = '2026-05-10T10:00:00Z';
  await db.runAsync(
    `INSERT INTO places (id, trip_id, name, city, normalized_key,
                         enrichment_status, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Tokyo', ?, 'pending', ?, ?, ?)`,
    id,
    tripId,
    name,
    `${name.toLowerCase()}|tokyo`,
    ownerId,
    now,
    now,
  );
}

async function seedSource(
  db: Database,
  id: string,
  ocrText: string,
  tripId: string | null = null,
): Promise<void> {
  await insertSource(db, {
    id,
    tripId,
    filePath: `/x/${id}.jpg`,
    contentHash: `h-${id}`,
    origin: 'manual',
    capturedAt: '2026-05-10T10:00:00Z',
    ownerId,
  });
  await db.runAsync(`UPDATE sources SET ocr_text = ? WHERE id = ?`, ocrText, id);
}

const link = async (
  db: Database,
  placeId: string,
  sourceId: string,
  rawText?: string,
): Promise<void> => {
  await linkPlaceSource(db, {
    placeId,
    sourceId,
    rawText: rawText ?? null,
    extractionModel: 'gemini',
    ownerId,
  });
};

describe('FTS cascade behaviour', () => {
  it('deleteSource that orphan-prunes a place removes the place from places_fts', async () => {
    const db = await freshDb();
    await seedSource(db, 's1', 'shibuya restaurant');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1');

    const before = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM places_fts WHERE places_fts MATCH 'tonkatsu'`,
    );
    expect(before).toHaveLength(1);

    await deleteSource(db, 's1', { unlinkFile: () => {} });

    const after = await db.getAllAsync<{ place_id: string }>(
      `SELECT place_id FROM places_fts WHERE places_fts MATCH 'tonkatsu'`,
    );
    expect(after).toEqual([]);
  });

  it('deletePlace that orphan-prunes a source removes the source from sources_fts', async () => {
    const db = await freshDb();
    await seedSource(db, 's1', 'shibuya restaurant ocr');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1');

    const before = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE sources_fts MATCH 'shibuya'`,
    );
    expect(before).toHaveLength(1);

    await deletePlace(db, 'p1', { unlinkFile: () => {} });

    const after = await db.getAllAsync<{ source_id: string }>(
      `SELECT source_id FROM sources_fts WHERE sources_fts MATCH 'shibuya'`,
    );
    expect(after).toEqual([]);
  });

  it('junction-only delete via assignSourceTrip rebuilds places_fts without the dropped source', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedSource(db, 's1', 'ocr-1');
    await seedSource(db, 's2', 'ocr-2');
    await seedPlace(db, 'p1', 'Maru Tonkatsu');
    await link(db, 'p1', 's1', 'rawtext-from-s1');
    await link(db, 'p1', 's2', 'rawtext-from-s2');

    // Drop s2's junction via excludePlaceIds.
    await assignSourceTrip(db, 's2', 't1', { excludePlaceIds: ['p1'] });

    const row = await db.getFirstAsync<{ content: string }>(
      `SELECT content FROM places_fts WHERE place_id = 'p1'`,
    );
    expect(row?.content).toMatch(/rawtext-from-s1/);
    expect(row?.content).not.toMatch(/rawtext-from-s2/);
  });

  it('cascade trip delete clears both FTS tables of the deleted ids', async () => {
    const db = await freshDb();
    await createTrip(db, { id: 't1', name: 'Japan', ownerId });
    await seedSource(db, 's1', 'shibuya', 't1');
    await seedPlace(db, 'p1', 'Maru Tonkatsu', 't1');
    await link(db, 'p1', 's1');

    await deleteTrip(db, 't1', 'cascade', { unlinkFile: () => {} });

    const placesFts = await db.getAllAsync(`SELECT place_id FROM places_fts`);
    const sourcesFts = await db.getAllAsync(`SELECT source_id FROM sources_fts`);
    expect(placesFts).toEqual([]);
    expect(sourcesFts).toEqual([]);
  });
});
```

- [ ] **Step 13.2: Run the new tests**

```bash
npx jest modules/search/__tests__/fts-cascade.test.ts 2>&1 | tail -20
```

Expected: all four pass.

- [ ] **Step 13.3: Commit**

```bash
git add modules/search/__tests__/fts-cascade.test.ts
git commit -m "$(cat <<'EOF'
test(fts): cascade behaviour against rebuilt triggers

Four cases per spec §6.3:
- deleteSource orphan-prunes place → places_fts cleared.
- deletePlace orphan-prunes source → sources_fts cleared.
- assignSourceTrip junction-drop → places_fts rebuilt without the
  dropped source's raw_text.
- cascade trip delete → both FTS tables empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Documentation + roadmap

**Goal:** Document the dev-DB-wipe requirement and mark the roadmap item shipped.

**Files:**

- Modify: `docs/ARCHITECTURE.md` (or `README.md` if the user prefers)
- Modify: `docs/ROADMAP.md`

- [ ] **Step 14.1: Add a dev-DB-wipe note to ARCHITECTURE.md**

Find a "Local development" or "Setup" section in `docs/ARCHITECTURE.md`. If neither exists, append a new section near the top:

```markdown
## Schema changes & dev DB wipe

We collapse schema history into `modules/storage/migrations/0001_init.ts`
rather than carrying old shapes forward — Trip Pocket has no users.
When the schema in that file changes, the runner skips it on existing
DBs (version-tracked in `schema_migrations`). Wipe your dev DB to pick
up changes:

- iOS Simulator: long-press the app icon → Remove app → Delete app.
- Or remove `trip-pocket.db` from the simulator app sandbox at
  `~/Library/Developer/CoreSimulator/Devices/<DEVICE-UDID>/data/Containers/Shared/AppGroup/<GROUP>/`.
```

If `docs/ARCHITECTURE.md` doesn't exist, add the section to `README.md` instead.

- [ ] **Step 14.2: Mark the roadmap item shipped**

In `docs/ROADMAP.md`, find the `Delete cascade rewrite` line under v0.2 In flight (added by commit `f5ed456`). Replace:

```markdown
- [ ] Delete cascade rewrite — replace soft-delete-only with hard-delete + symmetric orphan prune; trip delete gets gentle (untriage) and destructive (cascade) modes; triage CTA tray gains a tertiary Delete row. Spec: `docs/superpowers/specs/2026-05-10-delete-cascade-design.md`.
```

With:

```markdown
- [x] Delete cascade rewrite — shipped 2026-05-10. Hard-delete throughout; deleted_at column dropped from all five tables; symmetric orphan prune (deleting a place removes any source whose only junction was to it, and vice-versa); trip delete has untriage default + cascade opt-in; triage CTA tray has tertiary Delete row. Spec: `docs/superpowers/specs/2026-05-10-delete-cascade-design.md`. Plan: `docs/superpowers/plans/2026-05-10-delete-cascade.md`.
```

- [ ] **Step 14.3: Final test suite + grep + commit**

```bash
npm test --silent 2>&1 | tail -8
grep -rn "deleted_at\|softDelete" --include="*.ts" --include="*.tsx" \
  app components modules \
  | grep -v node_modules \
  | grep -v 'docs/' \
  || echo "OK: no remaining soft-delete references in code"
```

Expected: full suite green, no soft-delete references in code paths.

```bash
git add docs/ARCHITECTURE.md docs/ROADMAP.md
git commit -m "$(cat <<'EOF'
docs(delete-cascade): dev-DB-wipe note + roadmap mark shipped

Adds a "Schema changes & dev DB wipe" section explaining why we edit
0001_init.ts in place rather than adding migrations, and how to wipe
the simulator dev DB to pick up changes. Marks the roadmap item shipped
and links to the spec + plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
