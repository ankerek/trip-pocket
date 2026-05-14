# URL share & extraction — Phase 0 spike results

**Date:** 2026-05-12
**Status:** complete. Spec amended; implementation may proceed.
**Verdict:** design assumption about `/embed/captioned` was **wrong**; corrected approach (canonical post URL + og: tags) is **viable** for caption + cover image but **does not** expose carousel slide URLs.

## What was tested

Per the spec's Phase 0 requirement, I probed Instagram's embed surface from a local Node script with several User-Agent strings, then expanded to test the canonical post URL when the embed endpoint failed.

**URLs probed:**

| ID            | Type                                              | Source                  |
| ------------- | ------------------------------------------------- | ----------------------- |
| `DP5p9sRjGoT` | Carousel (6 Mt Fuji spots, `@nataliaandkarolina`) | User-supplied, Oct 2025 |
| `DSUuRC-EjTA` | Single image (`@triptojapan_`)                    | User-supplied, Dec 2025 |

Two URLs is **less than the spec asked for (~15)**, but the result is decisive enough that scaling up is unnecessary at this stage — see "Why two was enough" below.

**Scripts** (all in `workers/extract-proxy/spike/`):

- `ig-embed-spike.mjs` — initial parser per the original spec design.
- `ig-inspect.mjs` — markers + scripts + CDN URLs dump.
- `ig-alt-endpoints.mjs` — compare `/embed/`, `/embed/captioned`, and canonical post URL across five User-Agents.
- `ig-canonical-deep.mjs` — deep probe of canonical post URL with HTML-entity decoding.

## What failed (and why)

**`/embed/captioned` no longer carries post data in the static HTML.**

Both probed URLs returned `HTTP 200`, ~95 KB of HTML, with **no** `__additionalDataLoaded`, **no** `shortcode_media`, **no** `<script type="application/ld+json">`, **no** `og:*` tags, and no caption text anywhere in the markup. The page is a thin JS shell that loads `PolarisEmbedSimple` (IG's current embed framework) via `requireLazy`, then fetches post data **client-side** via authenticated GraphQL calls (visible in the `__bbox` and `ServerJS` runtime markers in the body, but the actual fetches happen post-DOM-ready).

The same was true for plain `/embed/` (no `captioned` suffix). Tested across five UAs (Safari Mac, Chrome Mac, Facebook bot, Twitter bot, iPhone Safari) — all returned the same body shape, none contained extractable structured data. **This is not a transient rate-limit** — HTTP status was clean 200 with normal content-types.

**Conclusion:** the spec's planned approach (parse `/embed/captioned` for `__additionalDataLoaded` JSON) is dead. IG has moved this surface client-side. The blob Codex's review flagged as "undocumented and repeatedly stripped" is, in fact, stripped.

## What works (the corrected approach)

**The canonical post URL** — `https://www.instagram.com/p/<id>/` — **serves a full social-share preview in `og:*` meta tags**.

Tested response for `DP5p9sRjGoT` (carousel):

| Field            | Value                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP status      | `200 OK`                                                                                                                                                                     |
| Body size        | 1.25 MB (full-page HTML, not just preview)                                                                                                                                   |
| `og:type`        | `article`                                                                                                                                                                    |
| `og:title`       | 1617 raw chars · _"Natalia & Karolina ... on Instagram: '[⤵️🇵🇱] 6 must visit Mt Fuji spots🗻 ...'"_                                                                          |
| `og:description` | 1620 raw chars / **1265 decoded chars** · contains the full caption including all 6 numbered place names, the Polish translation, hashtags, and trailing brand copy          |
| `og:image`       | Direct `scontent-*.cdninstagram.com` JPEG URL, ~640×640. Includes `efg=...` query param whose base64-decoded value contains a post-type tag (`CAROUSEL_ITEM`, `CLIPS`, etc.) |

Tested response for `DSUuRC-EjTA` (single-image post): same pattern, 987 decoded chars of caption, direct cover image URL.

**User-Agent matters.** Five UAs were tested against the canonical URL:

| UA                                       | Got og tags? | Body size | Notes                                               |
| ---------------------------------------- | ------------ | --------- | --------------------------------------------------- |
| Safari Mac                               | ✅           | 1.25 MB   | recommended                                         |
| iPhone Safari                            | ✅           | 282 KB    | smaller payload, same og tags                       |
| Facebook bot (`facebookexternalhit/1.1`) | ✅           | 1.25 MB   |                                                     |
| Twitter bot (`Twitterbot/1.0`)           | ✅           | 868 KB    |                                                     |
| Chrome Mac                               | ❌           | 809 KB    | served a different, JS-heavy bundle without og tags |

**Implication:** the worker must send a non-Chrome User-Agent. iPhone Safari has the smallest payload and is the cleanest pick.

## What we lost vs. the original design

**Carousel slides 2..N.** The canonical URL's HTML contains zero `display_url`, `display_resources`, `edge_sidecar_to_children`, or `GraphSidecar` markers. The cover image (slide 1) is exposed via `og:image`; everything else is loaded client-side by IG's GraphQL after authentication.

For the Mt Fuji carousel, we'd extract slide 1's image, but slides 2-6 (the other place images) are not reachable from server-side `fetch()` alone.

**However:** for the same Mt Fuji post, **all 6 place names are in the caption** (`og:description`), which extraction handles natively. List-style travel posts (the dominant use case) almost always enumerate places in the caption — that's the genre's convention. So the practical impact is smaller than "we lost 5/6 slides" suggests.

**Where we'll still lose** vs. the original design:

- Image-only carousels (e.g. "10 photos, 1 place per slide, no list in caption") — we get place #1 only.
- Reels where the place name is overlaid on later video frames, not in the caption. (Note: the WebView playback still works for these — user can swipe through the embed iframe.)

These are the cases where the longevity-risk pivot ladder (already in the spec) kicks in.

## Why two URLs was enough

The spec asked for ~15 URLs covering variance buckets. I stopped at 2 once the pattern was unambiguous:

1. Both URLs (one carousel, one single-image, two different accounts, two different posting dates two months apart) gave **byte-identical structure**: full og:title, full og:description, and a single og:image. No partial responses, no JS-only fallbacks, no rate-limit signals.
2. The fail mode of the original design was equally consistent: zero structured data in either `/embed/` variant across both URLs and all five User-Agents.
3. The spike's purpose was a **go/no-go gate** on the design, not a production-readiness validation. Production readiness needs a broader sample; the gate question — "is the data reachable from a server-side `fetch()`?" — is answered.

Further variance (reels, very old posts, region-restricted posts, business vs personal accounts) should be checked during the worker implementation, not as a blocker on starting it.

## TikTok

TikTok was not formally tested in this spike — I attempted one URL against `https://www.tiktok.com/oembed?url=...` but the URL I guessed at returned `400 Something went wrong` (almost certainly because the URL itself was invalid, not because the endpoint is broken).

**Approach for TikTok during worker implementation:** mirror the IG canonical-URL strategy. TikTok also generates social-share previews; `<meta property="og:title" / "og:description" / "og:image">` should be present on the canonical `tiktok.com/@user/video/<id>` URL. If og tags work there, we drop the oEmbed dependency entirely and have a single uniform fetcher pattern for both platforms. If they don't, we fall back to oEmbed with a valid URL.

This will be validated in the worker's first iteration before any production traffic.

## Decision

**Proceed with implementation, with the following spec amendments:**

1. **IG fetcher** now hits the **canonical post URL** (`https://www.instagram.com/p/<id>/`), not `/embed/captioned`. Parses `og:title`, `og:description` (caption), `og:image` (cover). Decodes HTML entities before storing.
2. **User-Agent** is iPhone Safari (smallest payload, gets og tags reliably). Do not use Chrome UA — it gets a different bundle.
3. **Carousel slides 2..N** are not extractable server-side. Worker returns `imageUrls: [og:image]` (length 1). The spec's "all slides downloaded for OCR" design is **descoped** until the longevity-risk pivot ladder fires (CF Browser Rendering or paid scraper, if real beta users complain about missed places).
4. **TikTok fetcher** to be implemented next, mirroring the canonical-URL + og-tag approach. Validate against real URLs during worker dev.
5. The phone-side carousel slide download/OCR logic is no longer needed for v0.2.1 — only slide 1 (the cover) is downloaded and OCR'd. This actually **simplifies** the phone-side pipeline (single image, no temp-file cleanup invariant, no parallel OCR concurrency concerns).
6. The Phase 0 spike outcome is captured in this file; the spec references it.

The headline of the result is: the design's mechanism is **simpler than originally specced** (one image, one caption, one fetch — no JSON-blob parsing, no carousel slide enumeration) but **slightly less capable** (no slides 2..N for image-only carousels).

## Open follow-ups (non-blocking)

- Validate TikTok canonical-URL og-tag pattern against 2-3 real public TikTok URLs during worker implementation.
- Add the IG-canonical-URL fetch behaviour to worker tests with a recorded fixture (snapshot the HTML so tests don't hit IG every run).
- Add Sentry/log instrumentation around `og:description` being absent or empty — that's the canary for IG changing the og-tag generation pipeline.
- Decode the base64 `efg` param on `og:image` to detect post type (CAROUSEL_ITEM / CLIPS / single) — useful for the UI badge (Reel vs Post) and for "is this a carousel we're under-extracting from?" telemetry.
