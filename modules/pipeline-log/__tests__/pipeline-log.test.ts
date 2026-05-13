import { openDatabase, runMigrations, type Database } from '@/modules/storage';
import { migrations } from '@/modules/storage/migrations';
import { provideDatabase } from '@/modules/storage/live-query';

import { startStage, formatErrorSummary } from '../pipeline-log';
import {
  isFirehoseEnabled,
  setFirehoseEnabled,
  initFirehose,
  _resetFirehoseForTests,
} from '../firehose';
import { readRecentEvents, sweepPipelineEvents } from '../storage';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  provideDatabase(db);
  return db;
}

// Persistence is fire-and-forget — the runAsync promise resolves on a
// later microtask. Drain to give it a chance to land before assertions.
async function flushInserts(): Promise<void> {
  // Two ticks: one for the runAsync promise, one for its .then().
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

class ApifyError extends Error {
  constructor(public readonly code: string) {
    super('boom');
    this.name = 'ApifyError';
  }
}

class FetchPostError extends Error {
  constructor(public readonly classification: string) {
    super('boom');
    this.name = 'FetchPostError';
  }
}

beforeEach(() => {
  _resetFirehoseForTests();
});

describe('startStage / done', () => {
  it('writes one done row with no error_summary', async () => {
    await freshDb();
    startStage('ocr', 'src_abc').done({ ocrLength: 5 });
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: 'src_abc',
      stage: 'ocr',
      status: 'done',
      errorSummary: null,
    });
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes one failed row with error_summary = Error.name for plain errors', async () => {
    await freshDb();
    startStage('ocr', 'src_a').failed(new Error('boom — secret in message'));
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.errorSummary).toBe('Error');
  });

  it('writes Error.name + code for sub-classed errors with `code`', async () => {
    await freshDb();
    startStage('url_fetch', 'src_b').failed(new ApifyError('apify-auth'));
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows[0]!.errorSummary).toBe('ApifyError:apify-auth');
  });

  it('writes Error.name + classification for sub-classed errors using `classification`', async () => {
    await freshDb();
    startStage('url_fetch', 'src_c').failed(new FetchPostError('not-found'));
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows[0]!.errorSummary).toBe('FetchPostError:not-found');
  });

  it('does not persist raw err.message', async () => {
    await freshDb();
    startStage('ocr', 'src_d').failed(new Error('SECRET_TOKEN_xyz'));
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows[0]!.errorSummary).not.toContain('SECRET_TOKEN_xyz');
  });
});

describe('idempotency', () => {
  it('done() twice writes only one row', async () => {
    await freshDb();
    const s = startStage('ocr', 'src_e');
    s.done();
    s.done();
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows).toHaveLength(1);
  });

  it('failed() after done() is a no-op', async () => {
    await freshDb();
    const s = startStage('ocr', 'src_f');
    s.done();
    s.failed(new Error('too late'));
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('done');
  });

  it('done() after failed() is a no-op', async () => {
    await freshDb();
    const s = startStage('ocr', 'src_g');
    s.failed(new Error('first'));
    s.done();
    await flushInserts();
    const rows = await readRecentEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
  });
});

describe('formatErrorSummary', () => {
  it('returns Error.name for plain errors', () => {
    expect(formatErrorSummary(new Error('msg'))).toBe('Error');
    expect(formatErrorSummary(new TypeError('msg'))).toBe('TypeError');
  });

  it('returns name:code for errors with code property', () => {
    expect(formatErrorSummary(new ApifyError('apify-auth'))).toBe('ApifyError:apify-auth');
  });

  it('returns name:classification for errors with classification property', () => {
    expect(formatErrorSummary(new FetchPostError('not-found'))).toBe('FetchPostError:not-found');
  });

  it('truncates at 80 chars', () => {
    class HugeError extends Error {
      public readonly classification = 'x'.repeat(200);
      constructor() {
        super();
        this.name = 'HugeError';
      }
    }
    const summary = formatErrorSummary(new HugeError());
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.startsWith('HugeError:')).toBe(true);
  });

  it('handles non-error throwables defensively', () => {
    expect(formatErrorSummary(null)).toBe('Unknown');
    expect(formatErrorSummary(undefined)).toBe('Unknown');
    expect(formatErrorSummary('string error')).toBe('Non-error:string');
    expect(formatErrorSummary(42)).toBe('Non-error:number');
  });
});

describe('firehose gating', () => {
  it('does not log when flag is off', async () => {
    await freshDb();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(isFirehoseEnabled()).toBe(false);
      startStage('ocr', 'src_h').done({ ocrLength: 5 });
      await flushInserts();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a formatted line when flag is on (in __DEV__)', async () => {
    await freshDb();
    await setFirehoseEnabled(true);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      startStage('ocr', 'src_i').done({ ocrLength: 5, ocrText: 'hello' });
      await flushInserts();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]![0] as string;
      expect(line).toContain('[pipeline] ocr done');
      expect(line).toContain('source=src_i');
      expect(line).toContain('ocrLength=5');
      expect(line).toContain('ocrText="hello"');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not log when __DEV__ is false even if flag is on (hard gate)', async () => {
    await freshDb();
    await setFirehoseEnabled(true);
    const g = globalThis as { __DEV__?: boolean };
    const prev = g.__DEV__;
    g.__DEV__ = false;
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      startStage('ocr', 'src_j').done({ ocrLength: 5 });
      await flushInserts();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      g.__DEV__ = prev;
      spy.mockRestore();
    }
  });

  it('truncates long string values at 500 chars and escapes inner quotes', async () => {
    await freshDb();
    await setFirehoseEnabled(true);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const big = 'a'.repeat(600);
      startStage('ocr', 'src_k').done({ ocrText: big, withQuote: 'he said "hi"' });
      await flushInserts();
      const line = spy.mock.calls[0]![0] as string;
      // Truncated value carries a trailing ellipsis but never the full 600 chars.
      expect(line).toContain('…');
      expect(line).not.toContain('a'.repeat(501));
      expect(line).toContain('withQuote="he said \\"hi\\""');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('firehose flag persistence', () => {
  it('round-trips through the meta table', async () => {
    const db = await freshDb();
    await setFirehoseEnabled(true);
    expect(isFirehoseEnabled()).toBe(true);
    _resetFirehoseForTests();
    expect(isFirehoseEnabled()).toBe(false);
    await initFirehose(db);
    expect(isFirehoseEnabled()).toBe(true);
  });
});

describe('sweepPipelineEvents', () => {
  it('keeps only the most recent N rows globally', async () => {
    const db = await freshDb();
    for (let i = 0; i < 20; i++) {
      startStage('ocr', `src_${i}`).done();
    }
    await flushInserts();
    await sweepPipelineEvents(5, db);
    const rows = await readRecentEvents(100, db);
    expect(rows).toHaveLength(5);
    // Newest first; the last 5 source ids were src_15..src_19.
    expect(rows.map((r) => r.sourceId)).toEqual([
      'src_19',
      'src_18',
      'src_17',
      'src_16',
      'src_15',
    ]);
  });
});
