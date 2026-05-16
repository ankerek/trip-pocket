# Composable extraction pipeline — design

**Status:** draft (2026-05-16, rev 2) · awaiting review before implementation plan
**Touches:** `workers/extract-proxy/src/index.ts` (`/extract` handler — adds `mode: 'vision'`), `workers/extract-proxy/src/schema.ts` (request schema extended; legacy `{ ocr_text }` shape kept for one release as a back-compat alias), `workers/extract-proxy/src/fetch-post.ts` (chain runner; per-platform handlers extracted), `workers/extract-proxy/src/fetchers/` (new — `types.ts`, `instagramApify.ts`, `instagramOg.ts`, `tiktokRehydration.ts`, `tiktokOEmbed.ts`), `workers/extract-proxy/src/prompt.ts` (system prompt accepts image input alongside caption / text), `modules/extraction/extraction.ts` (orchestrator picks strategy; sweep gate updated for non-OCR strategies; new error classification for vision-mode), `modules/extraction/proxy.ts` (request payload shape — `mode`-discriminated), `modules/extraction/strategies/` (new — `types.ts`, `ocrThenTextLLM.ts`, `visionDirect.ts`, `captionPlusVision.ts`), `modules/processing/processing.ts` (OCR sweep gate adds `extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM'` filter), `modules/storage/sources.ts` (write `extraction_strategy` at import time; row reader exposes the column), `modules/storage/migrations/0010_extraction_strategy_columns.ts` (new — `ALTER TABLE sources ADD COLUMN extraction_strategy TEXT; ALTER TABLE sources ADD COLUMN fetched_via TEXT`), `app.config.ts` (`forceStrategy` added to `extra`, alongside `extractionProxyUrl` / `fetchPostProxyUrl`).
**Milestone:** v0.4 — extraction quality / canonicalisation.

## Why

Two concrete needs converged on the same refactor:

1. **The current TikTok parser is one schema drift away from breaking.** `workers/extract-proxy/src/fetch-post.ts` reads TikTok's `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON blob (`fetch-post.ts:666`) with oEmbed as a fallback; the Instagram path uses og:* tags plus Apify (`apify.ts`) for carousels. Each platform branch is inline in `handleFetchPost`. Adding a backup TikTok rehydration parser, or swapping Apify for a different IG carousel scraper, means editing the branch logic and risks regressing the working path. There is no clean seam to plug in a second fetcher.
2. **OCR + text-LLM is no longer the obvious extraction strategy.** Modern vision LLMs (Gemini 2.5 Flash / Flash-Lite) read the screenshot directly and extract structured places in one call — cheaper and richer than OCR-then-text. At Trip Pocket's ARPU, the cost delta is fractions of a cent per save (pricing verified against `ai.google.dev/gemini-api/docs/pricing` in the 2026-05-16 conversation). Swapping the strategy today requires rewriting `extraction.ts`, the worker `/extract` handler, and the source-row state machine in lockstep.

Both problems are the same shape: **the pipeline has clean stage separation but hardcoded providers within each stage.** The refactor introduces two pluggable seams so future swaps — a TikTok-rehydration backup when the schema drifts, a vision strategy now, a video strategy later — are additive, not invasive.

## Scope

In scope:

- **Seam 1 — `LinkFetcher` chain** in the worker. Ordered registry of fetchers per-platform; chain runner tries each in order, returns first success, logs the winner. Retryable failures advance to the next fetcher; only an exhausted chain surfaces as `retry`.
- **Seam 2 — `ExtractionStrategy`** in the app. Discriminated-union input (`image` | `text`). Three strategies shipped: `OcrThenTextLLM` (kept for rollback), `VisionLLMDirect` (new), `CaptionPlusVisionLLM` (new). The strategy is **chosen at row-creation time** (not at sweep time) and persisted to `sources.extraction_strategy`.
- **Worker `/extract` accepts two modes**: `text` (existing semantics, renamed in the wire format) and `vision` (new — base64 image + optional caption). Same Gemini model (`gemini-2.5-flash-lite`), same response schema, same JSON output contract. The legacy `{ ocr_text }` request shape is accepted for one release as a back-compat alias, then dropped.
- **Default behaviour switches for image sources**: shared screenshots bypass OCR and go straight to `VisionLLMDirect`. URL sources with caption+image use `CaptionPlusVisionLLM`. The `OcrThenTextLLM` strategy and the on-device OCR module remain in the codebase as a one-flag-flip rollback path.
- **Telemetry**: `sources.fetched_via` and `sources.extraction_strategy` columns added (nullable TEXT) via `0010_extraction_strategy_columns`. The existing pipeline log gains both fields.
- **Strategy override**: a single `forceStrategy: 'auto' | 'ocrTextLLM' | 'vision'` config value (default `auto`). `captionPlusVision` is **not** a forceable value — it only fires via `auto` when a caption exists. `forceStrategy: 'vision'` ignores any caption present, which is intentional (used as a clean A/B against text-only strategies).
- **Image downscaling before upload** (decided — see §Decisions). Long edge ≤ 1024px, JPEG q=82.

Not in scope (each can be its own sub-project):

- **Video extraction (Instagram Reels, TikTok videos)**. The `StrategyInput` union and `FetchPostResult` deliberately do **not** carry a `video` variant; adding it without an implementation creates an invalid state in the type system. The interfaces are shaped so a future spec can add `video` additively (single new variant in each union, plus a new strategy module). Separate spec — needs its own UX decisions (multiple places per reel, processing latency, video download / Files API).
- **Pluggable OCR provider.** Apple Vision stays hardcoded. Vision strategies bypass OCR anyway; no concrete reason to swap the provider.
- **Pluggable Places enrichment.** Google Places is stable.
- **Per-user A/B testing.** `forceStrategy` is a global, compiled-in config flag, not a per-user assignment. Sufficient to validate the vision strategy on TestFlight.
- **DI framework / plugin loader.** Strategies and fetchers are TS modules in an ordered array.
- **Hybrid OCR + vision (sending both to the LLM).** Vision LLM alone is sufficient quality for the shape of saves Trip Pocket sees.
- **Backfilling old rows.** Legacy rows have `extraction_strategy IS NULL` and are treated as OCR-then-text (matches existing behavior).

## Decisions

**Two seams, one refactor.** Seam 1 (fetcher chain) and Seam 2 (extraction strategy) ship together because the worker `/extract` and `/fetch-post` handlers both need touching and the spec/plan/PR cycle is cheaper once. They are *independent at the code level* — could be reverted separately — but coupled at the *delivery level* (see §Delivery).

**Strategy is chosen at row-creation time, not at sweep time.** This is the decision that replaces the original rev-1 idea of marking `ocr_status='skipped'`. Reasons:

- `ocr_status` has a `CHECK (ocr_status IN ('pending','done','failed'))` at `modules/storage/migrations/0001_init.ts:66`. Adding `'skipped'` requires a full table rebuild on SQLite (no `ALTER … ADD CHECK`). Avoidable churn.
- The extraction sweep already gates on `ocr_status='done'` (`extraction.ts:313`). A `'skipped'` value would strand vision rows unless the gate is also rewritten — and we'd need it to be rewritten *and* the new value added, two coupled changes.
- Decision-at-creation is simpler. The `sources` row carries its strategy from birth. Sweeps gate on `extraction_strategy` instead of inventing an OCR sentinel.

Concretely: when a row enters the system (`importImage`, `importUrl`, `ingestPendingImports`), the orchestrator stamps `extraction_strategy` based on `forceStrategy` + source shape:

```
forceStrategy='auto', kind='screenshot'  → 'vision'
forceStrategy='auto', kind='url'         → 'captionPlusVision' (set after fetch completes and a caption is present), else 'vision'
forceStrategy='ocrTextLLM'               → 'ocrTextLLM'
forceStrategy='vision'                   → 'vision' (caption ignored even if present)
```

Legacy rows (pre-migration) have `extraction_strategy IS NULL`; the orchestrator treats `NULL` as `'ocrTextLLM'`. This preserves current behavior for any rows already in the database when v0.4 ships.

**Sweep queries change.** Both the OCR sweep and the extraction sweep gate on `extraction_strategy`:

```sql
-- OCR sweep (modules/processing/processing.ts:418)
SELECT id FROM sources
 WHERE ocr_status = 'pending'
   AND (extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM')
   AND (kind = 'image' OR file_path IS NOT NULL OR caption IS NOT NULL);

-- Extraction sweep (modules/extraction/extraction.ts:313)
SELECT id FROM sources
 WHERE extraction_status = 'pending'
   AND extraction_paused_reason IS NULL
   AND (
     ( (extraction_strategy IS NULL OR extraction_strategy = 'ocrTextLLM')
       AND ocr_status = 'done' )
     OR
     extraction_strategy IN ('vision', 'captionPlusVision')
   )
 ORDER BY captured_at ASC;
```

Vision rows skip the `ocr_status='done'` gate. OCR rows behave exactly as today. Legacy NULL rows behave exactly as today.

**Strategies own their data dependencies.** `OcrThenTextLLM.extract({ kind: 'image', filePath })` is responsible for running OCR on-demand if `ocrText` is missing. The OCR sweep is an *optimization* (pre-warming text) rather than a precondition. On rollback to `forceStrategy: 'ocrTextLLM'`, *new* rows enter with `extraction_strategy='ocrTextLLM'` and the OCR sweep picks them up normally. *In-flight* rows already stamped `'vision'` finish on vision — see §Rollback.

**Image bytes go to the worker inline as base64.** No signed URLs, no Files API, no S3. The app already has the image on disk; POSTing the bytes to the Cloudflare Worker is fine. Video, in the future, *will* need Files API — that's a video-spec concern.

**Images are downscaled before base64 encoding** (decided, not deferred). Long edge ≤ 1024px, JPEG quality 82. Reasoning:

- Cloudflare Workers have a 100MB request body limit but practical timeout pressure starts around 1–2MB JSON payloads. Original iPhone screenshots are 1170×2532 ≈ 2–4MB JPEG; base64 inflates that to ~3–5MB. Downscaling halves it.
- Gemini tiles images into 768×768 chunks; anything larger than 1024px on the long edge produces 1–2 extra tiles without quality gain on text-heavy screenshots. Token cost is identical.
- 1024px / q=82 is the sweet spot validated by Apify's own thumbnail pipeline; on-screen text remains legible.
- Implementation: `expo-image-manipulator` on the app side. Computation is local, ~50ms.

**Fallback within Seam 2 only on infrastructure errors.** If `VisionLLMDirect` returns zero places, that's a real result — do not fall back to OCR. Only fall back on classification = `retryable` (5xx / timeout / TLS), and only if `ocrText` already exists on the row. The existing `ExtractionError` classification (`extraction.ts:27`) handles this without a new paused-reason: `retryable` already counts toward the 3-try budget; after exhaustion the row goes to `'failed'`. The rev-1 idea of `extraction_paused_reason='vision-infra'` is dropped — it duplicated existing retry logic.

**Strategy selection — full rules:**

```
config.forceStrategy === 'auto' (default):
  kind === 'image'                       → 'vision'        (set at import)
  kind === 'url', after fetch, caption empty  → 'vision'        (set after fetch)
  kind === 'url', after fetch, caption set    → 'captionPlusVision' (set after fetch)
  kind === 'pasted'                           → 'ocrTextLLM'    (text-only path)

config.forceStrategy === 'ocrTextLLM':
  any new row                                 → 'ocrTextLLM'

config.forceStrategy === 'vision':
  kind === 'image' or 'url' with file    → 'vision'
  kind === 'pasted'                           → error at import (no image)
```

`forceStrategy` lives in `app.config.ts.extra` alongside `extractionProxyUrl` / `fetchPostProxyUrl`. Compiled-in default; no remote feature flag system — we ship a new build to flip it.

**Fetcher chain semantics — three outcomes, retryable cascades:**

```ts
type FetcherOutcome =
  | { kind: 'ok'; result: FetchPostResult }
  | { kind: 'not-applicable' }              // wrong platform / wrong URL shape
  | { kind: 'failed'; error: Error; retryable: boolean };
```

- `not-applicable` → silently advance to the next fetcher.
- `failed` (retryable or not) → **advance to the next fetcher**. The chain's job is to try every applicable fetcher before giving up. Retryable status is preserved and bubbles up only if the *entire chain* fails: `AllFetchersFailedError` carries `retryableExhausted: boolean` (true iff at least one fetcher returned retryable, false if all failures were non-retryable). The worker's HTTP response uses this to decide between 429-like (`retry: true`) and 502 (`retry: false`).

This is the correction to rev 1's "throws immediately on retryable" semantics, which defeated the chain's whole purpose: a TikTok block that surfaces as 429/timeout should trigger the backup fetcher, not abort the chain.

**`fetched_via` and `extraction_strategy` are nullable TEXT**, not enums. SQLite enum enforcement requires table rebuild; Zod at the worker/app boundary enforces typing in code.

## Architecture

### Seam 1 — `LinkFetcher` chain (worker-side)

**File layout:**

```
workers/extract-proxy/src/
  fetch-post.ts              ← orchestrator; chain runner; HTTP handler
  fetchers/
    types.ts                 ← LinkFetcher, FetcherOutcome, FetchPostResult
    instagramOg.ts           ← extracted from fetch-post.ts (og: parser path)
    instagramApify.ts        ← extracted from fetch-post.ts + apify.ts (carousel path)
    tiktokRehydration.ts     ← extracted from fetch-post.ts (rehydration JSON parser)
    tiktokOEmbed.ts          ← extracted from fetch-post.ts (oEmbed fallback)
    // future: tiktokRehydrationV2.ts, instagramOgFallback.ts, etc.
  prompt.ts                  ← unchanged structure; small tweak for vision mode
  index.ts                   ← routing, unchanged
```

The current Instagram code has a two-stage internal flow (og: parse → Apify if carousel/unknown). Splitting it cleanly preserves that ordering: `instagramOg` returns `not-applicable` for non-IG, returns the og: result on success, returns `failed` with retryable= per the existing error mapping; `instagramApify` runs next, sees the og: result via shared context, and decides whether to fire. The chain runner passes a small context object so successive fetchers can inspect prior attempts without rebuilding state.

**Interface:**

```ts
type Platform = 'instagram' | 'tiktok';

type FetchPostResult = {
  platform: Platform;
  permalink: string;
  caption: string;             // may be empty
  imageUrls: string[];         // may be empty
  author: string | null;
  // No videoUrl field. When video extraction lands, it adds a single optional field here.
};

type FetcherContext = {
  previousAttempts: FetcherAttempt[];   // fetchers can inspect earlier outcomes
  env: WorkerEnv;
};

type FetcherOutcome =
  | { kind: 'ok'; result: FetchPostResult; debugRoute?: FetchPostDebug['route'] }
  | { kind: 'not-applicable' }
  | { kind: 'failed'; error: Error; retryable: boolean };

type LinkFetcher = {
  name: string;
  fetch(url: URL, platform: Platform, ctx: FetcherContext): Promise<FetcherOutcome>;
};
```

**Chain runner** (replaces the inline branch in `handleFetchPost`):

```ts
const FETCHERS: LinkFetcher[] = [
  instagramOgFetcher,
  instagramApifyFetcher,
  tiktokRehydrationFetcher,
  tiktokOEmbedFetcher,
];

export async function runFetcherChain(url, platform, env) {
  const attempts: FetcherAttempt[] = [];
  for (const f of FETCHERS) {
    const outcome = await f.fetch(url, platform, { previousAttempts: attempts, env });
    attempts.push({ fetcher: f.name, outcome });
    if (outcome.kind === 'ok') {
      return { result: outcome.result, via: f.name, attempts };
    }
    // retryable or non-retryable: advance to next fetcher
  }
  const retryableExhausted = attempts.some(
    a => a.outcome.kind === 'failed' && a.outcome.retryable,
  );
  throw new AllFetchersFailedError(attempts, { retryableExhausted });
}
```

The closed-vocab `_debug.route` token (`fetch-post.ts:31`) is preserved by each fetcher returning its route hint; the chain composes them or picks the winning fetcher's hint.

### Seam 2 — `ExtractionStrategy` (app-side)

**File layout:**

```
modules/extraction/
  extraction.ts             ← orchestrator + sweep with updated gate query
  proxy.ts                  ← worker /extract client (mode-discriminated body)
  strategies/
    types.ts                ← StrategyInput, ExtractionStrategy, comment on future video variant
    ocrThenTextLLM.ts
    visionDirect.ts
    captionPlusVision.ts
```

**Interface:**

```ts
// types.ts
//
// NOTE for future maintainers: video extraction is a separate spec. When it
// lands, extend this union with a `video` variant and add a new strategy
// module. Do not pre-bake the type — see 2026-05-16-…-design.md §Scope.
type StrategyInput =
  | { kind: 'image'; filePath: string; ocrText?: string; caption?: string }
  | { kind: 'text'; text: string };

interface ExtractionStrategy {
  name: 'ocrTextLLM' | 'vision' | 'captionPlusVision';
  extract(input: StrategyInput, source: SourceRow): Promise<ExtractedPlaceInput[]>;
}
```

**`OcrThenTextLLM` (kept for rollback + legacy NULL rows):**

```ts
async extract(input) {
  if (input.kind !== 'image' && input.kind !== 'text') {
    throw new Error('ocrThenTextLLM: unsupported input kind');
  }
  const text = input.kind === 'text'
    ? input.text
    : (input.ocrText ?? await runOnDeviceOcr(input.filePath));
  return await extractionProxy({ mode: 'text', text });
}
```

OCR runs inline if missing. This is the path that lets us flip `forceStrategy: 'ocrTextLLM'` and have the system keep working even if the sweep no longer pre-warms.

**`VisionLLMDirect`** and **`CaptionPlusVisionLLM`** are thin wrappers around the worker `/extract` `mode: 'vision'` call. Each reads `filePath`, downscales via `expo-image-manipulator`, base64-encodes, posts. `CaptionPlusVisionLLM` additionally passes `caption`.

**Orchestrator** (`extraction.ts`):

```ts
async function processOne(sourceId) {
  const source = await loadSource(sourceId);
  const strategyName = source.extraction_strategy ?? 'ocrTextLLM';
  const strategy = strategiesByName[strategyName];
  const input = await buildStrategyInput(source, strategy);
  try {
    const places = await strategy.extract(input, source);
    await persistPlaces(places, source);
    await markExtractionDone(source);
  } catch (err) {
    await handleExtractionError(err, source, strategy);
  }
}
```

Note: `extraction_strategy` is **read from the row**, not re-computed. The orchestrator does not re-derive strategy from `forceStrategy` at sweep time — that would break the "in-flight rows finish on their original strategy" guarantee.

### Worker `/extract` — dual mode

Current request schema (`workers/extract-proxy/src/schema.ts:34`):

```ts
export const requestBodySchema = z.object({
  ocr_text: z.string().refine(s => s.trim().length > 0, …),
});
```

New schema (back-compat alias preserved for one release):

```ts
const visionRequest = z.object({
  mode: z.literal('vision'),
  imageBase64: z.string().min(1),
  caption: z.string().optional(),
});

const textRequest = z.object({
  mode: z.literal('text'),
  text: z.string().refine(s => s.trim().length > 0, …),
});

const legacyRequest = z.object({
  ocr_text: z.string().refine(s => s.trim().length > 0, …),
}).transform(r => ({ mode: 'text' as const, text: r.ocr_text }));

export const requestBodySchema = z.union([visionRequest, textRequest, legacyRequest]);
```

The legacy alias means PR2 (worker) and PR3 (app) can ship in either order without breaking in-flight requests. PR2 + 1 release later, the alias is removed.

The Gemini call uses the same JSON response schema in both modes. In `vision` mode the SDK call passes `inline_data` for the image (mime type inferred from the JPEG/PNG magic bytes — the downscale step ensures JPEG); the caption (if present) is appended into the user prompt with a fixed preamble. The system prompt in `prompt.ts` gets a small tweak to handle both modes; the JSON contract stays.

### DB shape

One migration, additive only:

```ts
// modules/storage/migrations/0010_extraction_strategy_columns.ts
ALTER TABLE sources ADD COLUMN extraction_strategy TEXT;
ALTER TABLE sources ADD COLUMN fetched_via TEXT;
```

No CHECK constraints (Zod boundary enforcement). Both nullable. Legacy rows: NULL in both, treated as `'ocrTextLLM'` by the orchestrator and as "unknown" by telemetry. SQLite `ALTER TABLE ADD COLUMN` doesn't need a table rebuild.

`ocr_status` semantics are **unchanged**. No `'skipped'` value. The sweep queries change (see §Decisions); the column values remain `pending|done|failed`.

### Telemetry

Existing pipeline log (`docs/superpowers/specs/2026-05-13-pipeline-observability-design.md`) gains two fields on extraction-stage rows:

- `extraction_strategy` — `vision` | `ocrTextLLM` | `captionPlusVision` | `null`
- `fetched_via` — name of the winning fetcher (URL sources only)

The Cloudflare AI Gateway dashboard remains the source of truth for token usage and cost.

### Rollback plan

Three nested levels, in increasing scope:

1. **Single-flag rollback** — set `forceStrategy: 'ocrTextLLM'` and ship a new build. *New* rows enter with `extraction_strategy='ocrTextLLM'`; OCR sweep picks them up. *In-flight* `'vision'` rows finish on vision (they don't need OCR text and the extraction sweep already accepts them). No backfill needed.
2. **Worker rollback** — revert worker to text-only. The app still sends `mode: 'vision'` for rows already stamped `'vision'`, which will 400. Sequence the rollback: flip `forceStrategy: 'ocrTextLLM'` *first*, wait for in-flight `'vision'` rows to drain (extraction sweep + retries), *then* revert the worker. The legacy `{ ocr_text }` alias keeps text-mode requests flowing.
3. **Full revert** — revert all four PRs. The two new nullable columns can be left in place (zero-cost) or dropped via a follow-up migration `0011_drop_strategy_columns`.

Because the OCR module and `OcrThenTextLLM` strategy stay as first-class citizens, level (1) is the expected revert path if vision quality disappoints. Levels (2) and (3) are unlikely.

Edge case: if a *vision* row is `extraction_status='pending'` but the user never gets back online before rollback ships, it stays pending under `'vision'` forever (sweep accepts it, but the worker call would now 400). Optional cleanup query for the rollback PR:

```sql
UPDATE sources
   SET extraction_strategy = 'ocrTextLLM'
 WHERE extraction_status = 'pending'
   AND extraction_strategy = 'vision';
```

Coupled with `runStartupRecovery`-style retry, those rows then route through OCR. Document as a rollback-time decision, not a routine migration.

## Delivery shape

Four sequenced PRs. **They are not independently revertible** (this corrects rev 1's claim). They form a coordinated sequence where each PR depends on the prior shape on disk or on the wire:

1. **PR 1 — Worker `LinkFetcher` chain refactor.** Pure refactor in the worker. Extract per-platform handlers into `fetchers/*.ts`. Chain runner replaces the inline branch in `handleFetchPost`. No app changes. The fetcher chain's `via` token is logged but not yet returned in the response. **Revertable alone** — the response shape doesn't change.
2. **PR 2 — Worker `/extract` vision mode + fetcher `via` in response.** Additive: `requestBodySchema` becomes the discriminated union; legacy `{ ocr_text }` is the back-compat alias. Adds `via` field to `/fetch-post` response. **Couples with PR 3** at the wire level if PR 3 ships before this — but PR 3 only sends new shape when `forceStrategy !== 'ocrTextLLM'`, and the spec ships PR 3 with default `'ocrTextLLM'`.
3. **PR 3 — App `ExtractionStrategy` abstraction + DB columns + writes `extraction_strategy`/`fetched_via`.** Adds migration `0010`. Introduces strategies. Sweep queries change (gate on `extraction_strategy`). Ships with `forceStrategy: 'ocrTextLLM'` — every new row gets stamped `'ocrTextLLM'`, behaving exactly like today. The new sweep query is a strict superset of the old behavior for legacy NULL rows. **Couples with PR 2** for the `fetched_via` field write and the new request shape (only exercised once PR 4 flips the default).
4. **PR 4 — Flip default to `auto`.** One-line config change. Monitor AI Gateway dashboard and Sentry for a few days. **Couples with PR 2 + PR 3** — won't function correctly without both.

The four PRs are a coordinated rollout, with safe ordering and a back-compat alias bridging PR 2 ↔ PR 3 timing. The *single-flag rollback* (level 1 above) is the production safety net.

## Open questions

- **Caption preamble wording in vision mode** — does the LLM extract better with `"User-supplied caption:\n<text>"` vs. injecting the caption directly into the user prompt? Tested empirically during PR 2 implementation. Pick whichever wins, hard-code, move on. Not architectural.
