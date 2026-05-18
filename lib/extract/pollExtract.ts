// Client for the worker's POST /extract + GET /extract/:contentHash. Driven
// by runForegroundIngest on every foreground for URL sources that haven't
// reached extraction_status='done'. On a cache hit (the share-extension
// pre-warm finished while the user was tapping back), the first GET returns
// status='done' immediately; on cold-open or when the prewarm never fired
// (offline-at-share, missing RC id), `triggerOnMissing` POSTs to kick off
// the pipeline and the loop polls until done or timeout.

import * as Sentry from '@sentry/react-native';

export type ExtractedPlace = {
  // Extraction fields (always present).
  name: string;
  city: string;
  address: string;
  category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';
  country_code: string;
  // Enrichment fields populated by the worker orchestrator's Google
  // Places + bulk-blurb step (Option B). All optional because (a) the
  // place may not have matched Google Places (`blurb_status='not-found'`)
  // and (b) the bulk-blurb call may have lost a slot (`blurb_status='failed'`).
  external_place_id?: string | null;
  formatted_address?: string | null;
  photo_name?: string | null;
  display_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rating?: number | null;
  price_level?: number | null;
  external_url?: string | null;
  editorial_summary?: string | null;
  blurb?: string | null;
  blurb_status?: 'ok' | 'empty' | 'failed' | 'not-found' | null;
};

export type ExtractState =
  | { status: 'pending'; contentHash?: string; startedAt?: string }
  | {
      status: 'partial';
      contentHash?: string;
      caption?: string;
      coverUrl?: string;
      videoPresent?: boolean;
      startedAt?: string;
    }
  | {
      status: 'done';
      contentHash?: string;
      caption?: string;
      coverUrl?: string;
      videoPresent?: boolean;
      places: ExtractedPlace[];
      model: string;
    }
  | { status: 'error'; contentHash?: string; error?: string }
  | { status: 'missing'; contentHash?: string }
  | { status: 'timeout'; contentHash?: string };

export type PollExtractOptions = {
  contentHash: string;
  rcUserId: string;
  workerBase: string;
  maxAttempts: number;
  delayMs: number;
  /** When true and GET returns 404, POST /extract once and re-poll. */
  triggerOnMissing?: boolean;
  /** Required when triggerOnMissing is true. */
  url?: string;
  /**
   * Fires once, the first time the poll observes `status === 'partial'`.
   * Lets callers persist the early `coverUrl` + `caption` to the local
   * source row so the triage card stops showing a blank placeholder while
   * the extract + enrich stages are still running. Awaited inline — keep
   * the handler short or fire-and-forget the slow parts yourself; a slow
   * handler will postpone the next GET by its own duration.
   */
  onPartial?: (state: Extract<ExtractState, { status: 'partial' }>) => Promise<void> | void;
};

/**
 * Mirrors the orchestrator's STALE_PENDING_MS (workers/extract-proxy/src/
 * orchestrator.ts). If a pending/partial state in KV is older than this,
 * the worker isolate that owned the pipeline is presumed dead (waitUntil
 * budget exhausted, or orchestrate returned early after a transient Gemini
 * failure) and a new POST will trigger the orchestrator's stale-pending
 * re-run. Keep these two constants in lockstep.
 */
const STALE_PENDING_MS = 90 * 1000;

async function postExtract(opts: PollExtractOptions): Promise<void> {
  if (!opts.url) return;
  await fetch(`${opts.workerBase}/extract`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-RC-User-Id': opts.rcUserId,
    },
    body: JSON.stringify({
      contentHash: opts.contentHash,
      kind: 'url',
      url: opts.url,
    }),
  });
}

function isStaleStartedAt(startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > STALE_PENDING_MS;
}

export async function pollExtract(opts: PollExtractOptions): Promise<ExtractState> {
  const getUrl = `${opts.workerBase}/extract/${opts.contentHash}`;
  let missingTriggered = false;
  let staleTriggered = false;
  let partialFired = false;
  const start = Date.now();

  // Trace the share→extract lifecycle as Sentry breadcrumbs. When something
  // user-visible breaks (e.g. a captureException downstream), the breadcrumb
  // trail tells us *what stage* the share got to before failing — without
  // it, all we have is "the screen showed an error".
  Sentry.addBreadcrumb({
    category: 'extract.poll',
    level: 'info',
    message: 'pollExtract start',
    data: {
      contentHash: opts.contentHash,
      urlHost: hostOf(opts.url),
      triggerOnMissing: !!opts.triggerOnMissing,
    },
  });

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const resp = await fetch(getUrl, {
      method: 'GET',
      headers: { 'X-RC-User-Id': opts.rcUserId },
    });

    if (resp.status === 404) {
      if (opts.triggerOnMissing && opts.url && !missingTriggered) {
        missingTriggered = true;
        Sentry.addBreadcrumb({
          category: 'extract.poll',
          level: 'info',
          message: 'POST /extract (missing)',
          data: { contentHash: opts.contentHash, attempt },
        });
        await postExtract(opts);
        if (attempt < opts.maxAttempts - 1) await sleep(opts.delayMs);
        continue;
      }
      return finish(opts.contentHash, { status: 'missing', contentHash: opts.contentHash }, start);
    }

    let body: ExtractState;
    try {
      body = (await resp.json()) as ExtractState;
    } catch {
      return finish(
        opts.contentHash,
        { status: 'error', contentHash: opts.contentHash, error: 'non-json-response' },
        start,
      );
    }

    if (body.status === 'done') return finish(opts.contentHash, body, start);
    if (body.status === 'error') return finish(opts.contentHash, body, start);
    if (body.status === 'pending' || body.status === 'partial') {
      // First partial transition: notify caller so it can persist the
      // early coverUrl + caption before extract/enrich finish. Once-only
      // (later partial polls won't re-fire) so the caller can write
      // without idempotency checks. Caller errors are caught — a failed
      // cover download must not break the poll loop itself.
      if (body.status === 'partial' && !partialFired && opts.onPartial) {
        partialFired = true;
        try {
          await opts.onPartial(body);
        } catch (err) {
          Sentry.addBreadcrumb({
            category: 'extract.poll',
            level: 'warning',
            message: 'onPartial handler threw',
            data: {
              contentHash: opts.contentHash,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      // Stale-state recovery: if the worker wrote this state more than
      // STALE_PENDING_MS ago, the pipeline isolate is presumed dead.
      // POST /extract once to wake the orchestrator's stale-pending
      // re-run path; subsequent polls then see the new attempt's state.
      if (
        opts.triggerOnMissing &&
        opts.url &&
        !staleTriggered &&
        isStaleStartedAt(body.startedAt)
      ) {
        staleTriggered = true;
        Sentry.addBreadcrumb({
          category: 'extract.poll',
          level: 'warning',
          message: 'POST /extract (stale-recovery)',
          data: { contentHash: opts.contentHash, attempt, startedAt: body.startedAt },
        });
        await postExtract(opts);
      }
      if (attempt < opts.maxAttempts - 1) await sleep(opts.delayMs);
      continue;
    }
    // Schema drift safety: any unexpected status string ends the poll
    // rather than looping forever.
    return finish(
      opts.contentHash,
      { status: 'error', contentHash: opts.contentHash, error: 'unknown-status' },
      start,
    );
  }
  return finish(opts.contentHash, { status: 'timeout', contentHash: opts.contentHash }, start);
}

// Final-breadcrumb sink. Centralised so every exit path leaves the same
// shape ("pollExtract end" + status + duration) and we don't forget one.
function finish(contentHash: string, state: ExtractState, start: number): ExtractState {
  Sentry.addBreadcrumb({
    category: 'extract.poll',
    level: state.status === 'error' || state.status === 'timeout' ? 'warning' : 'info',
    message: `pollExtract end (${state.status})`,
    data: {
      contentHash,
      duration_ms: Date.now() - start,
      error: state.status === 'error' ? state.error : undefined,
    },
  });
  return state;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
