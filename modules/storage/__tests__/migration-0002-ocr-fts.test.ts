import { openDatabase, runMigrations, getMigrationVersion, type Database } from '../db';
import { migrations } from '../migrations';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('migration 0002 — OCR FTS rebuild + triggers', () => {
  it('reaches version 2 after applying all migrations', async () => {
    const db = await freshDb();
    expect(await getMigrationVersion(db)).toBeGreaterThanOrEqual(2);
  });

  it('rebuilds screenshots_fts with the trigram tokenizer', async () => {
    const db = await freshDb();
    // Inserting Japanese text and querying a non-prefix CJK substring (≥3
    // codepoints — trigram's hard minimum) is the load-bearing assertion.
    // With the day-one `porter unicode61` tokenizer, even a longer mid-string
    // CJK match returns nothing because the whole CJK run is one token; with
    // trigram it must match.
    await db.runAsync(
      'INSERT INTO screenshots_fts (screenshot_id, content) VALUES (?, ?)',
      'sentinel',
      'とんかつ定食',
    );
    const rows = await db.getAllAsync<{ screenshot_id: string }>(
      `SELECT screenshot_id FROM screenshots_fts WHERE screenshots_fts MATCH ?`,
      '"つ定食"',
    );
    expect(rows.map((r) => r.screenshot_id)).toEqual(['sentinel']);
  });

  describe('triggers', () => {
    const ownerId = 'owner-1';
    const now = '2026-05-07T10:00:00.000Z';

    async function insertScreenshot(
      db: Database,
      id: string,
      ocrText: string | null,
    ): Promise<void> {
      await db.runAsync(
        `INSERT INTO screenshots (
           id, file_path, content_hash, source, ocr_status, ocr_text,
           captured_at, owner_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
        id,
        `/tmp/${id}.jpg`,
        `hash-${id}`,
        ocrText === null ? 'pending' : 'done',
        ocrText,
        now,
        ownerId,
        now,
        now,
      );
    }

    async function ftsContent(db: Database, id: string): Promise<string | null> {
      const row = await db.getFirstAsync<{ content: string }>(
        `SELECT content FROM screenshots_fts WHERE screenshot_id = ?`,
        id,
      );
      return row?.content ?? null;
    }

    it('AFTER INSERT trigger writes FTS row when ocr_text is set on insert', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's1', 'Maru Tonkatsu, Shibuya');
      expect(await ftsContent(db, 's1')).toBe('Maru Tonkatsu, Shibuya');
    });

    it('AFTER INSERT trigger does NOT write FTS row when ocr_text is null', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's2', null);
      expect(await ftsContent(db, 's2')).toBeNull();
    });

    it('AFTER UPDATE trigger writes FTS row when ocr_text flips from null to non-null', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's3', null);
      expect(await ftsContent(db, 's3')).toBeNull();

      await db.runAsync(
        `UPDATE screenshots SET ocr_text = ?, ocr_status = 'done', updated_at = ? WHERE id = ?`,
        'hello world',
        now,
        's3',
      );
      expect(await ftsContent(db, 's3')).toBe('hello world');
    });

    it('AFTER UPDATE trigger replaces (not duplicates) the FTS row when ocr_text changes', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's4', 'first');
      await db.runAsync(
        `UPDATE screenshots SET ocr_text = ?, updated_at = ? WHERE id = ?`,
        'second',
        now,
        's4',
      );
      const rows = await db.getAllAsync<{ content: string }>(
        `SELECT content FROM screenshots_fts WHERE screenshot_id = ?`,
        's4',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe('second');
    });

    it('AFTER UPDATE trigger removes the FTS row on soft delete', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's5', 'will be soft-deleted');
      expect(await ftsContent(db, 's5')).toBe('will be soft-deleted');

      await db.runAsync(
        `UPDATE screenshots SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        's5',
      );
      expect(await ftsContent(db, 's5')).toBeNull();
    });

    it('AFTER DELETE trigger removes the FTS row on hard delete', async () => {
      const db = await freshDb();
      await insertScreenshot(db, 's6', 'hard delete me');
      await db.runAsync(`DELETE FROM screenshots WHERE id = ?`, 's6');
      expect(await ftsContent(db, 's6')).toBeNull();
    });
  });

  it('snippet() returns excerpt with the requested markers', async () => {
    const db = await freshDb();
    await db.runAsync(
      'INSERT INTO screenshots_fts (screenshot_id, content) VALUES (?, ?)',
      's-snip',
      'Welcome to Maru Tonkatsu in Shibuya, Tokyo. Open daily 11am to 9pm.',
    );
    const row = await db.getFirstAsync<{ snip: string }>(
      `SELECT snippet(screenshots_fts, 1, char(2), char(3), '…', 8) AS snip
         FROM screenshots_fts
        WHERE screenshots_fts MATCH ?`,
      '"tonkatsu"',
    );
    expect(row?.snip).toBeTruthy();
    expect(row!.snip).toMatch(/[Tt]onkatsu/);
  });
});
