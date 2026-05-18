/**
 * Structured logger for the extract-proxy worker.
 *
 * One JSON line per call lands in Workers Logs (and `wrangler tail`). The
 * shape is stable so you can grep / filter in the dashboard:
 *
 *   { event, stage?, status?, contentHash?, source?, mode?, duration_ms?,
 *     error_code?, ... }
 *
 * On error events we also `Sentry.captureException` with the same fields
 * promoted to tags + context. Sentry is a no-op when no DSN is configured
 * (dev/test), so this module is safe to import anywhere.
 *
 * Why a single helper instead of scattered console.log: a) the schema stays
 * stable, b) every error gets routed to Sentry without each call-site having
 * to remember to do it, c) you can later swap the sink (Logpush → R2, or
 * Analytics Engine writes) by editing one file.
 */
import * as Sentry from '@sentry/cloudflare';

export type Stage = 'fetch-post' | 'extract' | 'enrich' | 'blurb' | 'orchestrate';
export type ExtractMode = 'video' | 'vision' | 'text';

export type LogFields = {
  /** Action name. Use snake_case so it filters cleanly in Workers Logs. */
  event:
    | 'stage_start'
    | 'stage_done'
    | 'stage_warn'
    | 'stage_error'
    | 'share_received'
    | 'share_cache_hit'
    | 'orchestrate_skip'
    | 'orchestrate_stale_pending'
    | 'orchestrate_early_done'
    | 'orchestrate_extract_transient'
    | 'orchestrate_fetch_transient'
    | 'blurb_deferred';
  stage?: Stage;
  /** Hex content_hash — doubles as the per-share trace id. */
  contentHash?: string;
  /** 'instagram' | 'tiktok' | 'unknown' — derived from the URL or fetched.platform. */
  source?: string;
  /** Only meaningful for stage=extract. */
  mode?: ExtractMode;
  duration_ms?: number;
  /** Stable short token (e.g. 'video-fetch-403'). NOT a free-form message. */
  error_code?: string;
  /** Extra dimensions — kept narrow on purpose. */
  cache_kind?: 'og' | 'apify';
  /** Cached-state status when emitting share_cache_hit / orchestrate_skip. */
  status?: 'pending' | 'partial' | 'done' | 'error';
  /** Counts surfaced by enrich/blurb. Useful for dashboarding match rates. */
  place_count?: number;
  matched_count?: number;
  blurb_count?: number;
  /** Carousel-slide diagnostic fields. */
  slide_idx?: number;
  slide_count?: number;
  slide_error?: string;
  /** Place name on per-place enrich warnings (NOT user text, just the LLM-emitted name). */
  place_name?: string;
  /** Free-form short detail string (e.g. concatenated fallback-mode error codes). */
  detail?: string;
};

function emit(fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  if (fields.event === 'stage_error') {
    console.error(line);
  } else if (fields.event === 'stage_warn' || fields.event === 'orchestrate_stale_pending') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Emit one structured log line. Use for normal-path events
 * (stage_start, stage_done, share_received, cache hits, etc).
 */
export function logEvent(fields: LogFields): void {
  emit(fields);
}

/**
 * Emit a stage_error log line AND forward the underlying exception to
 * Sentry with the same fields promoted to tags + context. Use this at
 * every catch-site that owns the error (i.e. doesn't rethrow into a
 * caller that will log it again).
 *
 * - `stage`, `source`, `mode`, `error_code` become Sentry tags so they're
 *   filterable in the Issues view.
 * - `contentHash` and any extra fields land in a `share` context so the
 *   full picture is on the event page.
 */
export function logStageError(
  err: unknown,
  fields: Omit<LogFields, 'event'> & { stage: Stage },
): void {
  const error_code =
    fields.error_code ?? (err instanceof Error ? err.message : String(err)).slice(0, 200);
  emit({ event: 'stage_error', ...fields, error_code });

  const tags: Record<string, string> = { stage: fields.stage };
  if (fields.source) tags.source = fields.source;
  if (fields.mode) tags.mode = fields.mode;
  if (fields.error_code) tags.error_code = fields.error_code;

  try {
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      scope.setContext('share', {
        contentHash: fields.contentHash,
        duration_ms: fields.duration_ms,
        cache_kind: fields.cache_kind,
      });
      // Sentry expects an Error-like; wrap strings/numbers so the stack
      // trace isn't lost when the upstream code threw a primitive.
      const value = err instanceof Error ? err : new Error(error_code);
      Sentry.captureException(value);
    });
  } catch {
    // Sentry must never break the pipeline. Swallow — we already logged.
  }
}
