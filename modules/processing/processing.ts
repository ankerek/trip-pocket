import type { Database } from '@/modules/storage';
import { notifyChange } from '@/modules/storage';
import { getExtractor } from '@/modules/extraction';

export type OcrRunner = (imagePath: string) => Promise<string>;

export type Processor = {
  enqueueOcr(screenshotId: string): void;
  runOcrSweep(): Promise<void>;
  runStartupRecovery(): Promise<void>;
  /**
   * Test-only. Resolves once the in-memory queue has fully drained.
   * Production code should not need to call this — work happens in the
   * background and the live-query layer surfaces results.
   */
  _awaitIdle(): Promise<void>;
};

export type CreateProcessorOptions = {
  db: Database;
  ocr: OcrRunner;
  maxRetries?: number;
  now?: () => string;
};

export function createProcessor(opts: CreateProcessorOptions): Processor {
  const maxRetries = opts.maxRetries ?? 3;
  const getNow = opts.now ?? (() => new Date().toISOString());

  let chain: Promise<void> = Promise.resolve();
  const inflight = new Set<string>();
  const retryCount = new Map<string, number>();

  function enqueueOcr(id: string): void {
    if (inflight.has(id)) return;
    inflight.add(id);
    chain = chain.then(async () => {
      try {
        // Loop here (rather than re-enqueuing) so all retries for one id
        // happen contiguously inside this chain segment. That keeps the
        // queue strictly serial across ids and avoids the dedup juggling
        // that re-enqueue mid-chain would require.
        while (true) {
          const result = await processOne(id);
          if (!result.retry) break;
        }
      } finally {
        inflight.delete(id);
        retryCount.delete(id);
      }
    });
  }

  async function processOne(id: string): Promise<{ retry: boolean }> {
    const row = await opts.db.getFirstAsync<{ file_path: string }>(
      `SELECT file_path FROM screenshots WHERE id = ? AND deleted_at IS NULL`,
      id,
    );
    if (!row) return { retry: false };

    try {
      const text = await opts.ocr(row.file_path);
      await opts.db.runAsync(
        `UPDATE screenshots
            SET ocr_text = ?, ocr_status = 'done', updated_at = ?
          WHERE id = ?`,
        text,
        getNow(),
        id,
      );
      notifyChange('screenshots');
      // Chain into AI extraction. Non-blocking; the extraction queue runs
      // in its own Promise chain. No-op when no extractor is provisioned
      // (Jest, share extension, web).
      getExtractor()?.enqueueExtraction(id);
      return { retry: false };
    } catch {
      const next = (retryCount.get(id) ?? 0) + 1;
      retryCount.set(id, next);
      if (next < maxRetries) return { retry: true };
      await opts.db.runAsync(
        `UPDATE screenshots
            SET ocr_status = 'failed', updated_at = ?
          WHERE id = ?`,
        getNow(),
        id,
      );
      notifyChange('screenshots');
      return { retry: false };
    }
  }

  async function runOcrSweep(): Promise<void> {
    // Mid-session sweeps deliberately skip 'failed' rows: a permanently
    // broken file should not burn a Vision call on every foreground. The
    // retry-on-relaunch path is runStartupRecovery (called once per process).
    const rows = await opts.db.getAllAsync<{ id: string }>(
      `SELECT id FROM screenshots
        WHERE ocr_status = 'pending' AND deleted_at IS NULL
     ORDER BY captured_at ASC`,
    );
    for (const r of rows) enqueueOcr(r.id);
  }

  async function runStartupRecovery(): Promise<void> {
    await opts.db.runAsync(
      `UPDATE screenshots
          SET ocr_status = 'pending', updated_at = ?
        WHERE ocr_status = 'failed' AND deleted_at IS NULL`,
      getNow(),
    );
  }

  async function _awaitIdle(): Promise<void> {
    // The chain reference grows each enqueue. Awaiting any one chain reference
    // resolves only at that segment, so loop until no new work has been added
    // during the wait.
    while (true) {
      const before = chain;
      await before;
      if (chain === before) return;
    }
  }

  return { enqueueOcr, runOcrSweep, runStartupRecovery, _awaitIdle };
}
