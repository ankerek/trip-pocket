// SQLite read/write for pipeline_events. Inserts are fire-and-forget — the
// caller never awaits, and an insert error surfaces only as a console.warn
// so a failed debug row can never affect the pipeline it's instrumenting.

import type { Database } from '@/modules/storage';
import { getDatabaseHandle, notifyChange } from '@/modules/storage';

export type PipelineEventRow = {
  id: number;
  sourceId: string | null;
  stage: string;
  status: 'done' | 'failed';
  occurredAt: string;
  durationMs: number;
  errorSummary: string | null;
};

export type PersistArgs = {
  sourceId: string | null;
  stage: string;
  status: 'done' | 'failed';
  occurredAt: string;
  durationMs: number;
  errorSummary: string | null;
};

const RETENTION_LIMIT = 1000;

/**
 * Schedule an insert without awaiting it. Caller stays synchronous; an insert
 * failure logs a warning and is otherwise swallowed.
 */
export function persistEvent(args: PersistArgs, db?: Database): void {
  const handle = db ?? getDatabaseHandle();
  if (!handle) {
    // Pre-init or test posture. Nothing to do; the firehose path still runs.
    return;
  }
  void handle
    .runAsync(
      `INSERT INTO pipeline_events
         (source_id, stage, status, occurred_at, duration_ms, error_summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      args.sourceId,
      args.stage,
      args.status,
      args.occurredAt,
      args.durationMs,
      args.errorSummary,
    )
    .then(() => {
      notifyChange('pipeline_events');
    })
    .catch((err) => {
      console.warn('[pipeline-log] insert failed', err);
    });
}

/**
 * LRU sweep: keep the most recent N rows globally. Run once at cold start.
 */
export async function sweepPipelineEvents(limit = RETENTION_LIMIT, db?: Database): Promise<void> {
  const handle = db ?? getDatabaseHandle();
  if (!handle) return;
  // Deletes everything whose id is at or below the cutoff row. Using id rather
  // than occurred_at gives a stable cutoff even when clocks jump.
  await handle.runAsync(
    `DELETE FROM pipeline_events
      WHERE id <= COALESCE(
        (SELECT id FROM pipeline_events ORDER BY id DESC LIMIT 1 OFFSET ?),
        0
      )`,
    limit,
  );
}

/**
 * Read the most recent N rows for the in-app stream. Newest first.
 */
export async function readRecentEvents(limit: number, db?: Database): Promise<PipelineEventRow[]> {
  const handle = db ?? getDatabaseHandle();
  if (!handle) return [];
  const rows = await handle.getAllAsync<{
    id: number;
    source_id: string | null;
    stage: string;
    status: 'done' | 'failed';
    occurred_at: string;
    duration_ms: number;
    error_summary: string | null;
  }>(
    `SELECT id, source_id, stage, status, occurred_at, duration_ms, error_summary
       FROM pipeline_events
      ORDER BY id DESC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    stage: r.stage,
    status: r.status,
    occurredAt: r.occurred_at,
    durationMs: r.duration_ms,
    errorSummary: r.error_summary,
  }));
}

/**
 * Delete every row. Used by the "Clear log" button.
 */
export async function clearPipelineEvents(db?: Database): Promise<void> {
  const handle = db ?? getDatabaseHandle();
  if (!handle) return;
  await handle.runAsync('DELETE FROM pipeline_events');
  notifyChange('pipeline_events');
}
