# Pipeline debugging

A guide for tracing bugs through the capture → extraction → enrichment pipeline.
Use this when "the wrong thing showed up in the app" and it's not obvious which
stage misbehaved.

## Pipeline at a glance

```
share / picker / auto
        │
        ▼
   share_import / url_share_import           (modules/capture)
        │
        ▼
   storage                                   (modules/capture)
        │
        ├──── image path ────┐    ├──── URL path ────┐
        ▼                    ▼    ▼                  ▼
       ocr             extraction (vision)      url_fetch → image_download → ocr / extraction
        │                    │
        ▼                    │
   extraction (text) ────────┘
        │
        ▼
   enrichment                                (modules/enrichment + worker /enrich)
```

Each box is a `PipelineStage` emitted via `startStage(...)` from
`modules/pipeline-log`. The full list lives at
`modules/pipeline-log/pipeline-log.ts:15`.

## Observability surfaces

| Surface                    | What it shows                                                                                                                    | How to enable / view                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| In-app diagnostics         | Last N stage transitions (done/failed, duration, error summary) — no content.                                                    | Settings → Developer → "Pipeline log" navigates to `app/diagnostics/pipeline-log.tsx`.                             |
| Metro firehose             | Same stages **with full `extra` content** — the LLM output, OCR text, debug echo.                                                | Settings → Developer → "Pipeline firehose" toggle. Dev builds only. Logs to the Metro console.                     |
| AI Gateway dashboard       | Raw Gemini request + response for `/extract` and the `/enrich` blurb step. Includes per-call cost + latency.                     | Cloudflare dashboard → AI Gateway → the configured gateway. Filters by model and timestamp.                        |
| `wrangler tail` (terminal) | Live structured JSON per stage transition (`share_received`, `stage_start`, `stage_done`, `stage_warn`, `stage_error`) + errors. | `cd workers/extract-proxy && npx wrangler tail`. Use `--search '"contentHash":"..."'` to scope to one share.       |
| Workers Logs (dashboard)   | Same JSON lines as `wrangler tail`, retained 7 days. Free-text + field search, savable queries.                                  | Cloudflare dashboard → Workers & Pages → `trip-pocket-extract-proxy` → Logs. Enabled by `[observability]` in TOML. |
| Sentry (client)            | Unhandled JS errors + per-stage breadcrumbs (prod and TestFlight). `extract.poll` breadcrumbs trace the share→poll→render flow.  | Sentry web UI. The `pipeline_stage` tag scopes to a device-side stage.                                             |
| Sentry (worker)            | Every `logStageError` from the worker, tagged by `stage` / `source` / `mode` / `error_code`. Per-share isolation scope.          | Sentry web UI, same project. Set `wrangler secret put SENTRY_DSN` to enable; without it the SDK is a silent no-op. |

Persisted rows in `pipeline_events` are content-free by design. Anything you
need to see _what actually flowed_ requires the firehose or AI Gateway.

## Worker pipeline observability

The Cloudflare Worker (share-time pre-warm orchestrator + `/enrich` + `/photo`)
emits one structured JSON line per stage transition through `src/logger.ts`.
The `contentHash` doubles as a per-share trace id — grep it once and you see
the full chain from receipt through every stage.

### Event schema

Every line is `{ ts, event, ...fields }`. Stable fields:

| Field         | Values                                                                                                                                         | Where it comes from                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `event`       | `share_received`, `share_cache_hit`, `orchestrate_skip`, `orchestrate_stale_pending`, `stage_start`, `stage_done`, `stage_warn`, `stage_error` | Logger action.                                       |
| `stage`       | `fetch-post`, `extract`, `enrich`, `blurb`                                                                                                     | Which orchestrator step.                             |
| `contentHash` | SHA-256 of the canonical URL                                                                                                                   | Trace id; matches `sources.content_hash` on-device.  |
| `source`      | `instagram`, `tiktok`, `unknown`                                                                                                               | Derived from URL host (entry) or `fetched.platform`. |
| `mode`        | `video`, `vision`, `text`                                                                                                                      | Only on `stage=extract`. Reveals fallback path.      |
| `duration_ms` | number                                                                                                                                         | On `*_done` / `*_warn` / `*_error`.                  |
| `error_code`  | stable short token (`video-fetch-403`, `apify-timeout`, `gemini-429`, …)                                                                       | On `*_warn` / `*_error`.                             |
| `cache_kind`  | `og`, `apify`                                                                                                                                  | Which fetcher served `fetch-post`.                   |

The vocabulary is closed. No raw exception messages, no caption/OCR text.

### Cheat-sheet — `wrangler tail`

```bash
# everything (live)
npx wrangler tail

# errors only
npx wrangler tail --status error

# scope to one share
npx wrangler tail --search '"contentHash":"abc123..."'

# all TikTok failures
npx wrangler tail --search '"source":"tiktok"' --status error

# only the blurb step
npx wrangler tail --search '"stage":"blurb"'
```

`--search` is a substring match against the rendered log line. JSON-formatted
events mean every field is a filter token.

### Cheat-sheet — Workers Logs dashboard

`Cloudflare → Workers & Pages → trip-pocket-extract-proxy → Logs`. Useful
queries (paste into the top search bar):

| Question                                | Query                                                |
| --------------------------------------- | ---------------------------------------------------- |
| All errors today                        | `$workers.event.type:"error"`                        |
| One share end-to-end                    | `"contentHash":"abc123..."`                          |
| TikTok video-mode failures              | `"stage":"extract" "mode":"video" "source":"tiktok"` |
| Stale-pending re-orchestrations         | `orchestrate_stale_pending`                          |
| Cache hits (free, didn't run pipeline)  | `share_cache_hit`                                    |
| Blurb step timing (sort by duration_ms) | `"stage_done" "stage":"blurb"`                       |

Save the queries that earn their keep as Saved Searches in the dashboard.

### Sentry tags

Every `logStageError` lands in Sentry as an Issue. Filter the Issues list by:

- `stage:fetch-post` / `extract` / `enrich` / `blurb` — narrow to a pipeline step
- `source:instagram` / `tiktok` — narrow to a platform
- `mode:video` / `vision` / `text` — narrow to an extract fallback path
- `error_code:upstream-rate-limited` (or any closed-vocab token) — narrow to a failure class

Each event also has a `share` context block with the `contentHash` — copy it,
paste into the Workers Logs dashboard, and you get the full per-stage trace
around the moment of failure.

### Workflow — "a user says their share didn't work"

1. Get the `contentHash` — either from the client (`sources.content_hash` for
   the offending row), or from the Sentry breadcrumb trail on a captured error.
2. If live, `npx wrangler tail --search '"contentHash":"..."'`. If already
   happened, paste the hash into the Workers Logs dashboard.
3. Read the JSON lines top-to-bottom:
   `share_received` → `stage_start fetch-post` → `stage_done/error fetch-post`
   → `stage_start extract` → per-mode warns/done → `stage_start enrich` → …
   The first `stage_error` (or last `stage_warn` before pipeline gives up) is
   the root cause; its `error_code` is the closed-vocab failure class.
4. For LLM-specific weirdness (model went off-spec, hallucinated place names),
   open AI Gateway and filter by the same timestamp — you'll see the exact
   Gemini request and response.

## How to localize a bug

Work **backwards** from the symptom:

1. Find the stage whose **output** is wrong in the DB / UI.
2. Read that stage's input — usually a column the previous stage wrote.
3. If the input is correct, the bug is in this stage. If the input is already
   wrong, repeat the question one stage earlier.

The trap: a stage's output is often the LLM's response, which can look
plausible while being subtly wrong. Always compare against what the **next**
stage actually sent on — that's where the real input lives.

## Stage cheatsheet

For each stage: **what it does → where input lives → where output lives → how to
inspect → common failure modes.**

### `share_import` / `url_share_import`

- Imports a shared screenshot or URL, creates the `sources` row.
- Input: share extension payload / pasteboard.
- Output: `sources` row, file on disk, dedup hit/miss.
- Inspect: query `sources` table; the firehose extra `dup` / `existingSourceId`
  shows whether dedup short-circuited.
- Common: hash collision (real duplicate), missing file path.

### `storage`

- Persists the source file and writes the `sources` row with the chosen
  extraction strategy + optional EXIF-derived caption.
- Input: import result + caption from `modules/capture/photoLocation.ts`.
- Output: file at `sources/<id>.jpg`, `sources.caption`,
  `sources.extraction_strategy`.
- Inspect: `extras.tripId`, `extras.hasCaption`.
- Common: caption missing for share-extension imports (iOS strips EXIF on the
  share sheet — this is expected, not a bug).

### `url_fetch` / `image_download`

- Resolves a shared URL (IG / TikTok / generic) into image + caption, then
  downloads the bytes.
- Input: shared URL.
- Output: caption text, downloaded image file.
- Inspect: firehose extras include the fetcher chain outcome; worker
  `/fetch-post` debug echo carries which fetcher (`oembed` / `og` / `apify` /
  `tiktok-rehyd`) succeeded.
- Common: rate-limited Apify, OG fallback fired silently, TikTok rehydration
  expired.

### `ocr`

- Runs Apple Vision OCR on the image. Only fires for `ocrTextLLM` and
  `coverOcr` strategies (not vision-only).
- Input: source image file.
- Output: `sources.ocr_text`.
- Inspect: read `sources.ocr_text` directly; firehose `extras.charCount`.
- Common: blank OCR (low-contrast image / handwriting), partial OCR on
  carousels (only the cover gets OCR'd in some strategies).

### `extraction`

- Calls the worker `/extract`. Sends OCR text **or** image + caption. Receives
  `{ places: [...] }`.
- Input: `sources.ocr_text` (text mode) or `sources.file_path` +
  `sources.caption` (vision mode).
- Output: rows in `places` + `place_sources`.
- Inspect:
  - Firehose extra `placesJson` — full LLM output for this source.
  - AI Gateway dashboard — raw Gemini request and response.
- Common:
  - LLM emits district/neighbourhood text in `address` even when prompt asks for
    a street address (vision LLMs treat the prompt's verbatim example loosely).
  - `city` left empty for ambiguous inputs.
  - Duplicates within a single response (deduped per-call by
    name+city+address).

### `enrichment`

- Calls the worker `/enrich`. Worker does Google Places `searchText` →
  `places/{id}` details → Gemini blurb. Result merges into the `places` row.
- Input: `places.name`, `places.city`, the most-recent
  `place_sources.extracted_address`, the most-recent `ocr_text` or `caption`.
- Output: `places.external_place_id`, `latitude`, `longitude`,
  `formatted_address`, `photo_name`, `description`, `rating`, `price_level`,
  `external_url`, possibly overwritten `city` / `country_code` (Google is
  canonical when non-null).
- Inspect:
  - Firehose extras: `_debug.searchOutcome` / `detailsOutcome` / `blurbOutcome`
    (closed-vocab — `ok` / `empty` / `rate_limited` / `upstream_4xx` etc).
    Schema at `workers/extract-proxy/src/enrich.ts:28`.
  - `wrangler tail` for the actual Places `textQuery` (not yet echoed back —
    see the TODO at the bottom of this doc).
- Common failure modes:
  - **Wrong city returned (Scenario A)** — Places `textQuery` is missing the
    city anchor. Look at how the worker built it.
  - **Wrong place returned despite correct query (Scenario B)** — the real
    venue isn't in Google's index, so Google fuzzy-falls-back to the
    closest-named one elsewhere. The current code accepts it. Defence is a
    post-filter on returned-city vs requested-city (diacritic-normalised).
    Not implemented; add only when seen.
  - **Description null** — blurb step failed/empty. The blurb-retry path
    re-runs `/enrich` once the 5-minute throttle elapses
    (`modules/enrichment/enrichment.ts` `BLURB_RETRY_THROTTLE_MS`).
  - **`enrichment_paused_reason = 'entitlement'`** — worker 401'd because the
    user lost Pro. Resumed on next entitlement check.

## Worked example — wrong city returned (2026-05-17)

Useful as a template for the next time something similar happens.

1. **Symptom:** photo of a Kraków restaurant `Vegab` ended up enriched as the
   Warszawa branch of `Vegab`.
2. **Looked like:** extraction got the city wrong.
3. **Checked AI Gateway:** extraction had emitted
   `{ name: "Vegab", city: "Kraków", address: "Śródmieście", country_code: "PL" }`.
   So extraction was correct.
4. **Read the worker** (`workers/extract-proxy/src/enrich.ts`): the search
   query was being built as `[name, address || city].join(', ')`. With
   `address` non-empty, `city` was dropped, so the query was `"Vegab,
Śródmieście"` — `Śródmieście` is Polish for "city centre" and exists in
   every Polish city, so Google ranked the most-searched `Vegab` globally
   (Warsaw).
5. **First proposed fix:** include the country in the query. Wouldn't have
   helped — both cities are in Poland. The user caught this before any code
   was changed.
6. **Actual fix:** include **both** address and city in the query
   (`[name, address, city].filter(nonEmpty).join(', ')`). Regression test
   covers the exact inputs.

The lesson: when a downstream stage produces wrong output, the previous
stage's _output_ is the evidence, not the previous stage's _intent_. Read the
literal payload — AI Gateway, firehose `placesJson`, or `pipeline_events.extra`
— before drawing conclusions about whose fault it is.

## Known observability gaps

- **The Places `textQuery` is not echoed.** Visible only via `wrangler tail`
  today. Worth echoing into `_debug` alongside the chosen `places[0].id` so the
  firehose surfaces "what we asked Google" without leaving the device.
- **OCR text length is in the firehose but not its content.** Add `ocrTextSnippet`
  (first 200 chars) to the extras if OCR-quality bugs become a theme.
- **No correlation across sources in a multi-screenshot import.** Each source
  has its own stage chain; cross-source bugs (e.g. duplicate places that
  should have merged) require manual joins on `place_sources`.
