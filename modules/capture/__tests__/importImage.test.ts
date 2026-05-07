import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listScreenshots, softDeleteScreenshot } from '@/modules/storage/screenshots';
import { importImage, type ImportFs } from '../importImage';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

function makeFs(overrides: Partial<ImportFs> = {}): ImportFs & {
  copy: jest.Mock;
  move: jest.Mock;
  unlink: jest.Mock;
  sha256: jest.Mock;
} {
  return {
    sha256: jest.fn(async (uri: string) => `sha-of:${uri}`),
    copy: jest.fn(async (_from: string, _to: string) => undefined),
    move: jest.fn(async (_from: string, _to: string) => undefined),
    unlink: jest.fn(async (_uri: string) => undefined),
    ...overrides,
  } as ImportFs & {
    copy: jest.Mock;
    move: jest.Mock;
    unlink: jest.Mock;
    sha256: jest.Mock;
  };
}

describe('importImage', () => {
  it('imports a fresh image, writes the row with the real content hash', async () => {
    const db = await freshDb();
    const fs = makeFs();
    const result = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      source: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      sandboxDir: '/sandbox',
      fs,
    });

    expect(result.status).toBe('imported');
    expect(fs.sha256).toHaveBeenCalledWith('/picker/img1.jpg');
    expect(fs.copy).toHaveBeenCalledTimes(1);
    expect(fs.move).not.toHaveBeenCalled();

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentHash).toBe('sha-of:/picker/img1.jpg');
    expect(rows[0]?.filePath.startsWith('/sandbox/')).toBe(true);
  });

  it('returns duplicate for the same content hash on second call, no second row', async () => {
    const db = await freshDb();
    const fs = makeFs();

    const a = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      source: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      sandboxDir: '/sandbox',
      fs,
    });
    expect(a.status).toBe('imported');

    const b = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      source: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:01Z',
      transfer: 'copy',
      sandboxDir: '/sandbox',
      fs,
    });
    expect(b.status).toBe('duplicate');
    if (b.status === 'duplicate') {
      expect(b.existingScreenshotId).toBe((a as { screenshotId: string }).screenshotId);
    }
    // copy ran only once — duplicate path skipped the file copy.
    expect(fs.copy).toHaveBeenCalledTimes(1);

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
  });

  it('allows reimporting after soft-delete (partial unique index excludes deleted rows)', async () => {
    const db = await freshDb();
    const fs = makeFs();

    const first = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      source: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      sandboxDir: '/sandbox',
      fs,
    });
    if (first.status !== 'imported') throw new Error('expected imported');
    await softDeleteScreenshot(db, first.screenshotId);

    const second = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      source: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:02Z',
      transfer: 'copy',
      sandboxDir: '/sandbox',
      fs,
    });
    expect(second.status).toBe('imported');

    const all = await db.getAllAsync<{ id: string; deleted_at: string | null }>(
      'SELECT id, deleted_at FROM screenshots ORDER BY created_at',
    );
    expect(all).toHaveLength(2);
  });

  it('uses move when transfer=move (share-ingest path)', async () => {
    const db = await freshDb();
    const fs = makeFs();

    await importImage(db, {
      sourceUri: '/appgroup/img1.jpg',
      source: 'share',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'move',
      sandboxDir: '/sandbox',
      fs,
    });

    expect(fs.move).toHaveBeenCalledTimes(1);
    expect(fs.copy).not.toHaveBeenCalled();
  });

  it('unlinks the target file when the insert fails AFTER a successful copy (race-condition cleanup)', async () => {
    const db = await freshDb();
    // Use a deterministic sha256 so we can choreograph the race.
    const sha = jest.fn(async () => 'h-collision');
    const fs = makeFs({ sha256: sha });

    // The choreography: importImage runs sha256 → pre-check (no row found) → fs.copy
    // → insertScreenshot. We hijack fs.copy to insert a CONFLICTING active row
    // mid-flight so that by the time importImage's own insert runs, the partial
    // unique index `WHERE deleted_at IS NULL` fires SQLITE_CONSTRAINT.
    fs.copy = jest.fn(async (_from, _to) => {
      await db.runAsync(
        `INSERT INTO screenshots
           (id, trip_id, file_path, content_hash, source,
            ocr_status, extraction_status, captured_at,
            owner_id, created_at, updated_at)
         VALUES ('racer', NULL, '/sandbox/racer.jpg', 'h-collision', 'manual',
                 'pending', 'pending', '2026-05-04T09:00:00Z',
                 ?, '2026-05-04T09:00:00Z', '2026-05-04T09:00:00Z')`,
        ownerId,
      );
    });

    await expect(
      importImage(db, {
        sourceUri: '/picker/img.jpg',
        source: 'manual',
        ownerId,
        capturedAt: '2026-05-04T10:00:00Z',
        transfer: 'copy',
        sandboxDir: '/sandbox',
        fs,
      }),
    ).rejects.toBeDefined();

    // The copy ran (the race was triggered):
    expect(fs.copy).toHaveBeenCalledTimes(1);
    // The helper unlinked the orphan target it had just placed:
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    const unlinkPath = (fs.unlink as jest.Mock).mock.calls[0]?.[0] as string;
    expect(unlinkPath.startsWith('/sandbox/')).toBe(true);
    expect(unlinkPath.endsWith('.jpg')).toBe(true);
    // No orphan row beyond the racer:
    const ids = await db.getAllAsync<{ id: string }>('SELECT id FROM screenshots');
    expect(ids.map((r) => r.id)).toEqual(['racer']);
  });
});
