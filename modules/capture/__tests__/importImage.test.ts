import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listSources, softDeleteSource } from '@/modules/storage/sources';
import {
  provideProcessor,
  _resetProcessorForTests,
  type Processor,
} from '@/modules/processing';
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
  it('imports a fresh image, writes a kind=screenshot source row with the real content hash', async () => {
    const db = await freshDb();
    const fs = makeFs();
    const result = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      origin: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      storageDir: '/sandbox',
      fs,
    });

    expect(result.status).toBe('imported');
    expect(fs.sha256).toHaveBeenCalledWith('/picker/img1.jpg');
    expect(fs.copy).toHaveBeenCalledTimes(1);
    expect(fs.move).not.toHaveBeenCalled();

    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('screenshot');
    expect(rows[0]?.origin).toBe('manual');
    expect(rows[0]?.contentHash).toBe('sha-of:/picker/img1.jpg');
    expect(rows[0]?.filePath?.startsWith('/sandbox/')).toBe(true);
  });

  it('returns duplicate for the same content hash on second call, no second row', async () => {
    const db = await freshDb();
    const fs = makeFs();

    const a = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      origin: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      storageDir: '/sandbox',
      fs,
    });
    expect(a.status).toBe('imported');

    const b = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      origin: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:01Z',
      transfer: 'copy',
      storageDir: '/sandbox',
      fs,
    });
    expect(b.status).toBe('duplicate');
    if (b.status === 'duplicate') {
      expect(b.existingSourceId).toBe((a as { sourceId: string }).sourceId);
    }
    expect(fs.copy).toHaveBeenCalledTimes(1);

    const rows = await listSources(db, { tripId: null });
    expect(rows).toHaveLength(1);
  });

  it('allows reimporting after soft-delete (partial unique index excludes deleted rows)', async () => {
    const db = await freshDb();
    const fs = makeFs();

    const first = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      origin: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'copy',
      storageDir: '/sandbox',
      fs,
    });
    if (first.status !== 'imported') throw new Error('expected imported');
    await softDeleteSource(db, first.sourceId);

    const second = await importImage(db, {
      sourceUri: '/picker/img1.jpg',
      origin: 'manual',
      ownerId,
      capturedAt: '2026-05-04T10:00:02Z',
      transfer: 'copy',
      storageDir: '/sandbox',
      fs,
    });
    expect(second.status).toBe('imported');

    const all = await db.getAllAsync<{ id: string; deleted_at: string | null }>(
      'SELECT id, deleted_at FROM sources ORDER BY created_at',
    );
    expect(all).toHaveLength(2);
  });

  it('uses move when transfer=move (share-ingest path)', async () => {
    const db = await freshDb();
    const fs = makeFs();

    await importImage(db, {
      sourceUri: '/appgroup/img1.jpg',
      origin: 'share',
      ownerId,
      capturedAt: '2026-05-04T10:00:00Z',
      transfer: 'move',
      storageDir: '/sandbox',
      fs,
    });

    expect(fs.move).toHaveBeenCalledTimes(1);
    expect(fs.copy).not.toHaveBeenCalled();
  });

  it('unlinks the target file when the insert fails AFTER a successful copy (race-condition cleanup)', async () => {
    const db = await freshDb();
    const sha = jest.fn(async () => 'h-collision');
    const fs = makeFs({ sha256: sha });

    // The choreography: importImage runs sha256 → pre-check (no row found) → fs.copy
    // → insertSource. We hijack fs.copy to insert a CONFLICTING active row mid-flight
    // so that by the time importImage's own insert runs, the partial unique index
    // `WHERE deleted_at IS NULL` fires SQLITE_CONSTRAINT.
    fs.copy = jest.fn(async (_from, _to) => {
      await db.runAsync(
        `INSERT INTO sources
           (id, kind, trip_id, file_path, url, content_hash, origin,
            ocr_status, extraction_status, captured_at,
            owner_id, created_at, updated_at)
         VALUES ('racer', 'screenshot', NULL, '/sandbox/racer.jpg', NULL, 'h-collision', 'manual',
                 'pending', 'pending', '2026-05-04T09:00:00Z',
                 ?, '2026-05-04T09:00:00Z', '2026-05-04T09:00:00Z')`,
        ownerId,
      );
    });

    await expect(
      importImage(db, {
        sourceUri: '/picker/img.jpg',
        origin: 'manual',
        ownerId,
        capturedAt: '2026-05-04T10:00:00Z',
        transfer: 'copy',
        storageDir: '/sandbox',
        fs,
      }),
    ).rejects.toBeDefined();

    expect(fs.copy).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    const unlinkPath = (fs.unlink as jest.Mock).mock.calls[0]?.[0] as string;
    expect(unlinkPath.startsWith('/sandbox/')).toBe(true);
    expect(unlinkPath.endsWith('.jpg')).toBe(true);
    const ids = await db.getAllAsync<{ id: string }>('SELECT id FROM sources');
    expect(ids.map((r) => r.id)).toEqual(['racer']);
  });

  describe('processor hook', () => {
    afterEach(() => {
      _resetProcessorForTests();
    });

    function makeFakeProcessor(): {
      processor: Processor;
      enqueueOcr: jest.Mock<void, [string]>;
    } {
      const enqueueOcr = jest.fn<void, [string]>();
      const processor: Processor = {
        enqueueOcr,
        runOcrSweep: jest.fn().mockResolvedValue(undefined),
        runStartupRecovery: jest.fn().mockResolvedValue(undefined),
        _awaitIdle: jest.fn().mockResolvedValue(undefined),
      };
      return { processor, enqueueOcr };
    }

    it('calls processor.enqueueOcr(id) after a successful import', async () => {
      const db = await freshDb();
      const fs = makeFs();
      const { processor, enqueueOcr } = makeFakeProcessor();
      provideProcessor(processor);

      const result = await importImage(db, {
        sourceUri: '/picker/img1.jpg',
        origin: 'manual',
        ownerId,
        capturedAt: '2026-05-07T10:00:00Z',
        transfer: 'copy',
        storageDir: '/sandbox',
        fs,
      });

      if (result.status !== 'imported') throw new Error('expected imported');
      expect(enqueueOcr).toHaveBeenCalledTimes(1);
      expect(enqueueOcr).toHaveBeenCalledWith(result.sourceId);
    });

    it('does NOT enqueueOcr when the import is a duplicate (existing row already has its own lifecycle)', async () => {
      const db = await freshDb();
      const fs = makeFs();
      const { processor, enqueueOcr } = makeFakeProcessor();

      await importImage(db, {
        sourceUri: '/picker/img1.jpg',
        origin: 'manual',
        ownerId,
        capturedAt: '2026-05-07T10:00:00Z',
        transfer: 'copy',
        storageDir: '/sandbox',
        fs,
      });

      provideProcessor(processor);
      const second = await importImage(db, {
        sourceUri: '/picker/img1.jpg',
        origin: 'manual',
        ownerId,
        capturedAt: '2026-05-07T10:00:01Z',
        transfer: 'copy',
        storageDir: '/sandbox',
        fs,
      });

      expect(second.status).toBe('duplicate');
      expect(enqueueOcr).not.toHaveBeenCalled();
    });

    it('is a no-op when no processor is provisioned', async () => {
      const db = await freshDb();
      const fs = makeFs();
      await expect(
        importImage(db, {
          sourceUri: '/picker/img1.jpg',
          origin: 'manual',
          ownerId,
          capturedAt: '2026-05-07T10:00:00Z',
          transfer: 'copy',
          storageDir: '/sandbox',
          fs,
        }),
      ).resolves.toMatchObject({ status: 'imported' });
    });

    it('accepts origin = auto', async () => {
      const db = await freshDb();
      const fs = makeFs();
      const result = await importImage(db, {
        sourceUri: '/auto/img1.jpg',
        origin: 'auto',
        ownerId,
        capturedAt: '2026-05-07T10:00:00Z',
        transfer: 'copy',
        storageDir: '/sandbox',
        fs,
      });
      expect(result.status).toBe('imported');
      const rows = await listSources(db, { tripId: null });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe('auto');
    });
  });
});
