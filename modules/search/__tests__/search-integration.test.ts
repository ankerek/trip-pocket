import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { buildFtsMatch } from '../buildFtsMatch';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

async function seedFts(db: Database, id: string, content: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO screenshots_fts (screenshot_id, content) VALUES (?, ?)',
    id,
    content,
  );
}

async function searchIds(db: Database, input: string): Promise<string[]> {
  const match = buildFtsMatch(input);
  if (match === null) return [];
  const rows = await db.getAllAsync<{ screenshot_id: string }>(
    `SELECT screenshot_id FROM screenshots_fts WHERE screenshots_fts MATCH ? ORDER BY rank`,
    match,
  );
  return rows.map((r) => r.screenshot_id);
}

describe('search integration: buildFtsMatch -> screenshots_fts MATCH', () => {
  it('finds an English substring inside a longer OCR text', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'Welcome to Maru Tonkatsu in Shibuya, Tokyo.');
    expect(await searchIds(db, 'tonk')).toEqual(['s1']);
  });

  it('finds a 3-codepoint CJK substring (not just prefix)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'とんかつ定食 ¥1500');
    expect(await searchIds(db, 'つ定食')).toEqual(['s1']);
  });

  it('returns no rows for a 2-char query (below trigram minimum, helper short-circuits)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'tonkatsu');
    expect(await searchIds(db, 'to')).toEqual([]);
  });

  it('AND-joins multiple tokens (both must appear, order independent)', async () => {
    const db = await freshDb();
    await seedFts(db, 'both', 'Maru Tonkatsu in Shibuya');
    await seedFts(db, 'tonkOnly', 'Some other tonkatsu place');
    await seedFts(db, 'shibuyaOnly', 'Random Shibuya note');
    expect(await searchIds(db, 'tonkatsu shibuya')).toEqual(['both']);
  });

  it("survives a real apostrophe in the input (O'Brien) without SQL injection", async () => {
    const db = await freshDb();
    await seedFts(db, 's1', "Visit O'Brien's Pub in Dublin");
    expect(await searchIds(db, "o'brien")).toEqual(['s1']);
  });

  it('quoting * does not turn it into a prefix operator (literal star)', async () => {
    const db = await freshDb();
    await seedFts(db, 's1', 'rated 5*** experience');
    await seedFts(db, 's2', 'plain text');
    // `5***` is a literal substring of s1; helper quotes the token so FTS5
    // treats * as data, not operator. 5+ASCII satisfies trigram (≥3 chars).
    expect(await searchIds(db, '5***')).toEqual(['s1']);
  });

  it('a query that fails to parse as FTS5 throws, not silently masks (sanity check on quoting)', async () => {
    // If we ever regress quoting, an unquoted `(` would yield an FTS5 syntax
    // error. We assert the helper produces well-formed output instead, by
    // checking that the same input runs cleanly.
    const db = await freshDb();
    await seedFts(db, 's1', 'event (sold out) tomorrow');
    await expect(searchIds(db, '(sold')).resolves.toEqual(['s1']);
  });
});
