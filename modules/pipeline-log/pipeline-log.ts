// Core: `startStage(stage, sourceId?)` returns a Stage handle that records
// start time, then on done/failed emits three things:
//   1. A persisted row in `pipeline_events` (fire-and-forget; no content).
//   2. A Metro firehose line (dev-only, flag-gated; full content allowed).
//   3. The existing Sentry breadcrumb / captureException posture from the
//      previous `lib/observability/breadcrumbs.ts` — same gating, same tags.
//
// `done`/`failed` are idempotent: once settled, further calls are no-ops.

import * as Sentry from '@sentry/react-native';

import { logToFirehose } from './firehose';
import { persistEvent } from './storage';

export type PipelineStage =
  | 'share_import'
  | 'url_share_import'
  | 'storage'
  | 'url_fetch'
  | 'image_download'
  | 'ocr'
  | 'extraction'
  | 'enrichment'
  | 'trip_assign';

export interface Stage {
  done(extra?: Record<string, unknown>): void;
  failed(err: unknown): void;
}

const ERROR_SUMMARY_MAX_LEN = 80;

export function startStage(stage: PipelineStage, sourceId?: string): Stage {
  const startMs = Date.now();
  const sid = sourceId ?? null;
  let settled = false;

  return {
    done(extra?: Record<string, unknown>): void {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startMs;
      const occurredAt = new Date().toISOString();

      persistEvent({
        sourceId: sid,
        stage,
        status: 'done',
        occurredAt,
        durationMs,
        errorSummary: null,
      });

      logToFirehose({
        stage,
        status: 'done',
        sourceId: sid,
        durationMs,
        errorSummary: null,
        extra: extra ?? {},
      });

      // eslint-disable-next-line no-undef
      if (typeof __DEV__ !== 'undefined' && __DEV__) return;
      Sentry.addBreadcrumb({ category: `pipeline.${stage}`, level: 'info' });
    },

    failed(err: unknown): void {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startMs;
      const occurredAt = new Date().toISOString();
      const errorSummary = formatErrorSummary(err);

      persistEvent({
        sourceId: sid,
        stage,
        status: 'failed',
        occurredAt,
        durationMs,
        errorSummary,
      });

      logToFirehose({
        stage,
        status: 'failed',
        sourceId: sid,
        durationMs,
        errorSummary,
        extra: {},
      });

      // eslint-disable-next-line no-undef
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        // eslint-disable-next-line no-console
        console.error(`[pipeline.${stage}]`, err);
        return;
      }
      Sentry.addBreadcrumb({ category: `pipeline.${stage}.error`, level: 'error' });
      Sentry.captureException(err, { tags: { pipeline_stage: stage } });
    },
  };
}

// `<Error.name>` for plain errors, `<Error.name>:<code>` when the error
// exposes a closed-vocabulary classifier (either `.code` or `.classification`,
// which is what the in-app sub-classed errors use today). The raw `.message`
// is never persisted — see spec §Storage/schema.
export function formatErrorSummary(err: unknown): string {
  if (err === null || err === undefined) return 'Unknown';
  if (typeof err !== 'object') {
    const summary = `Non-error:${typeof err}`;
    return truncate(summary, ERROR_SUMMARY_MAX_LEN);
  }
  const e = err as { name?: unknown; code?: unknown; classification?: unknown };
  const name = typeof e.name === 'string' && e.name.length > 0 ? e.name : 'Error';
  const code = pickCode(e.code) ?? pickCode(e.classification);
  const summary = code === null ? name : `${name}:${code}`;
  return truncate(summary, ERROR_SUMMARY_MAX_LEN);
}

function pickCode(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
