# Apify-backed Instagram scraping — design

**Status:** design (2026-05-12). Amends [`2026-05-12-url-share-extraction-design.md`](./2026-05-12-url-share-extraction-design.md) — reintroduces the carousel-slide path that was descoped from v0.2.1, and pre-positions us on rung 3c of that spec's IG longevity-risk pivot ladder.
**Targets:** v0.2.x follow-up after URL-share lands. Worker- and pipeline-only change; no new app screens.

## Why

The shipped URL-share pipeline extracts caption + slide-1 cover via `og:*` meta tags on the canonical IG post URL. That's free and fast, but it leaves two holes:

1. **Carousel slides 2..N are unreachable.** IG loads them client-side. Travel content disproportionately uses carousels ("6 spots in Tokyo: 1/ …, 2/ …"), and place names that don't fit in the caption end up on later slides — which we never OCR. Observed in practice.
2. **No hedge against IG breaking og:.** The v0.2.1 spec's longevity-risk section lists a pivot ladder (UA rotation → CF Browser Rendering → paid scraper). This spec lands the last rung as a normal fallback rather than waiting for a fire-drill.

Apify's `sones/instagram-posts-scraper-lowcost` actor returns the full carousel (`childPosts[].displayUrl`) and the caption — same canonical URL input, structured JSON output. At **$0.30 per 1000 results**, it's economically viable to call on a fraction of shares (carousels + og: failures) without changing the cost shape of the product.

## Scope

**In scope:**
- New worker dispatch in `/fetch-post`: og: stays the cheap fast-path; Apify fires for IG carousels and og: failures.
- Apify integration (`APIFY_TOKEN`, `APIFY_ACTOR_ID`) with the actor pluggable via env.
- Phone-side multi-image OCR for carousels — download all slides, OCR each, concat into `sources.ocr_text`, then drop temp slide files. Cover (slide 1) remains the only persisted image.
- Worker-side caching of Apify responses (7d).
- Telemetry: per-request route, og: outcome, Apify outcome, cache hit/miss.

**Not in scope:**
- TikTok via Apify — TikTok stays on og: + oEmbed.
- Persisting slides 2..N to disk. The WebView pulls them live from IG's CDN; local cache only holds the cover.
- Rich metadata storage (likes, hashtags, mentions, alt text, video URL). Apify returns these; we still don't store any.
- A "rescrape" or "refresh source" user action. Content-hash dedupe handles intentional re-shares.
- Switching to the official `apify/instagram-post-scraper` — it remains a runtime env swap, not a code change.

## Worker dispatch — `/fetch-post`

Public contract unchanged. Internally, IG processing becomes a 2-stage pipeline. **Invariant:** when Apify fires, its response is authoritative; og: output is discarded.

### Stage 1 — og: parse on canonical URL (always; free)

Same as today's IG handler. Adds one new behavior: decode the base64 `efg` query param on `og:image` to categorize the post type — `single`, `clips` (reel), or `carousel`. This is the cheapest signal we have and avoids paying Apify for non-carousel posts.

### Stage 2 — Apify (only when needed)

Calls `sones/instagram-posts-scraper-lowcost` (configurable via `APIFY_ACTOR_ID`). Input: the canonical IG URL. Output: a single dataset item with `caption`, `type`, `displayUrl` (cover), and `childPosts[].displayUrl` (slides 2..N for carousels).

### Dispatch matrix

| URL shape | og: fetch | `efg` hint | Apify fires? | Final response source |
|---|---|---|---|---|
| `/reel/`, `/tv/` | yes | n/a | no | og: |
| `/p/` | yes | `single` | no | og: |
| `/p/` | yes | `CAROUSEL_ITEM` | **yes** | **Apify** (og: discarded) |
| `/p/` | yes | unknown / missing / decode-fail | **yes** | **Apify** (og: discarded) |
| any | failed / empty | n/a | yes | Apify (full replacement) |

og: is still fetched for `/p/` posts because that's how we cheaply distinguish single from carousel. The fetch is sub-second; we discard its body when Apify fires.

**Unknown `efg` defaults to carousel-treatment.** If the `efg` query param is missing on `og:image`, the base64 decode fails, or the decoded token isn't in `{single, CAROUSEL_ITEM, CLIPS}`, the worker calls Apify. Rationale: extraction quality matters more than the marginal Apify cost, and an "unknown" reading is a canary for IG changing its og-tag generation pipeline. The `route` telemetry field tags these calls as `og_then_apify_unknown_efg` so we can see if the unknown rate climbs and update the decoder.

### Response shape (extends v0.2.1)

```json
{
  "platform": "instagram",
  "permalink": "https://www.instagram.com/p/ABC123/",
  "caption": "Best ramen in Shibuya — 1/ Maru Tonkatsu …",
  "imageUrls": [
    "https://scontent.../cover.jpg",
    "https://scontent.../slide2.jpg",
    "https://scontent.../slide3.jpg"
  ],
  "author": "@foodietravels"
}
```

`imageUrls[0]` is always the cover. For carousels, `imageUrls[1..N]` are the additional slides from Apify's `childPosts`. For single posts and reels, the array has length 1.

**Error response shape unchanged from v0.2.1.** All terminal failures — whether og: failed and Apify-fallback also failed, or a known-carousel Apify call failed — emit the existing `502 fetch_failed`. The phone-side UX is identical for every terminal failure (tile placeholder + "couldn't load — re-share to retry"), so the worker doesn't need a new code to disambiguate. The carousel-vs-not distinction lives entirely in worker telemetry (`route` + `apify_outcome` fields, see Telemetry section).

## Actor choice and cost model

**Selected:** `sones/instagram-posts-scraper-lowcost` at **$0.30 per 1000 results** (HTTP-only, no headless browser).

| | Official `apify/instagram-post-scraper` | Lowcost `sones/instagram-posts-scraper-lowcost` |
|---|---|---|
| Price | $2.30–2.70 / 1000 | $0.30 / 1000 |
| Engine | Headless browser | HTTP-only |
| Free-tier capacity | ~2k / mo | ~16k / mo |
| Maintainer | Apify | Third-party |

The actor is pluggable. `APIFY_ACTOR_ID` is a Wrangler env var; swapping to the official actor is a config change. The worker normalizes the actor's output into the response shape above:

```
imageUrls = [item.displayUrl, ...(item.childPosts ?? []).map(c => c.displayUrl)]
caption   = item.caption
author    = item.ownerUsername
```

The official `apify/instagram-post-scraper` exposes these fields exactly; the lowcost actor advertises the same shape but its mapping needs validation during implementation (see open questions).

**Cost ceiling (illustrative):** 1000 active users × 20 IG saves/week × 4.3 wk × 30% Apify-call rate (carousels + og: failures) ≈ 26k Apify calls/month → ~$8/month on lowcost, ~$60/month on official. Solo/personal scale is comfortably inside Apify's free tier.

**Auth:** worker holds `APIFY_TOKEN` as a Wrangler secret. Phone never touches Apify directly.

## Caching

**Only successful responses are cached.** Errors must not be cached — a one-off Apify outage would otherwise poison the URL for the entire TTL and block user retries.

- Success that involved an Apify call: `Cache-Control: public, s-maxage=604800` (7 days).
- Success from og: only: `Cache-Control: public, s-maxage=86400` (1 day, unchanged from v0.2.1).
- Any error response (`502 fetch_failed`, `504 timeout`, `403 private`, `404 not_found`, `400 unsupported_url`): `Cache-Control: no-store`.

Cache key is the normalized canonical URL — same key v0.2.1 defined. Hit semantics are identical regardless of which path produced the cached body; the phone can't tell.

`404 not_found` deserves a special note: IG returns 404 for deleted posts, but also occasionally for transient origin hiccups. `no-store` is correct — if a user re-shares a 404'd URL and the post is now back, we should re-fetch, not serve the stale 404.

No success-response cache busting. A creator editing their caption after we cache is a non-issue at MVP scale.

## Phone-side pipeline

The processing state machine extends with multi-image OCR for carousels. Storage decision: **slides 2..N are downloaded to temp paths, OCR'd, then deleted.** Only the cover is persisted to `sources.file_path`. The WebView in the source detail screen pulls slides 2..N live from IG's CDN for visual playback.

```
[Worker /fetch-post] → { imageUrls: [cover, slide2, …], caption }
        ↓
[Phone downloads imageUrls[0] → sources.file_path]   (cover; persisted)
        ↓
[Phone downloads imageUrls[1..N] → temp paths]       (slides; transient)
        ↓
[OCR each downloaded image in order, collect text per slide]
        ↓
[Delete temp slide files]                            (keep only cover)
        ↓
[ocr_text = ocr_cover + "\n---\n" + ocr_slide2 + … + "\n---\n" + caption]
        ↓
[UPDATE sources SET ocr_text=concatText, ocr_status='done']
        ↓
[POST /extract → places]   (unchanged)
```

**Idempotency:** on crash mid-pipeline, the next run hits the worker again. Worker cache returns the same `imageUrls` for 7 days; the phone re-downloads and re-OCRs. Temp slide files are deleted within the same processing call, so there's no orphan-cleanup invariant beyond what the existing single-image flow already maintains.

## Failure handling

Extends the v0.2.1 matrix.

| Stage fails | Outcome |
|---|---|
| Worker `og: fetch` fails on `/p/` | Apify fallback fires. Standard. |
| Worker detects carousel; Apify call fails | **Source goes to `extraction_status='failed'`.** No og: degradation. Tile shows platform placeholder; user can re-share to retry. |
| Apify returns empty `childPosts` for a known carousel | Treat as single-image: cover + caption only. Log `apify_outcome=carousel_no_children`. |
| Slide-N download fails (N>0) on phone | Skip that slide; continue OCR for remaining slides + caption. Don't fail the whole source. |
| All slides + cover fail to download | Caption-only fallback (today's behavior). |
| OCR fails on slide N | Skip that slide's text; continue. |
| `/extract` returns empty / errors | Same as today. |

The "Apify fails on a known carousel" case deliberately does not fall back to og:-only. Once the worker has identified a post as a carousel, partial data (slide-1 + caption) is worse than no data — it would silently miss the places on slides 2..N that the user just saved the post to capture. Better to surface a clear failure the user can retry than to ship a source that looks fine but has half the information.

## Telemetry

Worker logs per `/fetch-post` call. No URL, no caption, no body content — shape only.

- `route: og_only | og_then_apify_carousel | og_then_apify_unknown_efg | og_failed_apify_fallback`
- `og_outcome: ok | empty_desc | empty_image | http_429 | http_4xx | http_5xx | timeout`
- `apify_outcome: not_called | ok | empty | carousel_no_children | error | timeout`
- `cache: hit | miss`
- `latency_ms`

Sentry alerts:
- Apify `error` rate > 5% over the trailing 100 calls → swap-actor signal.
- og: `http_429` rate > 0 → IG rate-limiting; pivot ladder is engaging.
- Weekly Apify call count → sanity check on billing (count × $0.30/1000).

Phone-side telemetry unchanged from v0.2.1 (`extraction_outcome: ok | caption_only | failed`).

## Storage / schema

No migration. The v0.2.1 schema (`sources.kind='url'`, `platform`, `url`, `content_hash`, `file_path`, `ocr_text`) covers everything. `ocr_text` continues to hold the concatenated OCR + caption blob; the only change is that the OCR portion may now span multiple slides for carousels.

## UI

No changes. The tile shows the cover (slide 1) as before. The source detail screen's WebView already renders all carousel slides natively via IG's embed iframe — that path is unchanged. Carousel-extracted places appear in the Places-found sheet exactly the same way as today.

## Implementation sequencing

1. **Worker — Apify client + actor call.** Add `APIFY_TOKEN`, `APIFY_ACTOR_ID` to Wrangler. Implement the actor-run + dataset-fetch flow; normalize output to the existing `/fetch-post` response shape.
2. **Worker — dispatch.** Decode `efg`; wire the dispatch matrix. Add telemetry fields.
3. **Worker — caching.** 7d s-maxage on Apify-backed responses; tests for cache key behavior across og:-only vs Apify paths.
4. **Phone — multi-image pipeline.** Extend `modules/processing` to handle `imageUrls.length > 1`. Download to temps, OCR sequentially, concat, delete temps.
5. **Phone — failure paths.** No new worker error codes; the phone keeps treating any terminal `502 fetch_failed` as "tile placeholder, user can re-share to retry." The worker disambiguates carousel-fail vs og-and-Apify-both-failed only in telemetry.
6. **Telemetry — Sentry tags.** Wire the worker tags; add Sentry alerts.

Each step is independently testable. Steps 1–3 ship a working worker before any phone change. Step 4 can be developed against a fixed Apify response fixture.

## Open questions / deferred

1. **Confirm `sones/instagram-posts-scraper-lowcost` output schema** during implementation against 2–3 real public carousel URLs. The actor advertises the same shape as the official one but should be validated, not assumed.
2. **Apify actor-run latency under real load.** The selected lowcost actor is HTTP-only (no headless browser) so it should be materially faster than browser-based actors, but no published p50/p95 numbers exist. Measure during implementation; if p95 > 30s, consider parallelizing the og: + Apify fetches for `/p/` posts (call Apify in parallel with og: rather than after, accept the wasted Apify call on single posts as the cost of lower latency). Decide based on measurement.
3. **Cost telemetry surfacing in-app.** Out of scope here. If Apify spend ever becomes load-bearing, add it to the diagnostics section in Settings.
4. **Apify actor-swap UX.** If lowcost actor's quality degrades, swap is a Wrangler env change with no app-side ripple. No user-facing UI for this is planned.
5. **Carousel slide ordering.** Apify returns `childPosts` in IG's native slide order; we trust that and concat OCR in array order. If a future actor scrambles ordering, the OCR concat is still complete (just not slide-numbered) — extraction quality is unaffected.
