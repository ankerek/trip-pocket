import { openDatabase, runMigrations, insertSource, type Database } from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import { createExtractor, type ExtractionRunner, type VisualExtractionRunner } from '../extraction';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

const NOW = '2026-05-16T10:00:00.000Z';

const OK_RESULT = { places: [], model: 'gemini' };

describe('extractor — strategy dispatch', () => {
  it('routes ocrTextLLM rows through the text runner', async () => {
    const db = await freshDb();
    const text = jest.fn<ReturnType<ExtractionRunner>, Parameters<ExtractionRunner>>(
      async () => OK_RESULT,
    );
    const visual = jest.fn<ReturnType<VisualExtractionRunner>, Parameters<VisualExtractionRunner>>(
      async () => OK_RESULT,
    );

    await insertSource(db, {
      id: 'a',
      tripId: null,
      filePath: '/tmp/a.jpg',
      contentHash: 'h-a',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'ocrTextLLM',
    });
    await db.runAsync(`UPDATE sources SET ocr_status='done', ocr_text='hello' WHERE id='a'`);

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    e.enqueueExtraction('a');
    await e._awaitIdle();

    expect(text).toHaveBeenCalledWith('hello');
    expect(visual).not.toHaveBeenCalled();
  });

  it('routes vision rows through the visual runner with file_path + caption=null', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'v',
      tripId: null,
      filePath: '/tmp/v.jpg',
      contentHash: 'h-v',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'vision',
    });
    // Note: ocr_status stays 'pending' for vision rows; the orchestrator
    // must NOT short-circuit on empty ocr_text.

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    e.enqueueExtraction('v');
    await e._awaitIdle();

    expect(text).not.toHaveBeenCalled();
    expect(visual).toHaveBeenCalledTimes(1);
    expect(visual).toHaveBeenCalledWith({
      sourceId: 'v',
      extractionStrategy: 'vision',
      filePath: '/tmp/v.jpg',
      caption: null,
    });
  });

  it('routes captionPlusVision rows through the visual runner with caption', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'cv',
      kind: 'url',
      platform: 'instagram',
      tripId: null,
      filePath: '/tmp/cv.jpg',
      url: 'https://instagram.com/p/xyz',
      contentHash: 'h-cv',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'captionPlusVision',
    });
    await db.runAsync(`UPDATE sources SET caption='Lunch at Maru' WHERE id='cv'`);

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    e.enqueueExtraction('cv');
    await e._awaitIdle();

    expect(visual).toHaveBeenCalledWith({
      sourceId: 'cv',
      extractionStrategy: 'captionPlusVision',
      filePath: '/tmp/cv.jpg',
      caption: 'Lunch at Maru',
    });
  });

  it('fails permanently when a vision row hits the orchestrator without an extractVisual runner wired', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'unwired',
      tripId: null,
      filePath: '/tmp/unwired.jpg',
      contentHash: 'h-unwired',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'vision',
    });

    // No extractVisual provided.
    const e = createExtractor({ db, extract: text, ownerId: 'owner-1' });
    e.enqueueExtraction('unwired');
    await e._awaitIdle();

    const row = await db.getFirstAsync<{ extraction_status: string }>(
      `SELECT extraction_status FROM sources WHERE id='unwired'`,
    );
    expect(row?.extraction_status).toBe('failed');
  });

  it('treats NULL extraction_strategy as legacy ocrTextLLM (back-compat for pre-migration rows)', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    // Insert without specifying strategy → column stays NULL.
    await insertSource(db, {
      id: 'legacy',
      tripId: null,
      filePath: '/tmp/legacy.jpg',
      contentHash: 'h-legacy',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
    });
    await db.runAsync(
      `UPDATE sources SET ocr_status='done', ocr_text='legacy text' WHERE id='legacy'`,
    );

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    e.enqueueExtraction('legacy');
    await e._awaitIdle();

    expect(text).toHaveBeenCalledWith('legacy text');
    expect(visual).not.toHaveBeenCalled();
  });

  it('extraction sweep picks up vision rows with ocr_status=pending', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'pending-vision',
      tripId: null,
      filePath: '/tmp/pv.jpg',
      contentHash: 'h-pv',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'vision',
    });
    // ocr_status stays 'pending' (default) — sweep should still pick this up.

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    await e.runExtractionSweep();
    await e._awaitIdle();

    expect(visual).toHaveBeenCalledTimes(1);
  });

  it('extraction sweep does NOT pick up ocrTextLLM rows still in ocr_status=pending', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'pending-ocr',
      tripId: null,
      filePath: '/tmp/po.jpg',
      contentHash: 'h-po',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'ocrTextLLM',
    });
    // ocr_status stays 'pending' — sweep must NOT pick this up yet.

    const e = createExtractor({ db, extract: text, ownerId: 'owner-1' });
    await e.runExtractionSweep();
    await e._awaitIdle();

    expect(text).not.toHaveBeenCalled();
  });

  it('extraction sweep skips vision rows that have no file_path yet (URL source waiting on fetch)', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'waiting-url',
      kind: 'url',
      platform: 'instagram',
      tripId: null,
      filePath: null, // worker fetch hasn't completed yet
      url: 'https://instagram.com/p/abc',
      contentHash: 'h-w',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'vision',
    });

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    await e.runExtractionSweep();
    await e._awaitIdle();

    expect(visual).not.toHaveBeenCalled();
  });

  it('routes videoPlusCaption rows through the visual runner', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'vid',
      kind: 'url',
      platform: 'instagram',
      tripId: null,
      filePath: '/tmp/cover.jpg',
      url: 'https://instagram.com/reel/X',
      caption: 'great spot',
      contentHash: 'h-vid',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'videoPlusCaption',
    });

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    e.enqueueExtraction('vid');
    await e._awaitIdle();

    expect(text).not.toHaveBeenCalled();
    expect(visual).toHaveBeenCalledWith({
      sourceId: 'vid',
      extractionStrategy: 'videoPlusCaption',
      filePath: '/tmp/cover.jpg',
      caption: 'great spot',
    });
  });

  it('sweep picks up videoPlusCaption rows once the cover is present (no OCR wait)', async () => {
    const db = await freshDb();
    const text = jest.fn(async () => OK_RESULT);
    const visual = jest.fn(async () => OK_RESULT);

    await insertSource(db, {
      id: 'vid-sweep',
      kind: 'url',
      platform: 'tiktok',
      tripId: null,
      filePath: '/tmp/c.jpg',
      url: 'https://tiktok.com/@x/video/1',
      contentHash: 'h-vs',
      origin: 'share',
      capturedAt: NOW,
      ownerId: 'owner-1',
      extractionStrategy: 'videoPlusCaption',
    });

    const e = createExtractor({ db, extract: text, extractVisual: visual, ownerId: 'owner-1' });
    await e.runExtractionSweep();
    await e._awaitIdle();

    expect(visual).toHaveBeenCalledTimes(1);
  });
});
