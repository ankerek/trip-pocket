# Video place extraction (IG Reels, TikTok videos) — design

**Status:** draft (2026-05-16) · awaiting Codex review before implementation plan
**Touches:** `workers/extract-proxy/src/apify.ts` (mapper exposes `videoUrl`, `videoDuration`), `workers/extract-proxy/src/fetch-post.ts` (TikTok rehydration parser exposes `videoUrl`, `videoDuration`; `FetchPostResult` extended), `workers/extract-proxy/src/schema.ts` (`/extract` request schema gets `mode: 'video'` variant), `workers/extract-proxy/src/index.ts` (`/extract` handler dispatches video mode; new error taxonomy), `workers/extract-proxy/src/prompt.ts` (one-line addendum to the system prompt for video media), `workers/extract-proxy/src/video.ts` (new — fetch + Gemini call mechanics: range fetch with size cap, inline vs Files API selection, Files API polling + cleanup), `modules/extraction/strategies/types.ts` (`StrategyInput` gets `video` variant; `StrategyName` adds `'videoPlusCaption'`), `modules/extraction/strategies/videoPlusCaption.ts` (new strategy), `modules/extraction/strategies/select.ts` (`ForceStrategy` adds `'video'`; `strategyForUrlAfterFetch` takes `hasVideo`), `modules/extraction/proxy.ts` (request payload for `mode: 'video'`), `modules/extraction/extraction.ts` (extraction sweep gate adds `'videoPlusCaption'` to the no-OCR branch; error classification for video errors), `modules/storage/sources.ts` (`ExtractionStrategyName` adds `'videoPlusCaption'`), `app.config.ts` (`forceStrategy` extra accepts `'video'`).
**Milestone:** v0.4 — extraction quality / canonicalisation (follows rev-2 composable pipeline).
**Prereq:** [2026-05-16-extraction-pipeline-composability-design.md](2026-05-16-extraction-pipeline-composability-design.md) — this spec is the explicit "video follow-up" called out in that doc's §Scope and in the `// NOTE for future maintainers` comment at `modules/extraction/strategies/types.ts:3`.

## Why

Today the pipeline extracts places from IG/TikTok video posts using only the **cover image plus caption**. Apify (IG) and TikTok rehydration both return a single cover frame; the worker `/extract` runs Gemini Flash-Lite on caption + cover. For Reels and TikToks where the place is named only in **on-screen text overlays** (a title card on frame 0, a "📍 Maison Pic" overlay at 0:08), the cover frame frequently doesn't contain the overlay and the caption is empty or vague — the place is silently dropped.

Two things make a video strategy worth building now rather than later:

1. **Gemini 2.5 Flash-Lite already accepts video natively.** Default 1 frame/sec sampling reads on-screen text across the whole video plus audio, in a single `generateContent` call. No client-side ffmpeg, no thumbnail-extraction vendor, no separate transcription step. The same model, prompt, response schema, and AI Gateway route as the existing vision strategy — only the media part of the request changes.
2. **Apify's `instagram-post-scraper` already returns `videoUrl` and `videoDuration`** at the `dataDetailLevel: "detailedData"` level we already use for carousels. TikTok's rehydration JSON exposes `video.playAddr` and `video.duration`. The data is already on the wire — the worker just isn't reading it.

The composability spec (rev 2) was shaped precisely so this follow-up could be additive: `FetchPostResult`, `StrategyInput`, and `/extract`'s discriminated request schema were all left "ready for a `video` variant" with a `NOTE for future maintainers` pointer in code. This spec is that variant.

## Scope

In scope:

- **Worker `/fetch-post` exposes `videoUrl` and `videoDuration`** for IG Reels (via the Apify mapper) and TikTok videos (via the rehydration parser). Both fields are optional on `FetchPostResult`; absent means "not a video".
- **Worker `/extract` accepts `mode: 'video'`** with payload `{ video: { url }, caption? }`. Worker fetches the CDN URL directly with a 20 s timeout and a 25 MB hard cap on the body, then sends to Gemini Flash-Lite inline (`<20 MB`) or via the Files API (`≥20 MB`). Same `gemini-2.5-flash-lite` model, same `GEMINI_RESPONSE_SCHEMA`, same prompt with a one-line video addendum.
- **New strategy `videoPlusCaption`** in `modules/extraction/strategies/`. Calls worker `/extract mode=video` with `(videoUrl, caption)`. On video-related error classes, falls back internally to `captionPlusVision` (cover image + caption) — the orchestrator sees a single strategy result with `fallback_used` in the pipeline-log extras.
- **Orchestrator picks `videoPlusCaption` whenever `videoUrl` is present** after `/fetch-post` returns. `strategyForUrlAfterFetch` gains a `hasVideo` parameter; auto path returns `'videoPlusCaption'` when `hasVideo`.
- **`forceStrategy` extra accepts `'video'`** as a developer/A-B override. `videoPlusCaption` is **not** a forceable value — it only fires via `auto` when a video is present (mirrors the rev-2 convention that `captionPlusVision` only fires via `auto`).
- **Telemetry**: `extraction_strategy='videoPlusCaption'` written to the row at stamp time; `fallback_used: boolean` added to the existing JSON-shaped `pipeline_log` extras column. No schema migration (extras column is already free-form JSON; `extraction_strategy` is plain `TEXT`).
- **Worker-side `User-Agent` and `Referer` headers** on the CDN fetch (browser-like UA, platform-matching Referer). TikTok refuses video bytes without a matching Referer.

Not in scope:

- **Apify-as-second-fetcher proxy fallback.** Future-additive via the existing fetcher chain. Add if direct-CDN 403 rate from Cloudflare egress IPs becomes material (>20 % of video calls). The seam (`fetchers/chain.ts`) is already in place.
- **Re-extraction of video rows.** CDN URLs are signed and expire within hours; re-running extraction on an old row would 404. We do not store `video_url` on `sources` and we do not support re-extraction for video rows. (Re-extraction for non-video rows is unaffected.)
- **Storing video bytes on the device.** Phone never downloads the video. Cellular and storage cost both unacceptable.
- **Audio-only extraction signal.** Caption + on-screen text overlays cover the cases users actually save (confirmed in brainstorming). Gemini sees the audio anyway as part of video input; we do not build a transcription-only path.
- **Long-form video (>90 s).** Rejected at the worker. Users who want to save tutorials can screenshot the title card.
- **Per-user A/B testing.** `forceStrategy` is global, compiled-in. Matches rev-2.
- **DI framework / plugin loader.** Strategies remain TS modules in an ordered array.

## Decisions

**Always video when videoUrl is present, never as an escalation.** Auto-picker fires `videoPlusCaption` for any row with a videoUrl. Reasons:

- Cover image is a subset of video input — there's no quality reason to prefer cover-only when video is available.
- Escalation ("try caption+cover first, video only if 0 places") doubles the LLM call count in the bad case and adds a "what counts as low confidence" judgment we don't want to defend.
- Cost is pennies per video at Flash-Lite's input price (~$0.001 for a 60 s Reel at 258 tokens/sec sampling). Even at 50 video saves/user/month, well inside $39.99 ARPU.

**Strategy is stamped at row-creation time** (matches rev 2). For URL sources the strategy stamps **after** `/fetch-post` returns (today's pattern at `modules/extraction/strategies/select.ts:49`). `strategyForUrlAfterFetch` gets a `hasVideo` parameter:

```
hasVideo  hasFile  hasCap  force=auto         force=video        force=vision  force=ocrTextLLM
true      *        *       videoPlusCaption   videoPlusCaption   vision        ocrTextLLM
false     true     true    captionPlusVision  ocrTextLLM*        vision        ocrTextLLM
false     true     false   vision             ocrTextLLM*        vision        ocrTextLLM
false     false    *       ocrTextLLM         ocrTextLLM         ocrTextLLM    ocrTextLLM
```

*`force=video` on a row without video soft-degrades to `ocrTextLLM`, matching the existing pattern where `force=vision` on a row without a file soft-degrades the same way. The forced value names the *preferred* strategy; absent prerequisites send it down the safe path.

**Video URL is consumed in-memory, never stored.** The URL-share flow already runs `/fetch-post` → strategy → `/extract` in one synchronous user-facing operation. The videoUrl flows through that path in memory, hits the worker within seconds of being issued, and is discarded. Adding a `video_url` column would imply re-extraction support we explicitly don't offer.

**Fallback is internal to `videoPlusCaption`, not a chain at the orchestrator.** Reasons:

- The orchestrator's sweep gate is already complex (rev-2 §Sweep queries). A "try strategy A; on failure switch to strategy B" state machine adds another dimension.
- The fallback path is exactly `captionPlusVision`'s extract call with the cover image — re-use, not re-implement.
- Logged as `extraction_strategy='videoPlusCaption'` + `fallback_used=true` in the pipeline-log extras. The dashboard distinguishes "video succeeded" from "video succeeded via fallback" cleanly.

**Sweep query change is one line.** Only the extraction sweep changes; OCR sweep is unaffected (video rows never need OCR):

```sql
-- Extraction sweep, no-OCR branch (modules/extraction/extraction.ts)
extraction_strategy IN ('vision', 'captionPlusVision', 'videoPlusCaption')
```

**No new DB migration.** `extraction_strategy` is plain `TEXT` (verified at `modules/storage/migrations/0010_extraction_strategy_columns.ts:22`); the `'videoPlusCaption'` value adds without ALTER. `pipeline_log` extras is JSON-shaped; the `fallback_used` field adds without ALTER. The `ExtractionStrategyName` TS union (`modules/storage/sources.ts:13`) gains `'videoPlusCaption'` — this is a TS-only change.

## Architecture

### Seam 1 — fetcher exposes video metadata

**IG (Apify).** `mapApifyItem` (`workers/extract-proxy/src/apify.ts:155`) reads `raw.videoUrl` and `raw.videoDuration` and returns them alongside the existing fields:

```ts
export type ApifyInstagramPost = {
  caption: string;
  imageUrls: string[];
  author: string | null;
  permalink: string;
  videoUrl: string | null;        // NEW
  videoDuration: number | null;   // NEW — seconds
};
```

The actor returns `videoUrl` and `videoDuration` for `type: 'Video'` and for video children inside `type: 'Sidecar'`. We populate both fields only when the **top-level** post is a video — carousel videos aren't in scope for the first cut (the orchestrator still picks `captionPlusVision` for image carousels). The mapper writes `null` for image posts.

**TikTok (rehydration).** The existing parser in `workers/extract-proxy/src/fetch-post.ts` (~line 666, `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob) reads `video.playAddr` (or `video.downloadAddr`) and `video.duration`. Same nullable fields on the platform's specific result type.

**`FetchPostResult` extends:**

```ts
export type FetchPostResult = {
  platform: 'instagram' | 'tiktok';
  permalink: string;
  caption: string;
  imageUrls: string[];           // cover image stays here for fallback
  author: string | null;
  videoUrl?: string | null;      // NEW
  videoDuration?: number | null; // NEW — seconds
  _debug?: FetchPostDebug;
};
```

No new fetcher class — both existing fetchers learn to read two more fields from upstream.

### Seam 2 — `videoPlusCaption` strategy (app-side)

```ts
// modules/extraction/strategies/types.ts
export type StrategyInput =
  | { kind: 'image'; filePath: string; ocrText?: string; caption?: string }
  | { kind: 'text';  text: string }
  | { kind: 'video'; videoUrl: string; caption?: string; coverFilePath?: string }; // NEW

export type StrategyName =
  | 'ocrTextLLM'
  | 'vision'
  | 'captionPlusVision'
  | 'videoPlusCaption';                                              // NEW
```

```ts
// modules/extraction/strategies/videoPlusCaption.ts (new)
export function createVideoPlusCaption(opts: {
  proxy: ExtractionProxy;
  fallback: ExtractionStrategy;   // captionPlusVision wired by the orchestrator
}): ExtractionStrategy {
  return {
    name: 'videoPlusCaption',
    async extract(input) {
      if (input.kind !== 'video') return { error: 'wrong-input-kind' };
      try {
        return await opts.proxy.extractVideo({
          videoUrl: input.videoUrl,
          caption: input.caption,
        });
      } catch (err) {
        if (isVideoFallbackError(err)) {
          // Fallback: cover image + caption. The strategy result records
          // fallback_used=true via the proxy's pipeline-log extras.
          return opts.fallback.extract({
            kind: 'image',
            filePath: input.coverFilePath,  // wired by orchestrator
            caption: input.caption,
          });
        }
        throw err;
      }
    },
  };
}
```

Note the `coverFilePath` threading: the strategy needs the cover image on disk to invoke `captionPlusVision` as the fallback path. The orchestrator already downloads the cover (it's in `imageUrls[0]`) before stamping the strategy, so the file path exists. The `kind: 'video'` variant carries `coverFilePath?: string` as a sibling field (kept optional because IG/TikTok always have a cover today, but the type allows future video sources that don't — in which case the fallback degrades to plain `ocrTextLLM` on caption text).

**Fallback error classes** (`isVideoFallbackError`):
- `video-fetch-timeout`, `video-fetch-network`, `video-fetch-4xx`, `video-fetch-5xx` → retryable up the orchestrator chain, but the strategy itself catches and tries fallback first to keep `/extract` invocation count low. The retry-on-orchestrator path only kicks in if fallback *also* fails.
- `video-too-large`, `video-too-long`, `video-processing-timeout` → non-retryable, immediate fallback.
- `gemini-video-failed`, `gemini-video-empty` → fallback once; no second LLM call beyond the fallback.

### Worker `/extract` — video mode

**Request schema additions (`workers/extract-proxy/src/schema.ts`):**

```ts
const videoModeRequestSchema = z.object({
  mode: z.literal('video'),
  video: z.object({ url: z.string().url() }),
  caption: z.string().optional(),
});

export const requestBodySchema = z.discriminatedUnion('mode', [
  textModeRequestSchema,
  visionModeRequestSchema,
  videoModeRequestSchema,         // NEW
]);
```

**Handler dispatch (`workers/extract-proxy/src/index.ts`):** existing `handleExtract` gets a third branch that calls `handleVideoExtract` (new, in `workers/extract-proxy/src/video.ts`).

**`workers/extract-proxy/src/video.ts` — fetch + Gemini mechanics:**

1. **Fetch the CDN URL.** `fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Referer': referer }, signal: AbortSignal.timeout(20_000) })`. The `referer` is derived from the platform inferred from the URL (`https://www.instagram.com/` for `cdninstagram.com` / `fbcdn.net`; `https://www.tiktok.com/` for `tiktok.com` / `tiktokcdn`). Stream the body; abort and throw `video-too-large` if cumulative bytes exceed 25 MB. Map non-2xx as `video-fetch-4xx` / `video-fetch-5xx`.

2. **Pick transport.** Bytes `<20 MB` → inline data in the `generateContent` request. Bytes `≥20 MB` (we'll see this only on the upper tail) → Files API:
   - `POST {GOOGLE_GENAI_BASE}/upload/v1beta/files` with `Content-Type: video/mp4` and resumable upload protocol; we use the simple `media` upload type (one-shot) because we already have the bytes in worker memory.
   - Poll `GET /v1beta/files/{name}` every 1 s, max 8 polls (8 s ceiling). If `state` still `PROCESSING`, abort with `video-processing-timeout`.
   - `generateContent` referencing `file_data.file_uri` and `file_data.mime_type`.
   - Best-effort `DELETE /v1beta/files/{name}` after the response. Failure logged, not surfaced.

3. **Prompt.** Same system prompt as vision mode plus one line: *"The media is a short video — read on-screen text overlays carefully; spoken audio is also available."* Caption (if any) is appended to the user message text alongside the media part. Identical `GEMINI_RESPONSE_SCHEMA` for structured output.

4. **Cost & budget.** Flash-Lite charges video at the standard input-token rate; default sampling is 1 fps with audio. A 60 s Reel ≈ 15 k input tokens. Worker wall-clock budget: fetch (≤5 s) + Files API upload+poll (≤8 s) + Gemini generate (5–15 s) ≈ 10–25 s. Inside the 30 s Workers wall-clock; AI Gateway logging unchanged.

5. **Duration guardrail.** The strategy passes `videoDuration` from `/fetch-post` if present. Worker rejects `>90` as `video-too-long` *before* fetching the bytes — saves an unnecessary download. Defense in depth: the 25 MB byte cap covers most "too long" cases when duration is absent.

### Debug echo & telemetry

`fetchPostDebugSchema.route` (in `workers/extract-proxy/src/fetch-post.ts`) gains: `'apify_video_ok'`, `'tiktok_rehyd_video_ok'`. `/extract` debug echo adds `videoOutcome` (closed vocab: `not_called | ok | empty | too_large | too_long | fetch_timeout | fetch_4xx | fetch_5xx | processing_timeout | gemini_failed | gemini_empty`) and `transport` (`inline | files_api`). These already flow through to the firehose extras column via rev-2's pipeline-observability spec — no schema change.

App-side, the strategy writes one new key into the pipeline-log extras: `fallback_used: boolean`. The existing `extraction_strategy` field on the row stays `'videoPlusCaption'` regardless of whether fallback fired (the *strategy that ran* didn't change — its internal path did).

### Rollback plan

- **Kill switch (no deploy).** Set `extra.forceStrategy = 'ocrTextLLM'` in the next build → all rows skip vision/video paths. (Existing rev-2 escape hatch; this spec doesn't change it.)
- **Disable just video without disabling vision.** Add a one-line `auto-noVideo` mode to `strategyForUrlAfterFetch` returning `'captionPlusVision'` whenever `hasVideo`. Cheap to add if/when needed; not built up-front (YAGNI).
- **Revert.** Worker change is additive to the discriminated union; reverting the app side leaves the worker harmlessly capable of handling `mode: 'video'` requests that never arrive.

## Delivery shape

One PR / one commit to `main`. Worker, app, and TS-type changes ship together; the worker change is additive and harmless without app callers, but there's no value shipping it ahead of the app for a single-developer codebase.

Rollout posture: `forceStrategy: 'auto'` (default). TestFlight build watches the pipeline firehose for `videoPlusCaption` success vs `fallback_used` rates. If `fallback_used` rate is high (>20 %), revisit the Apify-proxy fetcher idea from §Not in scope.

## Open questions

- **Cover image always present for IG Reels?** Apify returns `displayUrl` for Reels (the thumbnail) — confirmed. For TikTok, the rehydration JSON has a `cover` URL. If either platform's response ever lacks a cover, the fallback to `captionPlusVision` becomes impossible. The strategy degrades to plain `ocrTextLLM` with caption as text input in that case — covered by `strategyForUrlAfterFetch`'s `!hasFile` branch.
- **TikTok videoUrl auth quirks.** Some TikTok `playAddr` URLs need a session cookie set by an earlier rehydration response. If we see 403s in TestFlight, the fix is to forward cookies the rehydration fetch already set. Not pre-built — observed-first.
- **Inline vs Files API split point.** Gemini docs say inline tops out at "20 MB total request size". Our cutoff is conservative; we may move it down to 18 MB after observing the actual request overhead.
