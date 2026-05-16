# Composable extraction pipeline — design

**Status:** draft (2026-05-16) · awaiting review before implementation plan
**Touches:** `workers/extract-proxy/src/index.ts` (`/extract` handler — adds vision mode), `workers/extract-proxy/src/fetch-post.ts` (becomes the chain runner), `workers/extract-proxy/src/fetchers/` (new: `types.ts`, `apifyCarousel.ts`, `tiktokOEmbed.ts`), `workers/extract-proxy/src/prompt.ts` (system prompt accepts image + optional caption), `modules/extraction/extraction.ts` (orchestrator picks strategy), `modules/extraction/proxy.ts` (request payload — text vs. vision modes), `modules/extraction/strategies/` (new: `types.ts`, `ocrThenTextLLM.ts`, `visionDirect.ts`, `captionPlusVision.ts`), `modules/extraction/processing.ts` (OCR-sweep gate stays, no longer auto-runs for image sources), `app.config.ts` (`forceStrategy` added to `extra`, alongside `extractionProxyUrl` / `fetchPostProxyUrl`).
**Milestone:** v0.4 — extraction quality / canonicalisation.

## Why

Two concrete needs converged on the same refactor:

1. **The Apify TikTok scraper can be blocked at any time.** Today, `workers/extract-proxy/src/fetch-post.ts` hardcodes a per-platform branch (Instagram → Apify carousel; TikTok → oEmbed). Adding a backup fetcher means editing the branch logic and risks regressing the working path. There is no way to plug in a second fetcher without touching the orchestration.
2. **OCR + text-LLM is no longer the obvious extraction strategy.** Modern vision LLMs (Gemini 2.5 Flash / Flash-Lite) read the screenshot directly and extract structured places in one call — cheaper and richer than OCR-then-text. At Trip Pocket's ARPU, the cost delta is fractions of a cent per save (see `2026-05-16` conversation log, pricing verified against `ai.google.dev/gemini-api/docs/pricing`). But swapping the strategy today requires rewriting `extraction.ts`, the worker `/extract` handler, and the source-row state machine in lockstep.

Both problems are the same shape: **the pipeline has clean stage separation but hardcoded providers within each stage.** The refactor introduces two pluggable seams so future swaps — a new fetcher when Apify breaks, a vision strategy now, a video strategy later — are additive, not invasive.

## Scope

In scope:

- **Seam 1 — `LinkFetcher` chain** in the worker. Ordered registry of fetchers; orchestrator tries each in order, returns first success, logs the winner.
- **Seam 2 — `ExtractionStrategy`** in the app. Discriminated-union input (`image` | `text` | `video`-reserved). Three strategies shipped: `OcrThenTextLLM` (kept), `VisionLLMDirect` (new), `CaptionPlusVisionLLM` (new).
- **Worker `/extract` accepts two modes**: `text` (existing) and `vision` (new — base64 image + optional caption). Same Gemini model (`gemini-2.5-flash-lite`), same response schema, same JSON output contract.
- **Default behaviour switches for image sources**: shared images bypass OCR and go straight to `VisionLLMDirect`. URL sources with caption+image use `CaptionPlusVisionLLM`. The `OcrThenTextLLM` strategy and the on-device OCR module remain in the codebase as a one-flag-flip rollback path.
- **Telemetry**: `sources.fetched_via` and `sources.extraction_strategy` columns added (nullable TEXT). The existing pipeline log gains both fields.
- **Per-source rollback flag**: a single `forceStrategy: 'auto' | 'ocrTextLLM' | 'vision' | 'captionPlusVision'` config value (default `auto`) lets us flip back without code changes.

Not in scope (each can be its own sub-project):

- **Video extraction (Instagram Reels, TikTok videos)**. The `StrategyInput` union *reserves* a `video` variant and the `FetchPostResult` *can* return a `videoUrl` field, but no strategy implements video and the worker doesn't download video bytes. Separate spec — needs its own UX decisions (multiple places per reel, processing latency).
- **Pluggable OCR provider.** Apple Vision stays hardcoded. Vision strategies bypass OCR anyway; there is no concrete reason to swap the provider.
- **Pluggable Places enrichment.** Google Places is stable; no signal it needs replacing.
- **Per-user A/B testing.** `forceStrategy` is a global config flag, not a per-user assignment. Sufficient to validate the vision strategy on staging or via a TestFlight build.
- **DI framework / plugin loader.** Strategies and fetchers are TS modules in an ordered array. No runtime discovery, no codegen.
- **Migration of `ocr_status` semantics.** Both `ocr_status` and `extraction_status` columns remain. Vision strategies set `ocr_status='skipped'` upfront. Reversible without a migration.
- **Hybrid OCR + vision (Option C).** Not built — vision LLM alone is sufficient quality for the shape of saves Trip Pocket sees.

## Decisions

**Two seams, one refactor.** Seam 1 (fetcher chain) and Seam 2 (extraction strategy) ship together because the worker `/extract` and `/fetch-post` handlers both need touching and the spec/plan/PR cycle is cheaper to do once. They are *independent* at the code level — could be reverted separately.

**Strategies own their data dependencies, not the orchestrator.** `OcrThenTextLLM.extract({ kind: 'image', filePath })` is responsible for running OCR on-demand if `ocrText` is missing. The orchestrator's only job is to pick the strategy and pass the source row. This means the OCR sweep (`processor.runOcrSweep()`) becomes an *optimization* (pre-warming OCR text) rather than a precondition. Today it pre-warms; on rollback to `forceStrategy: 'ocrTextLLM'`, the strategy will trigger OCR inline if the sweep hasn't run.

For the initial cut, the OCR sweep is gated on `source.kind === 'image' && shouldRunOcr(source)`, where `shouldRunOcr` returns `true` if the picked strategy will need OCR text. Today that means: only when `forceStrategy === 'ocrTextLLM'`. Default (`auto`) → sweep skips. Code stays in place; no work happens.

**Image bytes go to the worker inline as base64.** No signed URLs, no Files API, no S3. The app already has the image on disk; POSTing ~1–2MB to the Cloudflare Worker is fine. Rate-limit binding stays the same. (Video, in the future, *will* need Files API — but that's a video-spec concern.)

**Fallback within Seam 2 only on infrastructure errors.** If `VisionLLMDirect` returns zero places, that's a real result — do not fall back to OCR. Only fall back on network errors, 429, 5xx, auth failures. This rule prevents wasted LLM calls on empty extractions and keeps the strategy semantics honest. Falling back to `OcrThenTextLLM` only happens if `ocrText` already exists (i.e., sweep ran for some reason); otherwise the source row is paused with `extraction_paused_reason='vision-infra'` and retried by the existing pause/resume logic.

**Strategy selection is rule-based in the orchestrator, not config-driven per-source.**

```ts
function pickStrategy(input: StrategyInput, config): ExtractionStrategy {
  if (config.forceStrategy !== 'auto') return strategies[config.forceStrategy];
  switch (input.kind) {
    case 'image':
      return input.caption ? captionPlusVision : visionDirect;
    case 'text':
      return ocrThenTextLLM;
    case 'video':
      throw new Error('video strategy not implemented'); // reserved
  }
}
```

`forceStrategy` is the rollback lever. `auto` is the production default.

**`fetched_via` and `extraction_strategy` are added as nullable TEXT columns**, not enums. SQLite enum enforcement is awkward (CHECK constraints require table rebuild), and the values are write-only observability fields. Zod at the worker/app boundary keeps types honest.

**The fetcher chain runs the first applicable fetcher, not all of them in parallel.** Sequential with cascade. Reasons: cost (each Apify call burns budget), rate limits (parallel calls multiply 429s), and simplicity. The only time multiple fetchers run is when one fails — which should be rare.

**Fetcher failure semantics**: a fetcher distinguishes three return states:

```ts
type FetcherOutcome =
  | { kind: 'ok'; result: FetchPostResult }
  | { kind: 'not-applicable' }    // wrong platform, wrong URL shape
  | { kind: 'failed'; error: Error; retryable: boolean };
```

Not-applicable skips silently to the next fetcher. Failed-with-retryable surfaces a transient error to the app (queues for retry). Failed-non-retryable advances to the next fetcher. The orchestrator's `AllFetchersFailedError` carries the array of attempts for debugging.

## Architecture

### Seam 1 — `LinkFetcher` chain (worker-side)

**File layout:**

```
workers/extract-proxy/src/
  fetch-post.ts              ← entry point, runs the chain
  fetchers/
    types.ts                 ← LinkFetcher, FetcherOutcome, FetchPostResult
    apifyCarousel.ts         ← extracted from current fetch-post.ts
    tiktokOEmbed.ts          ← extracted from current fetch-post.ts
    // future: tiktokBackup.ts, instagramOgFallback.ts, etc.
  index.ts                   ← unchanged routing, calls fetch-post
```

**Interface:**

```ts
type Platform = 'instagram' | 'tiktok';

type FetchPostResult = {
  platform: Platform;
  permalink: string;
  caption: string | null;
  imageUrls: string[];
  videoUrl?: string;       // reserved for future video strategies
  author?: string;
};

type FetcherOutcome =
  | { kind: 'ok'; result: FetchPostResult }
  | { kind: 'not-applicable' }
  | { kind: 'failed'; error: Error; retryable: boolean };

type LinkFetcher = {
  name: string;
  fetch(url: string, platform: Platform, env: Env): Promise<FetcherOutcome>;
};
```

Each fetcher decides its own `not-applicable` logic (typically: wrong platform). No central `supports()` predicate — the fetcher's first move is to inspect the URL and return `not-applicable` if it can't handle it.

**Chain runner:**

```ts
const FETCHERS: LinkFetcher[] = [
  apifyCarouselFetcher,
  tiktokOEmbedFetcher,
];

export async function fetchPost(url: string, platform: Platform, env: Env) {
  const attempts: { fetcher: string; outcome: FetcherOutcome }[] = [];
  for (const f of FETCHERS) {
    const outcome = await f.fetch(url, platform, env);
    attempts.push({ fetcher: f.name, outcome });
    if (outcome.kind === 'ok') {
      return { result: outcome.result, via: f.name, attempts };
    }
    if (outcome.kind === 'failed' && outcome.retryable) {
      throw new RetryableFetchError(outcome.error, attempts);
    }
  }
  throw new AllFetchersFailedError(attempts);
}
```

The `via` field is returned to the app and persisted in `sources.fetched_via`.

### Seam 2 — `ExtractionStrategy` (app-side)

**File layout:**

```
modules/extraction/
  extraction.ts             ← orchestrator, picks + invokes strategy
  proxy.ts                  ← worker /extract client (now supports both modes)
  processing.ts             ← unchanged shape; runOcrSweep gated by needsOcr()
  strategies/
    types.ts                ← StrategyInput, ExtractionStrategy, helpers
    ocrThenTextLLM.ts       ← current behaviour
    visionDirect.ts         ← new
    captionPlusVision.ts    ← new
```

**Interface:**

```ts
type StrategyInput =
  | { kind: 'image'; filePath: string; ocrText?: string; caption?: string }
  | { kind: 'text'; text: string }
  | { kind: 'video'; filePath: string; caption?: string }; // reserved

interface ExtractionStrategy {
  name: 'ocrTextLLM' | 'vision' | 'captionPlusVision';
  extract(input: StrategyInput, source: SourceRow): Promise<ExtractedPlace[]>;
}
```

**`OcrThenTextLLM` (kept for rollback):**

```ts
async extract(input) {
  if (input.kind !== 'image' && input.kind !== 'text') throw …;
  const text = input.kind === 'text'
    ? input.text
    : (input.ocrText ?? await runOnDeviceOcr(input.filePath));
  return await extractionProxy({ mode: 'text', text });
}
```

OCR is triggered inline if missing. This is the path that lets us flip `forceStrategy: 'ocrTextLLM'` and have the system keep working even if the sweep no longer pre-warms.

**`VisionLLMDirect` (new — default for image sources without caption):**

```ts
async extract(input) {
  if (input.kind !== 'image') throw …;
  const imageBase64 = await readFileBase64(input.filePath);
  return await extractionProxy({ mode: 'vision', imageBase64 });
}
```

**`CaptionPlusVisionLLM` (new — default for URL sources with caption+image):**

```ts
async extract(input) {
  if (input.kind !== 'image' || !input.caption) throw …;
  const imageBase64 = await readFileBase64(input.filePath);
  return await extractionProxy({ mode: 'vision', imageBase64, caption: input.caption });
}
```

**Orchestrator** (`extraction.ts`):

The existing `processOne(sourceId)` function gains a strategy-selection step before the LLM call:

```ts
async function processOne(sourceId) {
  const source = await loadSource(sourceId);
  const input = await buildStrategyInput(source);   // reads filePath/ocrText/caption
  const strategy = pickStrategy(input, config);
  try {
    const places = await strategy.extract(input, source);
    await persistPlaces(places, source);
    await markExtractionDone(source, { extraction_strategy: strategy.name });
  } catch (err) {
    await handleExtractionError(err, source, strategy);
  }
}
```

`buildStrategyInput` is the bridge between the source row's shape and the strategy input union:

```ts
function buildStrategyInput(source: SourceRow): StrategyInput {
  if (source.kind === 'image') {
    return {
      kind: 'image',
      filePath: source.file_path,
      ocrText: source.ocr_text ?? undefined,
      caption: source.caption ?? undefined,    // set when fetched from URL
    };
  }
  if (source.kind === 'url' && source.file_path) {
    return {
      kind: 'image',
      filePath: source.file_path,
      caption: source.caption ?? undefined,
    };
  }
  if (source.kind === 'url' && source.caption) {
    // URL with caption only (no image downloaded yet / available)
    return { kind: 'text', text: source.caption };
  }
  throw new Error(`source ${source.id} has no usable input`);
}
```

### Worker `/extract` — dual mode

Current request:

```ts
type ExtractRequest = { text: string };
```

New request:

```ts
type ExtractRequest =
  | { mode: 'text'; text: string }
  | { mode: 'vision'; imageBase64: string; caption?: string };
```

Backwards-compat handling: requests without `mode` are treated as `mode: 'text'` for the duration of the rollout. After the app ships, drop the fallback.

The Gemini call uses the same JSON response schema in both modes. In `vision` mode, the Gemini SDK call passes `inline_data` for the image (mime type `image/jpeg` or `image/png` based on file header), and the caption (if present) is concatenated into the user prompt:

```
[caption preamble if provided]: <caption text>

Extract the places described or shown.
```

The system prompt (`prompt.ts`) gets a small tweak — it must work for both pure text and image+caption inputs. The bulk (category enum, JSON contract) stays.

### DB shape

No migration that changes existing data. Two additive columns:

```sql
ALTER TABLE sources ADD COLUMN fetched_via TEXT;
ALTER TABLE sources ADD COLUMN extraction_strategy TEXT;
```

Both nullable. Legacy rows have `NULL` for both — that's fine.

`ocr_status` semantics:
- For new image sources processed under `forceStrategy: 'auto'`: orchestrator sets `ocr_status='skipped'` *before* calling the strategy. The OCR sweep then ignores the row.
- Under `forceStrategy: 'ocrTextLLM'`: orchestrator leaves `ocr_status='pending'`. The OCR sweep (or the inline OCR trigger in `OcrThenTextLLM`) populates `ocr_text`.

The `processor.runOcrSweep()` code stays as-is. It already only picks rows where `ocr_status='pending'`. Under default config, no such rows exist for image sources, so the sweep is a no-op for the new flow. URL sources don't go through OCR anyway (existing condition).

### Strategy selection — full rules

```
config.forceStrategy === 'auto':
  input.kind === 'image' && caption present  → CaptionPlusVisionLLM
  input.kind === 'image' && no caption       → VisionLLMDirect
  input.kind === 'text'                      → OcrThenTextLLM
  input.kind === 'video'                     → error (reserved)

config.forceStrategy === 'ocrTextLLM':
  input.kind === 'image'                     → OcrThenTextLLM (will trigger OCR inline if needed)
  input.kind === 'text'                      → OcrThenTextLLM

config.forceStrategy === 'vision':
  input.kind === 'image'                     → VisionLLMDirect (caption ignored)
  input.kind === 'text'                      → error: vision strategy needs an image

config.forceStrategy === 'captionPlusVision':
  input.kind === 'image' && caption present  → CaptionPlusVisionLLM
  otherwise                                  → error
```

`forceStrategy` lives in `app.config.ts.extra` alongside `extractionProxyUrl` / `fetchPostProxyUrl` (the established pattern for runtime config). For dev builds it can be overridden via env; for prod it's the compiled-in default. No remote feature flag system — we ship a new build to flip it.

### Telemetry

The pipeline log (`docs/superpowers/specs/2026-05-13-pipeline-observability-design.md`) gains two fields on extraction-stage rows:

- `extraction_strategy` — which strategy ran (`vision` | `ocrTextLLM` | `captionPlusVision`)
- `fetched_via` — which fetcher returned the post (`apifyCarousel` | `tiktokOEmbed` | …) — only present for URL sources

The Cloudflare AI Gateway dashboard continues to be the source of truth for token usage and cost. Per-strategy cost rollups can be computed by joining gateway logs against `sources.extraction_strategy` if needed; not built proactively.

### Rollback plan

Three nested levels of rollback, in increasing scope:

1. **Single-stage rollback** — set `forceStrategy: 'ocrTextLLM'` in config and ship a new build. All future extractions go back to the OCR path. Existing in-flight rows finish on whichever strategy started them.
2. **Worker rollback** — revert the `/extract` worker to text-only mode. The app still ships with strategies, but `vision`-mode calls will 400. Force-flip `forceStrategy: 'ocrTextLLM'` first; then revert worker.
3. **Full revert** — revert the spec's PRs. `LinkFetcher` chain → back to inline branching. Strategy abstraction → back to direct `extractFromProxy` call. Columns `fetched_via` / `extraction_strategy` are nullable, can be left in place or dropped via a follow-up migration (`0010_drop_strategy_columns`).

Because the OCR module and `OcrThenTextLLM` strategy stay in the codebase as first-class citizens, level (1) is the expected revert path if vision quality disappoints. Levels (2) and (3) are unlikely.

## Delivery shape

Four sequenced PRs, each independently revertible:

1. **PR 1 — `LinkFetcher` chain refactor (worker only).** Extract Apify and TikTok-oEmbed handlers into `fetchers/*.ts`. Move chain runner into `fetch-post.ts`. No behavior change. Adds `fetched_via` to the response payload. Pure refactor with tests.
2. **PR 2 — Worker `/extract` vision mode.** Additive — accept `{ mode: 'vision', imageBase64, caption? }`. Existing `{ text }` payloads keep working. Add tests for both modes against a stubbed Gemini.
3. **PR 3 — App `ExtractionStrategy` abstraction.** Introduce strategies + orchestrator changes, ship with `forceStrategy: 'ocrTextLLM'`. Zero behavior change. Add the two new DB columns. Strategy unit tests with a mocked LLM.
4. **PR 4 — Flip default to `auto`.** Single-line config change. Monitor for a few days. The PR itself is small; the testing is what takes time.

## Open questions

- **Caption preamble wording in vision mode** — does the LLM extract better with `"User-supplied caption: <text>"` vs. injecting the caption directly into the user prompt? Tested empirically during PR 2 implementation. Pick whichever wins, hard-code, move on.
- **Image compression before base64** — Apple Vision works on full-resolution screenshots, but Gemini's per-tile token cost is identical for any tile ≤768×768. Downscaling to ~1024px on the long edge before sending could halve payload size with no quality loss. Decided during PR 3 implementation. Not architectural.

Neither blocks the design; both are PR-time decisions.
