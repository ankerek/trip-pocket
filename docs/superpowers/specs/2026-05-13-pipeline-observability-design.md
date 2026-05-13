# Pipeline observability — design

**Status:** draft (2026-05-13).
**Targets:** v0.4 — developer-facing observability for the import → OCR → extraction → enrichment pipeline. Sits next to (not inside) the draft product-analytics spec at [`2026-05-12-telemetry-design.md`](./2026-05-12-telemetry-design.md), which covers PostHog funnels and Sentry perf traces.

## Why

The capture pipeline has gone from "image arrives → OCR → places" to a branching multi-stage flow:

```
share extension → pending import → main app ingest → storage row → url_fetch
  → image_download → ocr (×N for carousels) → extraction → enrichment → trip_assign
```

When a real share goes wrong ("I shared a carousel and it landed in the inbox with zero places"), there is no way to ask the system "what happened to that source?" Today's signals are partial and scattered:

- `sources.ocr_status` / `sources.extraction_status` show the **current** state of each stage (`pending | done | failed`). No history, no timings, no error context.
- `lib/observability/breadcrumbs.ts` emits Sentry breadcrumbs in production. Dev builds get a `console.error` for failures and silence for successes. No per-source view; no way to look at "yesterday's TestFlight capture."
- The worker has rich `console.log`/`console.error` instrumentation — readable via `wrangler tail`, but in a different process and only when the user happens to be tailing.

The product-analytics spec (`2026-05-12-telemetry-design.md`) handles a different problem: aggregate funnels and p95 latency across users via PostHog + Sentry. That's "is the pipeline healthy in aggregate?"; this spec is "what happened to this one source?" Disjoint concerns; disjoint storage.

## Scope

**In scope:**
- New module `modules/pipeline-log/` with a `startStage(stage, sourceId?)` API used by every pipeline stage.
- New `pipeline_events` SQLite table (one migration), holding minimal per-stage outcome rows. No content.
- Migration of the ~9 existing `pipelineStep` / `pipelineError` call sites in `modules/capture`, `modules/processing`, `modules/extraction`, `modules/enrichment` to the new API.
- `url_fetch` stage split into `url_fetch` (worker call) + `image_download` (cover + slide downloads).
- Dev-build-only **Metro firehose**: when toggled on, every stage transition logs a structured one-liner to `console.log` with full content props (caption, OCR text, places JSON). Off by default; gated by `__DEV__` AND a Settings toggle.
- **Worker debug echo** on `/fetch-post`: the worker adds a small `_debug` object to its success response carrying the route it took (og-only vs Apify-carousel vs Apify-fallback), the og: outcome, the Apify outcome, and the cache hit/miss. The phone client unpacks `_debug` and forwards it into the `url_fetch` stage's `extra` so the firehose shows worker-side dispatch decisions without context-switching to `wrangler tail`.
- In-app **Pipeline log** screen under `Settings → Diagnostics`, visible in both dev and TestFlight builds. Renders the most recent 200 rows, grouped by `source_id`, with live updates. Includes a "Clear log" button.
- LRU retention sweep keeping the most recent 1000 rows globally, run once per cold start.
- Removal of `lib/observability/breadcrumbs.ts` once call sites are migrated.

**Not in scope:**
- Aggregate metrics, funnels, p95 dashboards — that's the PostHog/Sentry telemetry spec.
- Cross-device shared pipeline history (would need a backend).
- Persisting content alongside the events. Firehose is the only path for content, and it's local-Metro-console-only.
- Tracing pipeline activity that happens inside the share extension's own process (it can't write to the same DB context easily, and the extension is short-lived). The main-app `share_import` / `url_share_import` stages run when the app picks up the pending import — those are captured.
- Worker-side events. The Cloudflare Worker stays on its existing `console.log`/`wrangler tail` posture; it's a different process and adding a bridge isn't worth it for the on-device debug use case.
- Per-source dedicated UI (e.g., a "Pipeline history" tab on source-detail). The global Diagnostics stream is the only UI surface for v1.

## Module shape

```
modules/pipeline-log/
  index.ts            # public API barrel
  pipeline-log.ts     # core: startStage factory, Sentry breadcrumb wiring
  storage.ts          # SQLite read/write for pipeline_events; retention sweep
  firehose.ts         # Metro console formatter; flag read/write
  index.test.ts       # unit tests
```

Public API:

```ts
// modules/pipeline-log/index.ts
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

export function startStage(stage: PipelineStage, sourceId?: string): Stage;

export function isFirehoseEnabled(): boolean;
export function setFirehose(enabled: boolean): Promise<void>;

export function initPipelineLog(): Promise<void>; // reads firehose flag from meta table
export function sweepPipelineEvents(): Promise<void>; // LRU trim, called from startup recovery
```

The `Stage` handle holds the start timestamp and stage metadata. `done`/`failed` are idempotent — second call on the same handle is a no-op (so weird retry loops that double-call don't double-emit). Both methods are synchronous from the caller's perspective; the SQLite insert is fire-and-forget (errors are `console.warn`'d but never surface to the pipeline).

## Stages + call-site migration

Stage list aligns with the existing `PipelineStage` union, with one addition (`image_download`) split out of `url_fetch`.

| Stage | Where it lives | Why split |
|---|---|---|
| `share_import` | `modules/capture/importImage.ts` | unchanged |
| `url_share_import` | `modules/capture/importUrl.ts` | unchanged |
| `storage` | `importImage.ts` + `importUrl.ts` | unchanged |
| `url_fetch` | `modules/processing/processing.ts` | now covers **only** the `POST /fetch-post` worker call |
| `image_download` | `modules/processing/processing.ts` | new — covers downloading cover + slides for URL sources |
| `ocr` | `modules/processing/processing.ts` | unchanged |
| `extraction` | `modules/extraction/extraction.ts` | unchanged |
| `enrichment` | `modules/enrichment/enrichment.ts` | unchanged |
| `trip_assign` | TBD (current breadcrumb call site, will keep) | unchanged |

The `url_fetch` split matters because for carousels the worker call and the multi-image download phase have very different failure modes. Splitting them keeps the in-app stream legible without parsing error messages.

**Call-site pattern (before):**

```ts
pipelineStep('ocr');
try {
  const text = await ocr(filePath);
  // …use text…
} catch (err) {
  pipelineError('ocr', err);
  // …handle failure…
}
```

**Call-site pattern (after):**

```ts
const stage = startStage('ocr', sourceId);
try {
  const text = await ocr(filePath);
  stage.done({ ocrLength: text.length, ocrText: text });
  // …use text…
} catch (err) {
  stage.failed(err);
  // …handle failure…
}
```

The `extra` object is typed loosely (`Record<string, unknown>`). Persistence drops it; the firehose forwards it. This keeps call sites flexible — passing a new field to debug a flaky stage doesn't require a schema change.

**Suggested `extra` per stage** (firehose-only; not persisted):

| Stage | `extra` props |
|---|---|
| `share_import` / `url_share_import` | `kind`, `platform?`, `urlHost?` |
| `storage` | `sourceId`, `tripId?` |
| `url_fetch` | `httpStatus`, `imageUrlsCount`, `captionLength`, `author?`, `caption`, and the `_debug` echo from the worker (route, ogOutcome, apifyOutcome, cacheHit) — see Worker debug echo |
| `image_download` | `requestedCount`, `downloadedCount`, `coverPath` |
| `ocr` | `ocrLength`, `ocrText` |
| `extraction` | `placesCount`, `placesJson`, `model` |
| `enrichment` | `hadPhoto`, `hadAddress`, `hadRating` |
| `trip_assign` | `tripId`, `method` |

Removal: once all call sites are migrated, `lib/observability/breadcrumbs.ts` is deleted along with its re-exports from `lib/observability/index.ts`. The `PipelineStage` type moves to `modules/pipeline-log/`.

## Worker debug echo

The worker's `/fetch-post` endpoint already computes a `route` decision and per-leg outcomes internally (today they're only `console.log`'d for `wrangler tail`). This spec promotes those values to a small `_debug` object on the success response so the phone can include them in the `url_fetch` stage's firehose line.

Success response shape becomes:

```json
{
  "platform": "instagram",
  "permalink": "https://www.instagram.com/p/ABC/",
  "caption": "...",
  "imageUrls": ["..."],
  "author": "...",
  "_debug": {
    "route": "og_then_apify_carousel",
    "ogOutcome": "ok",
    "apifyOutcome": "ok",
    "cacheHit": false
  }
}
```

**Field values** (all closed enums; no free text, no content):

| Field | Values |
|---|---|
| `route` | `og_only` · `og_then_apify_carousel` · `og_then_apify_unknown_efg` · `og_failed_apify_fallback` · `tiktok_og` · `tiktok_oembed` |
| `ogOutcome` | `ok` · `empty_desc` · `empty_image` · `http_429` · `http_4xx` · `http_5xx` · `timeout` · `not_called` |
| `apifyOutcome` | `not_called` · `ok` · `empty` · `carousel_no_children` · `auth` · `rate_limited` · `upstream` · `timeout` · `network` |
| `cacheHit` | `true` · `false` |

**Privacy posture unchanged.** All values are closed enums describing routing decisions — no URLs, no caption text, no actor responses. The worker's existing privacy rule (log status, latency, error class only — never URL or caption) extends naturally: `_debug` carries the same shapes Workers logs already capture, just promoted into the response.

**Backwards compatibility.** Existing consumers (today's phone code) ignore unknown fields, so adding `_debug` is non-breaking. Error responses (`{"error": "..."}`) do not carry `_debug` — the failure case is already legible via HTTP status + the existing `apify-failed apify-<code>` `wrangler tail` line.

**Phone client integration.** `modules/capture/fetchPostFromProxy.ts` extends its zod schema to mark `_debug` optional. The processor's `url_fetch` stage forwards `result._debug` verbatim into `stage.done(...)`'s extra, where the firehose formatter renders it inline:

```
[pipeline] url_fetch done in 587ms source=src_abc123 httpStatus=200 imageUrlsCount=3
  captionLength=128 route=og_then_apify_carousel ogOutcome=ok apifyOutcome=ok cacheHit=false
```

The persisted `pipeline_events` row stays unaffected — `_debug` is firehose-only.

## Storage / schema

One migration: `modules/storage/migrations/0006_pipeline_events.ts`.

```sql
CREATE TABLE pipeline_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('done','failed')),
  occurred_at   TEXT NOT NULL,        -- ISO timestamp, end of stage
  duration_ms   INTEGER NOT NULL,
  error_summary TEXT                  -- "<Error.name>: <truncated message>"
);

CREATE INDEX idx_pipeline_events_source ON pipeline_events(source_id);
CREATE INDEX idx_pipeline_events_occurred ON pipeline_events(occurred_at DESC);
```

**Field rules:**
- `source_id` is **nullable** — share-extension stages emit before a source row exists.
- `occurred_at` is the **end** of the stage. Start time is computable as `occurred_at − duration_ms` if ever needed; storing it separately wastes space at no benefit.
- `error_summary` is `<Error.name>: <first 200 chars of message>` for failures, `NULL` for successes. The 200-char cap is structural — a stack-trace dump can't blow up the column. The full error continues to flow to Sentry / `console.error` independently.
- No content fields (`ocr_text`, `caption`, `places_json`, etc.). No outcome counts (`places_count`, `image_urls_count`, etc.). The in-app stream answers "what stages ran and which failed"; counts are firehose-only.

**Retention:** LRU sweep keeping the most recent 1000 rows globally. At ~9 events per source × heaviest case 100 sources/week ≈ 900 events/week, the cap rotates weekly — long enough to investigate yesterday's bug, short enough to keep the table trivial (estimated ~50 KB at the cap).

Sweep query:

```sql
DELETE FROM pipeline_events
 WHERE id <= (
   SELECT id FROM pipeline_events
   ORDER BY id DESC
   LIMIT 1 OFFSET 1000
 );
```

Runs once per cold start, called from `runStartupRecovery`-time in `app/_layout.tsx`.

**Writes are fire-and-forget** — `stage.done()` / `stage.failed()` schedule the insert via the existing `db.runAsync` but do not `await` it from the caller's perspective. Insert errors are `console.warn`'d. A failure to persist a debug row must never affect the pipeline it's instrumenting.

## Metro firehose

Dev-only verbose logging gated by two conditions:

1. `__DEV__` is true (production builds never log content, regardless of flag state).
2. Firehose flag is on (stored in `meta` table, key `pipeline_firehose`, default `'0'`).

**Settings UI:** new row under `Settings → Diagnostics` (next to the existing Sentry test buttons), a `<Switch>` labeled "Pipeline firehose" with sub-copy "Verbose pipeline logs in Metro (dev builds only)". When `!__DEV__` the row is hidden entirely.

Toggle behavior:
- Updates the in-memory `firehoseEnabled` flag **synchronously**, so the next stage emission honours the new state immediately — no app relaunch.
- Schedules a write of `meta.pipeline_firehose = '1'|'0'` for persistence across launches. The returned `Promise` resolves when the SQLite write completes, but the UI doesn't need to await it before showing the toggle as flipped.

**Console output format** — one line per stage transition, grep-friendly, `key=value`:

```
[pipeline] ocr done in 1240ms source=src_abc123 ocrLength=842 ocrText="Maru Tonkatsu — Shibuya. Best ramen…"
[pipeline] url_fetch done in 587ms source=src_def456 httpStatus=200 imageUrlsCount=3 captionLength=128 caption="Mt Fuji spots: 1/ …"
[pipeline] extraction failed in 2103ms source=src_abc123 error="UpstreamError: schema-violation"
```

The formatter:
- Quotes string values (escaping internal quotes).
- Truncates string values at 500 characters with a trailing `…` so a giant OCR blob doesn't flood Metro.
- Coerces numbers and booleans verbatim.
- Drops `undefined` / `null` keys.

## In-app Diagnostics stream UI

**Location:** new screen `app/diagnostics/pipeline-log.tsx`, reached from `Settings → Diagnostics → Pipeline log`. Visible in both dev and TestFlight builds.

**Layout sketch:**

```
┌──────────────────────────────────────────────┐
│ ← Pipeline log                  [Clear log]  │
│                                              │
│ ── Today 16:42 ──                            │
│ source: src_abc123                           │
│ 16:42:26  storage         done    18ms       │
│ 16:42:26  url_fetch       done    580ms      │
│ 16:42:27  image_download  done    612ms      │
│ 16:42:28  ocr             done    420ms      │
│ 16:42:30  extraction      done    1.8s       │
│ 16:42:31  enrichment      done    287ms      │
│                                              │
│ ── Today 14:03 ──                            │
│ source: src_xyz789                           │
│ 14:03:06  ocr             done    380ms      │
│ 14:03:08  extraction      failed  2.1s       │
│   UpstreamError: schema-violation            │
│                                              │
│ [Load older]                                 │
└──────────────────────────────────────────────┘
```

- **Grouping:** rows grouped by `source_id` (with `"(no source)"` for share-extension-only events). The source-id header renders once per group.
- **Sort order:** groups newest-first; within a group, stages in chronological order (top→bottom matches pipeline flow).
- **Row content:** `HH:MM:SS  stage  status  duration`. Failed rows show `error_summary` on a second line.
- **Tap behaviour:** rows are read-only. The source-id header navigates to the source-detail screen when the source still exists; otherwise non-tappable. Soft-deleted sources show "(deleted)" next to the id.
- **Live updates:** subscribes via the existing `modules/storage/live-query.ts` to the `pipeline_events` table. New events appear without manual refresh — same pattern as inbox/trips.
- **Pagination:** initial load = 200 most recent rows. "Load older" appends 200 more. No virtualization needed at the 1000-row retention cap.
- **Empty state:** "No pipeline activity yet. Share something or import a screenshot to see events here."
- **Clear log:** confirms, then `DELETE FROM pipeline_events`. Available in both build types.

## Privacy + relationship to other observability

**Persisted rows hold no content.** Stages, timestamps, durations, error class + truncated message only. On a stolen device, the table reveals "this user shared 47 things last month, 3 failed in extraction" — nothing about what they shared. This is the same privacy class as `sources.ocr_status` today, just with timestamps and durations added.

**Firehose holds full content but is dev-only and local.** Hard-gated by `__DEV__` plus an opt-in toggle. The content never leaves the device and never persists past the Metro process buffer.

**No overlap with `2026-05-12-telemetry-design.md`.** That spec is PostHog product analytics across users; this is per-source SQLite debug history on one device. The PostHog spec uses bucketed/anonymous properties to answer aggregate questions; this spec uses raw timestamps and error classes to answer "what happened to this row?" They share no data, no storage, no SDK.

**Sentry integration is preserved.** Inside `startStage`'s `done`/`failed` methods, the existing Sentry breadcrumb logic (`addBreadcrumb` on every transition, `captureException` on failures) keeps firing exactly as today. Prod Sentry crash reports continue to include the pipeline trail.

## Implementation phases

1. **Module + table + migration.** Create `modules/pipeline-log/` with the public API, the migration, the firehose formatter, and unit tests. No call sites migrated yet. Existing `pipelineStep`/`pipelineError` keeps working unchanged.

2. **Call-site migration + worker debug echo.** Migrate all ~9 call sites to `startStage` / `done` / `failed`. Split `url_fetch` into `url_fetch` + `image_download`. Delete `lib/observability/breadcrumbs.ts`. Adjust integration tests in `modules/processing/__tests__/processing.test.ts` to assert the carousel event sequence. **Same phase:** extend the worker's `/fetch-post` success response with the `_debug` object, update the phone-side response schema in `modules/capture/fetchPostFromProxy.ts`, and have the `url_fetch` stage forward `_debug` into its `extra`. Worker unit tests in `workers/extract-proxy/__tests__/fetch-post.test.ts` assert `_debug.route` matches the dispatch matrix for each branch.

3. **Settings + UI.** Add the firehose toggle in `Settings → Diagnostics` (dev-only) and the Pipeline log screen at `app/diagnostics/pipeline-log.tsx` (all builds). Wire the live-query subscription and Clear button.

4. **Retention sweep.** Add `sweepPipelineEvents()` call to the cold-start path in `app/_layout.tsx`.

Each phase is independently shippable. Phase 1 lands with no behaviour change. Phase 2 cleans up the call sites and starts populating the table. Phase 3 surfaces the data. Phase 4 closes the retention loop. The minimum useful product is phases 1+2+3; phase 4 only matters once the table is real-user-busy.

## Tests

`modules/pipeline-log/index.test.ts`:

- `startStage('ocr').done({ ocrLength: 5 })` writes one row, status=done, duration ≈ 0, no error_summary.
- `startStage('ocr').failed(new Error('boom'))` writes one row, status=failed, error_summary=`Error: boom`.
- Calling `.done()` twice is a no-op (idempotency).
- Calling `.failed()` after `.done()` is a no-op.
- Firehose-off: no `console.log` regardless of dev/prod.
- Firehose-on + `__DEV__`: `console.log` called with formatted content line; content keys present.
- Firehose-on + `!__DEV__`: no `console.log` (hard gate).
- Formatter truncates string values at 500 chars; escapes inner quotes.
- `error_summary` truncates at 200 chars and prefixes with `err.name`.
- `sweepPipelineEvents` removes rows past the 1000-row cap and keeps the most recent rows intact.

Integration assertions in `modules/processing/__tests__/processing.test.ts`:
- Carousel flow emits the expected sequence (`url_fetch` done → `image_download` done → N × `ocr` done).
- Slide-N download failure emits an `image_download` done with `downloadedCount < requestedCount` (firehose-only props) and does not emit a `failed` event — partial slide loss is tolerated per the existing spec.

## Open questions

1. **Should we ever expose the firehose toggle on TestFlight?** Current design hides it on non-`__DEV__` builds. The argument for surfacing it in TestFlight: it would let beta testers turn on rich logging when reporting bugs. The argument against: content leaking into device logs that ship with crash reports. Leaning hidden; can re-evaluate if a tester debug session would clearly benefit.
2. **Trip-assign stage.** The existing `PipelineStage` union has `trip_assign`, but I didn't find a call site in the current code. Confirm where it should be emitted (likely in `applyTripAssign` or wherever the trip-id update happens).
3. **Foreign-key vs free `source_id`.** The schema declares `source_id` as `TEXT` without a foreign key to `sources(id)`. Reasoning: sources can be soft-deleted, and we want the pipeline trail to persist even after a source is removed. If that turns out to be wrong, adding an FK with `ON DELETE SET NULL` is a clean follow-up migration.
