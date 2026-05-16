# Video place extraction (IG Reels, TikTok videos) — design

**Status:** draft (2026-05-17, rev 2) · incorporates Codex review · awaiting implementation plan
**Touches:** `workers/extract-proxy/src/apify.ts` (mapper exposes `videoUrl`, `videoDuration`), `workers/extract-proxy/src/fetch-post.ts` (TikTok rehydration parser exposes `videoUrl`, `videoDuration`; `FetchPostResult` extended), `workers/extract-proxy/src/schema.ts` (`/extract` request schema gets `mode: 'video'` variant), `workers/extract-proxy/src/index.ts` (`/extract` handler dispatches video mode; new error taxonomy), `workers/extract-proxy/src/prompt.ts` (one-line addendum to the system prompt for video media), `workers/extract-proxy/src/video.ts` (new — fetch + Gemini call mechanics: streamed fetch with 25 MB cap, inline vs Files API selection, two-step resumable upload, polling, `ctx.waitUntil` cleanup), `modules/extraction/strategies/types.ts` (`StrategyInput` gets `video` variant; `StrategyName` adds `'videoPlusCaption'`), `modules/extraction/strategies/videoPlusCaption.ts` (new strategy), `modules/extraction/strategies/select.ts` (`ForceStrategy` adds `'video'`; `strategyForUrlAfterFetch` takes `hasVideo`), `modules/extraction/proxy.ts` (request payload for `mode: 'video'`), `modules/extraction/extraction.ts` (`ExtractionResult` gains optional `telemetry?: { fallbackUsed?: boolean }` field at `extraction.ts:22`; extraction sweep gate adds `'videoPlusCaption'` to the no-OCR branch; error classification for video errors), `modules/storage/sources.ts` (`ExtractionStrategyName` adds `'videoPlusCaption'`), `app.config.ts` (`forceStrategy` extra accepts `'video'`).
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
- Cost is pennies per video at Flash-Lite's pricing. Token rate is ~258 frame tokens/sec + ~32 audio tokens/sec ≈ 290 tokens/sec; a 60 s Reel ≈ 17.4 k input tokens. Flash-Lite pricing (2026-05-17): $0.10/M input (text/image/video), $0.30/M audio tokens. 60 s Reel ≈ **$0.002 input + output** — round to one-fifth of a cent. Even at 50 video saves/user/month, well inside $39.99 ARPU.

**Strategy is stamped at row-creation time** (matches rev 2). For URL sources the strategy stamps **after** `/fetch-post` returns (today's pattern at `modules/extraction/strategies/select.ts:49`). `strategyForUrlAfterFetch` gets a `hasVideo` parameter:

```
hasVideo  hasFile  hasCap  force=auto         force=video        force=vision  force=ocrTextLLM
true      true     *       videoPlusCaption   videoPlusCaption   vision        ocrTextLLM
true      false    *       ocrTextLLM*        ocrTextLLM*        ocrTextLLM*   ocrTextLLM
false     true     true    captionPlusVision  ocrTextLLM*        vision        ocrTextLLM
false     true     false   vision             ocrTextLLM*        vision        ocrTextLLM
false     false    *       ocrTextLLM         ocrTextLLM         ocrTextLLM    ocrTextLLM
```

*Soft-degrade. `videoPlusCaption` requires a cover file (the type system enforces this — see the discriminated `kind: 'video'` variant), so a video without a downloadable cover falls back to `ocrTextLLM` on caption text. `force=video` on a row without a video, and `force=vision` on a row without a file, follow the same convention: the forced value names the *preferred* strategy; absent prerequisites send the row down the safe path.

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
  | { kind: 'video'; videoUrl: string; coverFilePath: string; caption?: string }; // NEW

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
      if (input.kind !== 'video') {
        // Type-level invariant; runtime guard for defense in depth.
        return { places: [], error: 'wrong-input-kind' };
      }
      try {
        return await opts.proxy.extractVideo({
          videoUrl: input.videoUrl,
          caption: input.caption,
        });
      } catch (err) {
        if (!isVideoFallbackError(err)) throw err;
        // Fallback: cover image + caption. coverFilePath is required by
        // the discriminated 'video' variant — no undefined to guard.
        const result = await opts.fallback.extract({
          kind: 'image',
          filePath: input.coverFilePath,
          caption: input.caption,
        });
        return { ...result, telemetry: { ...result.telemetry, fallbackUsed: true } };
      }
    },
  };
}
```

Note the `coverFilePath` threading: the strategy needs the cover image on disk to invoke `captionPlusVision` as the fallback path. The `kind: 'video'` variant requires `coverFilePath: string` — the type system refuses to construct a video input without one, so the fallback `opts.fallback.extract({ kind: 'image', filePath: input.coverFilePath, … })` is always well-typed. The orchestrator is responsible for downloading `imageUrls[0]` and supplying the path; if a row truly has no cover (rare; IG/TikTok always include one today), `strategyForUrlAfterFetch` returns `'ocrTextLLM'` instead of `'videoPlusCaption'` — the `hasFile=false` row in the table below.

**Fallback error classes** (`isVideoFallbackError`) — only infrastructure-level failures fall back. Empty extraction results (Gemini returned successfully but found no places) are **not** treated as errors; they propagate as a valid zero-place result. This matches rev-2's rule that fallback is for infra errors, not for "the model didn't find anything".

- `video-fetch-timeout`, `video-fetch-network`, `video-fetch-4xx`, `video-fetch-5xx` → infra failure, immediate fallback to `captionPlusVision`. The retryable nature is preserved by the orchestrator only if fallback *also* fails.
- `video-too-large`, `video-too-long`, `files-api-failed`, `files-api-processing-timeout` → non-retryable, immediate fallback.
- `upload-start-failed`, `upload-finalize-failed` → infra failure, immediate fallback.
- `gemini-video-failed` (transport error from Gemini, not a content rejection) → fallback.
- `gemini-safety-blocked` → **non-retryable, no fallback** — the cover image will almost certainly trip the same filter. Surface as a permanent failure on the row.
- `gemini-rate-limited` (AI Gateway / Gemini 429) → **deferred, no fallback** — match the existing proxy convention of returning a retry-after to the client. Falling back would burn token budget unnecessarily and mask the real signal.
- `gemini-video-empty` → **not a fallback class**. Gemini ran successfully and returned an empty places array. Return as-is.

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

1. **Fetch the CDN URL.** Mirror the existing `AbortController + setTimeout` pattern used at `workers/extract-proxy/src/apify.ts:90` (rather than `AbortSignal.timeout`, which we haven't verified inside the Workers runtime — keep one timeout idiom across the codebase). Headers: browser-like `User-Agent`, and a platform-matching `Referer` (`https://www.instagram.com/` for `cdninstagram.com` / `fbcdn.net`; `https://www.tiktok.com/` for `tiktok.com` / `tiktokcdn`). Stream the response body via `ReadableStream` and accumulate bytes in a `Uint8Array` buffer; if cumulative bytes exceed 25 MB, cancel the stream and throw `video-too-large` (never pass a truncated buffer to Gemini — partial bytes are not a valid video). Map non-2xx as `video-fetch-4xx` / `video-fetch-5xx`. Network errors / timeouts map to `video-fetch-timeout` / `video-fetch-network`.

2. **Pick transport.** Bytes `<20 MB` → inline data (`inline_data: { mime_type, data }`) in the `generateContent` request. Bytes `≥20 MB` → Files API two-step resumable upload (per `ai.google.dev/gemini-api/docs/files`):
   - **Start:** `POST {GOOGLE_GENAI_BASE}/upload/v1beta/files?upload_protocol=resumable` with header `X-Goog-Upload-Command: start` and metadata body `{ file: { mime_type: 'video/mp4', display_name } }`. Response header `X-Goog-Upload-URL` is the per-upload finalize URL. Failure → `upload-start-failed`.
   - **Upload + finalize:** `POST {upload_url}` with headers `X-Goog-Upload-Command: upload, finalize` and `X-Goog-Upload-Offset: 0`, body = the raw bytes. Response is the `{ file }` resource with `state: 'PROCESSING'` or `'ACTIVE'`. Failure → `upload-finalize-failed`.
   - **Poll** `GET /v1beta/files/{name}` every 1 s, max 8 polls. Terminal states: `ACTIVE` (continue), `FAILED` (→ `files-api-failed`). Still `PROCESSING` after 8 polls → `files-api-processing-timeout`.
   - **Generate** referencing `file_data: { file_uri, mime_type }` instead of `inline_data`.
   - **Cleanup** via `ctx.waitUntil(fetch(DELETE /v1beta/files/{name}))` — fire-and-forget, does not block the response to the phone. Delete failures are logged as `delete-failed` but never surfaced; Google auto-cleans Files API entries after 48 h anyway, so an orphan is bounded waste.

3. **Prompt.** Same system prompt as vision mode plus one line: *"The media is a short video — read on-screen text overlays carefully; spoken audio is also available."* Caption (if any) is appended to the user message text alongside the media part. Identical `GEMINI_RESPONSE_SCHEMA` for structured output. **Unverified:** structured output + video together through AI Gateway. First TestFlight build acts as the spike — see §Open questions.

4. **Budget.** Cloudflare Workers paid plan: 30 s CPU time per request, no hard HTTP wall-clock as long as the client stays connected. Our own CPU work (fetch streaming, base64 encoding when inline, JSON construction) is well under 1 s; the rest is network wait that doesn't burn CPU budget. Subrequest count: fetch + (inline → 1 generate) OR (start + finalize + ≤8 polls + generate + delete ≈ 12) — well under the Workers 50-subrequest limit. Expected end-to-end latency: fetch p50 ≤5 s (hard cap 20 s), Files API upload+poll ≤8 s, Gemini generate 5–15 s.

5. **Duration guardrail.** The strategy passes `videoDuration` from `/fetch-post` if present. Worker rejects `>90` as `video-too-long` *before* fetching the bytes — saves an unnecessary download. Defense in depth: the 25 MB byte cap covers most "too long" cases when duration is absent.

6. **Memory note.** 25 MB raw bytes + base64 (≈33 MB) + the JSON-encoded request to Gemini fits in the 128 MB Workers isolate memory limit, but the inline path is the worst case. For files at the inline cutoff, keep `inline_data` strict at <20 MB and prefer the Files API path slightly conservatively (e.g., cut over at 18 MB) — already flagged in §Open questions.

### Debug echo & telemetry

`fetchPostDebugSchema.route` (in `workers/extract-proxy/src/fetch-post.ts`) gains: `'apify_video_ok'`, `'tiktok_rehyd_video_ok'`. `/extract` debug echo adds:
- `videoOutcome` — closed vocab: `not_called | ok | empty | too_large | too_long | fetch_timeout | fetch_network | fetch_4xx | fetch_5xx | upload_start_failed | upload_finalize_failed | files_api_failed | files_api_processing_timeout | gemini_failed | gemini_safety_blocked | gemini_rate_limited | delete_failed`.
- `transport` — `inline | files_api | not_called`.

These already flow through to the firehose extras column via rev-2's pipeline-observability spec — no schema change.

App-side, `fallback_used: boolean` reaches the pipeline log via an explicit telemetry channel: `ExtractionResult` gains an optional `telemetry?: { fallbackUsed?: boolean }` field, populated by the `videoPlusCaption` strategy when the fallback path executes. The proxy's pipeline-log writer copies `telemetry.*` keys into the extras JSON column. The `extraction_strategy` field on the row stays `'videoPlusCaption'` regardless of whether fallback fired (the *strategy that ran* didn't change — its internal path did). This keeps the existing single-strategy-per-row invariant intact while still surfacing the path divergence in observability.

### Rollback plan

- **Kill switch (no deploy).** Set `extra.forceStrategy = 'ocrTextLLM'` in the next build → all rows skip vision/video paths. (Existing rev-2 escape hatch; this spec doesn't change it.)
- **Disable just video without disabling vision.** Add a one-line `auto-noVideo` mode to `strategyForUrlAfterFetch` returning `'captionPlusVision'` whenever `hasVideo`. Cheap to add if/when needed; not built up-front (YAGNI).
- **Revert.** Worker change is additive to the discriminated union; reverting the app side leaves the worker harmlessly capable of handling `mode: 'video'` requests that never arrive.

## Delivery shape

One PR / one commit to `main`. Worker, app, and TS-type changes ship together; the worker change is additive and harmless without app callers, but there's no value shipping it ahead of the app for a single-developer codebase.

Rollout posture: `forceStrategy: 'auto'` (default). TestFlight build watches the pipeline firehose for `videoPlusCaption` success vs `fallback_used` rates. If `fallback_used` rate is high (>20 %), revisit the Apify-proxy fetcher idea from §Not in scope.

## Open questions

- **AI Gateway + video + structured output, end-to-end.** None of these three combinations is verified in code today: video bytes through AI Gateway, video + `responseSchema` together, Files API URIs through AI Gateway. The first TestFlight build acts as the integration spike — one IG Reel + one TikTok video, behind `forceStrategy: 'video'` for the developer, before flipping to `'auto'`.
- **Cover image always present for IG Reels?** Apify returns `displayUrl` for Reels (the thumbnail) — confirmed. For TikTok, the rehydration JSON has a `cover` URL. If either platform's response ever lacks a cover, the row falls into the `hasVideo=true, hasFile=false` row of the strategy table and is processed by `ocrTextLLM` on the caption.
- **TikTok videoUrl auth quirks.** Some TikTok `playAddr` URLs need a session cookie set by an earlier rehydration response. If we see 403s in TestFlight, the fix is to forward cookies the rehydration fetch already set. Not pre-built — observed-first.
- **Inline vs Files API split point.** Gemini docs say inline tops out at "20 MB total request size". Our cutoff is conservative; we may move it down to 18 MB after observing the actual request overhead and the Workers memory headroom under load.
- **IG / TikTok CDN blocking Cloudflare egress IPs.** Not a verified premise; treated as a risk. If `video-fetch-4xx` rate is non-trivial in TestFlight, the mitigation is the Apify-proxy fetcher in §Not in scope — drop-in via the existing fetcher chain.
