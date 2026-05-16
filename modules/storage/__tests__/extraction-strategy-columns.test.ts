import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { insertSource, getSource, type ExtractionStrategyName } from '../sources';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('migration 0010 — extraction_strategy + fetched_via columns', () => {
  it('adds extraction_strategy and fetched_via to the sources table', async () => {
    const db = await freshDb();
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(sources)`);
    const names = cols.map((c) => c.name);
    expect(names).toContain('extraction_strategy');
    expect(names).toContain('fetched_via');
  });

  it('both new columns are nullable (no NOT NULL constraint)', async () => {
    const db = await freshDb();
    const cols = await db.getAllAsync<{ name: string; notnull: number }>(
      `PRAGMA table_info(sources)`,
    );
    const es = cols.find((c) => c.name === 'extraction_strategy');
    const fv = cols.find((c) => c.name === 'fetched_via');
    expect(es?.notnull).toBe(0);
    expect(fv?.notnull).toBe(0);
  });
});

describe('sources repository — extraction_strategy / fetched_via', () => {
  it('legacy insertSource (without extractionStrategy) leaves the column NULL', async () => {
    const db = await freshDb();
    await insertSource(db, {
      id: 'legacy',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      contentHash: 'hash-legacy',
      origin: 'share',
      capturedAt: '2026-05-16T10:00:00Z',
      ownerId,
    });
    const row = await getSource(db, 'legacy');
    expect(row?.extractionStrategy).toBeNull();
    expect(row?.fetchedVia).toBeNull();
  });

  it('insertSource accepts an extractionStrategy and persists it', async () => {
    const db = await freshDb();
    const strategy: ExtractionStrategyName = 'vision';
    await insertSource(db, {
      id: 'v1',
      tripId: null,
      filePath: '/sandbox/v1.jpg',
      contentHash: 'hash-v1',
      origin: 'share',
      capturedAt: '2026-05-16T10:00:00Z',
      ownerId,
      extractionStrategy: strategy,
    });
    const row = await getSource(db, 'v1');
    expect(row?.extractionStrategy).toBe('vision');
  });

  it('accepts all four valid extractionStrategy values', async () => {
    const db = await freshDb();
    const strategies: ExtractionStrategyName[] = ['ocrTextLLM', 'vision', 'captionPlusVision'];
    for (let i = 0; i < strategies.length; i++) {
      await insertSource(db, {
        id: `s${i}`,
        tripId: null,
        contentHash: `hash-s${i}`,
        origin: 'share',
        capturedAt: '2026-05-16T10:00:00Z',
        ownerId,
        extractionStrategy: strategies[i],
      });
    }
    for (let i = 0; i < strategies.length; i++) {
      const row = await getSource(db, `s${i}`);
      expect(row?.extractionStrategy).toBe(strategies[i]);
    }
  });
});
