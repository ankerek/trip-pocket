# TikTok slideshow extraction via rehydration JSON — design

**Status:** design (2026-05-13). Amends [`2026-05-12-url-share-extraction-design.md`](./2026-05-12-url-share-extraction-design.md) — replaces the TikTok branch of `/fetch-post` in `workers/extract-proxy/`.
**Targets:** v0.2.x follow-up. Worker- and pipeline-only change; no new app screens.

## Why

The shipped TikTok pipeline is documented as "og: meta tags with oEmbed as a safety net." A spike (see Spike findings) revealed that **TikTok no longer emits `og:*` meta tags on its post pages** — not for `/video/<id>` and not for `/photo/<id>`. Every TikTok URL today silently falls through to oEmbed, which returns one thumbnail and a title regardless of post type. This has two consequences:

1. **TikTok photo slideshows lose every slide after the first.** Travel content uses these heavily (city guides, hotel walk-throughs, listicles); place names that span multiple slides never reach OCR. Same shape of gap that Apify closed for Instagram carousels.
2. **The worker's `tiktok_og` dispatch route is dead.** We're shipping logic that produces zero output and treating its silent fall-through as "working."

TikTok's web page embeds the full post payload as a `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">` blob in the static HTML. The spike confirms it's served without JS execution to a Cloudflare Worker UA, includes all slides for photo posts (`imagePost.images[].imageURL.urlList[0]`), and includes the video cover plus full caption/author for video posts. Parsing this in the worker replaces both halves of the current TikTok branch with one HTTP call that returns strictly more data — for both photo and video URLs, at no third-party cost.

## Spike findings

Three fetches with the worker's existing iPhone Safari User-Agent against live public TikTok URLs:

| URL shape                  | Body size | Rehydration blob       | `imagePost` field | Slides recovered            |
| -------------------------- | --------- | ---------------------- | ----------------- | --------------------------- |
| `/photo/<id>` (6 slides)   | 232 KB    | yes (3/3 reproducible) | yes               | 6/6                         |
| `/video/<id>` (live)       | 223 KB    | yes                    | no                | n/a (`video.cover` present) |
| `/video/<id>` (occasional) | 13 KB     | no                     | no                | n/a (anti-bot stub)         |

Findings driving the design:

- **`imagePost`'s presence is the discriminator** between photo and video posts — checked after parsing the JSON, not from the URL. This means short-link redirects (`vm.tiktok.com`) that we can't classify upfront still work.
- **`og:*` meta tags are entirely absent** from both photo and video TikTok pages.
- **Anti-bot stubs occur** but are obvious: the rehydration script tag is missing. The 13 KB stub case must be handled as a transient failure and fall through to oEmbed.
- **Image URLs are signed** with `x-expires` ~47 hours from issue. This bounds the worker's response cache TTL.

The script-tag-and-field-path approach is the same field shape that ScrapeCreators' commercial TikTok API exposes (per their public blog post), reused here without their wrapper.

## Scope

**In scope:**

- New worker function `fetchTikTokRehydration(canonical)` that fetches the canonical TikTok URL, extracts the rehydration JSON, and maps it to the existing `FetchPostResponse`.
- Replacement of the TikTok branch in `handleFetchPost()` (file: `workers/extract-proxy/src/fetch-post.ts`): rehydration parse as primary, oEmbed as fallback. The dead `fetchTikTokOg` code is removed.
- One-line fix to `extractAuthorFromTikTokUrl` so its regex matches `/@<handle>/(?:video|photo)/<id>` instead of `/video/` only — still needed on the oEmbed fallback path.
- `_debug.route` enum update: add `tiktok_rehyd_photo`, `tiktok_rehyd_video`, add `tiktok_oembed_fallback`. Coordinated Zod widening in `modules/capture/fetchPostFromProxy.ts` (see §Rollout — phone Zod must accept the **union** of old + new values during the transition window).
- Extension to `modules/pipeline-log/pipeline-log.ts` so callers can attach extra Sentry tags. Today `stage.fail(err)` hard-codes `{ tags: { pipeline_stage: stage } }` and ignores anything on the error; this spec adds an optional `tags` parameter that is merged into the `Sentry.captureException` call.
- Phone-side enrichment in `modules/capture/fetchPostFromProxy.ts`: when the worker returns an error, call `stage.fail(err, { tags: { platform, worker_error_code } })` so the existing Sentry capture carries filterable tags.
- Unit tests on the pure parser and mapper; integration tests on the dispatch flow against captured HTML fixtures.

**Not in scope:**

- Instagram changes. IG continues to use og: + Apify exactly as today.
- Extracting TikTok video `playAddr` or any video file URL. We only store the cover for video posts, same as oEmbed produces today.
- Persisting slides 2..N to disk for TikTok any differently from how IG carousels are persisted. The phone already handles multi-image responses for IG; TikTok slideshows reuse that path verbatim.
- Anti-bot evasion (IP rotation, CF Browser Rendering, residential proxies). If anti-bot escalation kills the parser, oEmbed remains the floor; replacement-tier work is a separate spec.
- Cloudflare Analytics Engine bindings, synthetic monitoring, or external alerting beyond what Sentry already does. See §Monitoring total failures.
- Distinguishing "anti-bot stub" from "deleted/private/region-blocked" in telemetry. Both collapse to `ogOutcome: 'empty'` plus an oEmbed fallback in the route field. If the rate climbs and we need finer signal, that's a follow-up.

## Worker dispatch — `/fetch-post` (TikTok branch)

Public contract unchanged. The TikTok branch becomes a two-stage pipeline that mirrors the IG branch's shape; the `instagram` branch is untouched.

```
URL  →  resolveTikTokCanonical (unchanged)
        ↓
Stage 1: fetchTikTokRehydration(canonical)
        ↓ success: walk imagePost OR video.cover → FetchPostResponse, return
        ↓ failure (any reason, see below): fall through
        ↓
Stage 2: fetchTikTokOEmbed(canonical) (unchanged code)
        ↓ success: 1 thumbnail + title, return
        ↓ failure: surface error to client
```

**No URL-shape branching at the dispatch level.** The parser handles `/photo/<id>` and `/video/<id>` with the same code; the discriminator is the `imagePost` field inside the parsed JSON. This keeps `vm.tiktok.com` short links that we haven't yet resolved shape-of working without extra logic.

**`fetchTikTokOg` is removed** along with its callers. The function produces zero output for any live TikTok URL as of 2026-05-13 and adds nothing as a stage that can never succeed.

**Dispatch matrix:**

| Stage 1 outcome                                                  | Stage 2 fires? | `_debug.route`                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| parser ok, `imagePost` present, ≥1 slide                         | no             | `tiktok_rehyd_photo`                                                                                                                                                                                             |
| parser ok, no `imagePost`, `video.cover` present                 | no             | `tiktok_rehyd_video`                                                                                                                                                                                             |
| parser ok, no images extractable                                 | no             | `tiktok_rehyd_photo` or `_video` (whichever branch ran) with `imageUrls: []`                                                                                                                                     |
| anti-bot stub (no rehydration script tag)                        | **yes**        | `tiktok_oembed_fallback` if oEmbed ok                                                                                                                                                                            |
| rehydration JSON malformed                                       | **yes**        | `tiktok_oembed_fallback` if oEmbed ok                                                                                                                                                                            |
| HTTP 404 / 403 / 429 / 5xx / timeout / network                   | **yes**        | `tiktok_oembed_fallback` if oEmbed ok; otherwise error                                                                                                                                                           |
| short-link resolution failed (HEAD threw on `vm./vt.tiktok.com`) | **yes**        | Stage 1 fetches the original short URL unchanged; almost certainly fails the rehydration parse; oEmbed fires and gets the canonical URL via its own redirect-follow. `_debug.route` value depends on what fired. |

The "parser ok but 0 images" rows return a successful response with an empty `imageUrls` array — same as the IG no-cover case. The phone already handles this.

`permalink` in the response is always the URL that the parser succeeded against. When short-link resolution fails and the rehydration parser also fails, the oEmbed call still resolves redirects internally, so its returned `permalink` may end up as the canonical long-form URL even though `resolveTikTokCanonical` did not. This is acceptable and matches today's behavior.

## Rehydration parser

**Function signature:**

```ts
async function fetchTikTokRehydration(canonical: URL): Promise<FetchPostResponse>;
```

**Extraction:**

1. `fetchHtml(canonical.toString(), IG_UA)` — reuses the existing helper, so 404/403/429/5xx mapping is already correct via `UpstreamError`.
2. Find the script tag: regex `/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]+?)<\/script>/`. Throw `UpstreamError(502, 'tiktok-no-rehydration')` when absent (anti-bot stub case).
3. `JSON.parse` the captured group. On failure: `UpstreamError(502, 'tiktok-rehyd-non-json')`.
4. Walk to `data.__DEFAULT_SCOPE__['webapp.reflow.video.detail'].itemInfo.itemStruct`. Missing path: `UpstreamError(502, 'tiktok-rehyd-no-item')`.

All three thrown errors are caught at the dispatch level and trigger the oEmbed fallback. They are surfaced distinctly only in the worker log line (see §Worker logs), not in the closed-vocab `_debug` enum.

**Mapping rules** (one item → one `FetchPostResponse`):

| Output field | Source                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform`   | `'tiktok'` (constant)                                                                                                                                                                                                                            |
| `permalink`  | `canonical.toString()`                                                                                                                                                                                                                           |
| `caption`    | `item.desc ?? ''`                                                                                                                                                                                                                                |
| `author`     | `'@' + item.author.uniqueId` if `uniqueId` is a non-empty string, else `null`                                                                                                                                                                    |
| `imageUrls`  | **if `item.imagePost` present:** `item.imagePost.images[].imageURL.urlList[0]` for each slide, skipping entries where `urlList[0]` is missing/empty. **else if `item.video?.cover` is a non-empty string:** `[item.video.cover]`. **else:** `[]` |

**Type-safety posture.** The rehydration JSON enters as `unknown`. All field access is via narrow runtime type guards (`typeof === 'string'`, `Array.isArray`, etc.), not casts. Same approach as `mapApifyItem` in `apify.ts`.

**Helpers exported for unit tests:**

- `extractTikTokRehydrationJson(html: string): unknown` — regex extracts and parses. No network. Throws the three error codes above.
- `mapTikTokRehydrationItem(raw: unknown, canonical: string): FetchPostResponse & { _route: 'photo' | 'video' }` — pure mapper. Returns the route discriminator alongside the response so the dispatch layer can label `_debug.route` without re-checking the shape.

`fetchTikTokRehydration` is the thin network wrapper that composes them.

## Response shape

Unchanged from the existing schema in `fetchPostResponseSchema`. The phone code paths that handle multi-element `imageUrls` for IG carousels apply identically to TikTok slideshows. No new fields, no new platforms, no new media types.

## Telemetry — `_debug` schema changes

`_debug.route` enum changes are **strictly additive** in the phone Zod schema during the rollout window. Old values stay; new values are added; the worker decides which values to emit:

| Phase                                   | Worker emits                                                         | Phone Zod accepts (union)                                                                          |
| --------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| pre-deploy (today)                      | `tiktok_og`, `tiktok_oembed`                                         | `tiktok_og`, `tiktok_oembed`                                                                       |
| step 1: phone update lands              | `tiktok_og`, `tiktok_oembed` (unchanged)                             | `tiktok_og`, `tiktok_oembed`, `tiktok_rehyd_photo`, `tiktok_rehyd_video`, `tiktok_oembed_fallback` |
| step 2: worker deploy lands             | `tiktok_rehyd_photo`, `tiktok_rehyd_video`, `tiktok_oembed_fallback` | (same superset as step 1)                                                                          |
| cleanup follow-up (after worker stable) | (same as step 2)                                                     | drop `tiktok_og`, `tiktok_oembed`                                                                  |

**Implementer note:** in step 1, do **not** replace the existing enum values — append the new ones. Replacing them would Zod-reject every TikTok response served by the not-yet-updated worker. The cleanup PR that removes the old values is a separate, mechanical change after the worker has been on the new dispatch for at least a week with no regressions.

The new value `tiktok_rehyd_video` fires when the parser succeeds with `video.cover`; the new value `tiktok_rehyd_photo` fires when the parser succeeds with `imagePost`; `tiktok_oembed_fallback` fires when the parser failed (any reason) and oEmbed succeeded.

`_debug.ogOutcome` semantics for TikTok — the enum is reused as "primary path outcome":

| Outcome                                                          | Value          |
| ---------------------------------------------------------------- | -------------- |
| parser produced ≥1 usable field                                  | `ok`           |
| HTTP 200, no rehyd blob or blob with no item or JSON.parse threw | `empty`        |
| HTTP 404                                                         | `not_found`    |
| HTTP 403 or 401                                                  | `private`      |
| HTTP 429                                                         | `rate_limited` |
| timeout                                                          | `timeout`      |
| network exception                                                | `network`      |
| HTTP 5xx                                                         | `upstream_5xx` |

`_debug.apifyOutcome` for TikTok: `not_called` always (unchanged).

## Caching

| Outcome                                              | `Cache-Control`                  |
| ---------------------------------------------------- | -------------------------------- |
| `tiktok_rehyd_photo` or `tiktok_rehyd_video` success | `public, s-maxage=86400` (1 day) |
| `tiktok_oembed_fallback` success                     | `public, s-maxage=86400` (1 day) |
| Any error                                            | `no-store` (unchanged)           |

Rationale: TikTok signed image URLs expire ~47 hours after issue (verified via spike). A 7-day cache would serve a stale URL to a returning client and produce 403s on image fetch. 1 day keeps the worker response usable through the URL's lifetime.

## Client-facing error codes

When both stages fail, the worker surfaces one of:

| Final condition | Status | `error`        |
| --------------- | ------ | -------------- |
| oEmbed 404      | 404    | `not-found`    |
| oEmbed 403      | 403    | `private`      |
| otherwise       | 502    | `fetch-failed` |

Same shape as today's worker. Phone-side error handling is unchanged on the wire.

## Worker logs

One structured log line per request to make `wrangler tail` greppable. Same prefix style as the existing `extract-proxy/apify:` lines.

```
extract-proxy/tiktok-rehyd: ok          type=photo slides=6 captionLen=42
extract-proxy/tiktok-rehyd: ok          type=video slides=1 captionLen=80
extract-proxy/tiktok-rehyd: fallback    reason=no_blob       oembed_ok=true
extract-proxy/tiktok-rehyd: fallback    reason=no_item       oembed_ok=true
extract-proxy/tiktok-rehyd: fallback    reason=non_json      oembed_ok=false
extract-proxy/tiktok:       total-failure  primary=<og_outcome> oembed=<og_outcome> url_shape=<photo|video|short>
```

`reason` is one of `no_blob | no_item | non_json | http_<status> | timeout | network`. No URL, no caption text, no image URL — same privacy posture as the rest of the worker.

## Monitoring

There are two failure modes the design has to distinguish, and they need two different signals.

### Mode A — total failure (both stages fail)

The worker returns a 4xx/5xx error, the phone's `url_fetch` stage throws, and `pipeline-log.ts` calls `Sentry.captureException`. Today this fires unfiltered. This spec adds two tags via the new `stage.fail(err, { tags })` API:

| Tag                 | Value source                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`          | derived from the input URL before the worker call: `'tiktok'` or `'instagram'`                                                                                                                                                                                                                                                                      |
| `worker_error_code` | the worker's response `error` field — one of `'fetch-failed' \| 'not-found' \| 'private' \| 'rate-limited' \| 'unsupported-url'` (only values the worker actually emits; upstream TikTok rate-limits collapse to `fetch-failed` per §Client-facing error codes, so the `rate-limited` tag only appears when the worker's own CF rate limiter trips) |

Sentry query: `pipeline_stage:url_fetch AND platform:tiktok` counts total TikTok extraction failures. Per-error-code splits via `AND worker_error_code:fetch-failed`. This catches the loudest failure mode but **does not** detect silent degradation where the rehydration parser stops working and oEmbed keeps the success rate at 100%.

### Mode B — silent regression (rehydration broken, oEmbed catches it)

This is the failure mode that matters most for "do we need a replacement?" — it is invisible to Sentry because no exception fires. The signal is the rate of `tiktok_oembed_fallback` over total TikTok requests. Two cheap channels:

- **Worker logs:** `extract-proxy/tiktok-rehyd: fallback` lines, greppable from `wrangler tail` for ad-hoc inspection. CF Logpush can stream these to a destination if we ever want them durable — out of scope for v1.
- **Phone telemetry:** `_debug.route` is already wired into the pipeline-log firehose per the pipeline-observability spec. The route value is therefore visible to the user in-app and in the firehose log; no Sentry change needed to surface it.

Operational expectation: glance at `wrangler tail` weekly (or after any TikTok import that returned a single thumbnail). If `tiktok_oembed_fallback` is climbing above a low background level, treat as a signal that the rehydration path needs maintenance — same operational posture as the IG `og_then_apify_unknown_efg` route from the Apify spec.

### Out of scope deliberately

Analytics Engine bindings, synthetic monitoring, Sentry alert rules. Sentry's built-in alerting can be enabled later without code changes once the tagged events have a baseline rate.

## Testing

**Unit tests** under `workers/extract-proxy/__tests__/fetch-post-tiktok-rehyd.test.ts` (new file):

- `extractTikTokRehydrationJson(html)` against three fixtures:
  - photo HTML (sanitized capture) → returns parsed object
  - anti-bot stub HTML → throws `tiktok-no-rehydration`
  - malformed JSON inside the script tag → throws `tiktok-rehyd-non-json`
- `mapTikTokRehydrationItem(raw, canonical)` table-driven:
  - photo item with 6 slides → `imageUrls.length === 6`, `_route === 'photo'`
  - video item with `video.cover` → `imageUrls.length === 1`, `_route === 'video'`
  - item with `imagePost` but every `urlList[0]` empty → `imageUrls === []`, caption/author intact
  - item with neither `imagePost` nor `video.cover` → `imageUrls === []`
  - missing `item.author?.uniqueId` → `author === null`
  - missing `item.desc` → `caption === ''`

**Integration tests** in the existing `fetch-post.test.ts` style with `vi.fn()`-mocked `fetch`:

- `/photo/` URL → `_debug.route === 'tiktok_rehyd_photo'`, `imageUrls.length > 1`, oEmbed not called.
- `/video/` URL → `_debug.route === 'tiktok_rehyd_video'`, `imageUrls.length === 1`, oEmbed not called.
- anti-bot stub on first call, oEmbed JSON on second call → `_debug.route === 'tiktok_oembed_fallback'`, `_debug.ogOutcome === 'empty'`.
- both calls fail → 502 `error: 'fetch-failed'`, `Cache-Control: no-store`.

**Phone-side tests:**

- `modules/pipeline-log/__tests__/pipeline-log.test.ts` (or whatever the existing file is) — `stage.fail(err, { tags: { foo: 'bar' } })` calls `Sentry.captureException` with `{ tags: { pipeline_stage: <stage>, foo: 'bar' } }`. Sentry SDK is mocked.
- `modules/capture/__tests__/fetchPostFromProxy.test.ts` — Worker returns an error response → caller invokes `stage.fail` with tags `{ platform: 'tiktok', worker_error_code: '<code>' }` for known `worker_error_code` values. Assert via the mocked `stage.fail` (or by spying on the mocked Sentry SDK).

**Fixtures** under `workers/extract-proxy/__tests__/fixtures/tiktok/`:

- `photo-6slides.html` — sanitized spike capture, trimmed to the script tag plus minimum HTML scaffold (~5–10 KB).
- `video.html` — same treatment.
- `antibot-stub.html` — the 13 KB stub case.

Signed URLs inside fixtures will expire; tests don't fetch them, only assert string shape — that's fine.

**Not tested:**

- Live TikTok requests from CI. Flaky, anti-bot-sensitive, region-dependent.
- Image URL signature validity. The phone surfaces image-load failures through the existing render error path.

**Dogfood checklist** (manual, post-deploy to staging):

1. Share a real `/photo/` URL with ≥3 slides → all slides appear in triage.
2. Share a real `/video/` URL → cover image appears.
3. Share a `vm.tiktok.com` short link to a photo → resolves and extracts.
4. Share a deleted/private TikTok URL → standard "fetch failed" error toast.
5. `wrangler tail` shows the new structured logs at least once during the session.

## Rollout

Two coordinated deploys, then an optional cleanup. The phased phone/worker state is documented in §Telemetry; the operational sequence is:

1. **Phone — widen the Zod enum** to the union of old + new values: `tiktok_og`, `tiktok_oembed`, `tiktok_rehyd_photo`, `tiktok_rehyd_video`, `tiktok_oembed_fallback`. Also lands the `pipeline-log` `tags` extension and the `fetchPostFromProxy` Sentry-tag enrichment. Ship via EAS Update or the next TestFlight build. The worker continues emitting the old enum until step 2 — old responses parse cleanly because the phone enum is a strict superset.

2. **Worker — deploy the new dispatch.** `wrangler deploy`. Old phone builds that have not picked up step 1 will Zod-fail the response and treat it as an error — that's why phone goes first.

3. **Cleanup PR (optional, after ~1 week stable)** — drop `tiktok_og` and `tiktok_oembed` from the phone Zod enum since the worker no longer emits them. Pure deletion; no functional change.

No env vars to add or rotate. No secrets to manage. No database migration. The change is reversible by reverting the worker — the phone's superset enum tolerates the old values indefinitely.

## Longevity / risks

- **TikTok renames the rehydration scope or item field.** Mitigated by the always-on oEmbed fallback (no slides, but caption + cover survive). Detection is via the `tiktok_oembed_fallback` rate in §Monitoring mode B — Sentry will not fire because oEmbed masks the regression. Reaction is rewriting the field walk, ~10 LOC. Probability: medium over 12 months — TikTok has rotated this before, ScrapeCreators' field name (`image_post_info` snake_case) differs from the current web blob (`imagePost` camelCase), evidence of past rotation.
- **TikTok escalates anti-bot detection on CF Worker IPs.** Mitigated short-term by oEmbed. Long-term mitigation, if needed, is rung-3-equivalent: CF Browser Rendering or residential proxies. Out of scope for this spec.
- **`__UNIVERSAL_DATA_FOR_REHYDRATION__` is removed.** Failure mode: everything is oEmbed, exactly the current state. We're no worse off than today.
- **Signed image URLs expire mid-cache.** Mitigated by 1-day `s-maxage`, well inside the ~47-hour `x-expires` window.
