# URL share & extraction — design

**Status:** design approved + Phase 0 spike complete (2026-05-12). Spike results at [`2026-05-12-url-share-spike-results.md`](./2026-05-12-url-share-spike-results.md). The IG approach is **amended** from the original spec: the worker fetches the **canonical post URL** (not `/embed/captioned`) and parses `og:*` meta tags. Carousel slides 2..N are out of scope for v0.2.1 (descoped because IG loads them client-side and they're not reachable via server-side `fetch()`).
**Targets:** v0.2 follow-up (likely v0.2.1). Adds a third capture path alongside share-sheet screenshots and camera-roll import.

## Why

PRODUCT.md's capture path is "see something on Instagram or TikTok, tap Share → Trip Pocket." Today that only works when the user taps Instagram's _screenshot_ option — sharing the post URL itself is rejected by the share extension (Info.plist activation rule is image-only, and `ShareViewController` only reads `UTType.image`).

That extra step ("take a screenshot first, then share") is friction we promised not to add. Sharing the link directly is the natural muscle motion on iOS: tap Share → Trip Pocket. Today nothing happens. This spec wires that path end-to-end.

The schema has anticipated this since v0.2: `sources.kind` already has `'url'` as a value alongside `'screenshot'` and `'pasted'`. No row currently uses it.

## Scope

**In scope:**

- iOS share extension accepts URLs (in addition to images).
- New worker endpoint `POST /fetch-post` that fetches Instagram and TikTok post metadata.
- New on-phone processing stage that downloads cover/slide images, OCRs them, and feeds the extractor.
- Inline video playback in the source detail screen via `react-native-webview`.
- One schema migration: `sources.platform` column.

**Not in scope:**

- YouTube support (deferred to v1.x parking lot).
- Instagram Stories (no public embed exists).
- Author handle / timestamp / like-count storage and UI surfacing.
- A "Links" sub-tab or any URL-specific listing surface.
- Worker-side image proxying (IG/TikTok cover URLs are public; phone fetches direct).
- An in-app web view for previewing posts (the WebView is for playback only; "Open in Instagram" handles general previewing via OS deep-link routing).

## Platforms supported

| Platform  | Fetcher                                                                                                                                           | Notes                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instagram | Parse `og:*` meta tags from the **canonical post URL** (`https://www.instagram.com/p/<id>/`)                                                      | Free, no auth. Returns caption (`og:description`) + cover image (`og:image`). Carousel slides 2..N **not available** — IG loads them client-side. Stories not supported (different URL shape, no public preview). |
| TikTok    | Parse `og:*` meta tags from the canonical post URL (`https://www.tiktok.com/@user/video/<id>`); fall back to TikTok oEmbed if og tags are missing | Free, no auth. Same pattern as IG for shape consistency. Validate during worker implementation.                                                                                                                   |

YouTube is explicitly **deferred** to the v1.x parking lot in `docs/ROADMAP.md` — it would have needed a separate Data API path and adds maintenance surface.

**Why canonical URL, not `/embed/`:** the Phase 0 spike proved that IG's `/embed/captioned` no longer carries post data in the static HTML — it became a JS shell whose data is fetched client-side after DOM-ready. The canonical post URL still serves a full social-share preview in `og:*` meta tags (caption + cover image), tailored for Facebook / Twitter / iMessage link unfurling. We piggyback on that surface for the same reason any link-preview engine does.

### Compliance posture (ToS / App Store)

Both fetchers hit **public endpoints the platforms publish for embedding**, not auth-protected APIs or DOM-scraping behind a login wall:

- **TikTok oEmbed** — `https://www.tiktok.com/oembed` is an official, documented oEmbed endpoint. Designed for third-party embedding. Zero ToS concern.
- **Instagram `/embed/captioned`** — public page IG serves to make posts embeddable on blogs / news sites. Not an auth-bypass; not against Meta's Platform Terms (which target auth-protected Graph API misuse). Parsing the HTML of this public page is the same pattern many existing iOS apps use; **not the same risk class as scraping a logged-in profile feed**.
- **No user credentials, no auth tokens, no auth-bypass.** All requests are anonymous, server-to-server, from a Cloudflare Worker.

App Store review: this design does not introduce content rights claims (we don't display the post body inside our own UI — we render IG/TikTok's own embed iframe via WebView, and otherwise show only the cover image the user is also seeing in the original post). Apps that re-host scraped content face review risk; apps that embed via the platform's own widgets do not. This design is the latter.

What's flagged for monitoring but **not** considered a launch-blocking risk: IG could change its ToS to forbid `/embed/` fetches outside browser contexts (no public signal of intent today; would force a pivot if it happened). The Open Questions section already lists parser stability as a thing to watch.

## Capture path — iOS share extension

**`native/ShareExtension/Info.plist`** — broaden the activation rule:

```xml
<key>NSExtensionActivationRule</key>
<dict>
  <key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>1</integer>
  <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>
</dict>
```

**`ShareViewController.swift`** — extend `handleSave(tripId:)` to detect content type. Disambiguation order when both are present (Instagram's share sheet sometimes offers both URL and a preview image):

1. `UTType.url` → URL flow (preferred).
2. `UTType.image` → existing image flow (unchanged).

The URL flow:

```swift
provider.loadItem(forTypeIdentifier: UTType.url.identifier) { data, _ in
    guard let url = data as? URL else { /* cancel */ }
    do {
        try PendingImportWriter().write(url: url.absoluteString,
                                        suggestedTripId: tripId)
        // completeRequest on main
    } catch { /* cancel on main */ }
}
```

Sanity check on hostname before writing the pending import. **Normalization rule** (apply before matching): lowercase the host, strip a leading `www.` or `m.`. **Allowlist** (post-normalization): `instagram.com`, `instagr.am`, `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com`. Anything else: reject. Rejection inside the share extension shows the OS-level "extension cancelled" affordance; that's acceptable for MVP (a richer "Unsupported link" inline message is a v0.3 polish item).

**`native/ShareExtension/PendingImportWriter.swift`** — gain a new method:

```swift
func write(url: String, suggestedTripId: String?) throws
```

Writes a JSON file in the existing App Group container alongside today's image imports. The shape:

```json
{ "kind": "url", "url": "https://www.instagram.com/p/ABC123/", "suggestedTripId": "..." }
```

**TripPickerView** — no UI change. Same trip-picker UX as today.

**App-side ingest (existing pending-import consumer)** — on app foreground, when it sees a `kind: "url"` entry:

1. **Canonicalize the URL** — resolve short links so dedup operates on the same URL the user would have shared via the long form:
   - TikTok short links (`vm.tiktok.com/...`, `vt.tiktok.com/...`): issue a `HEAD` request, follow redirects, capture the resolved `tiktok.com/@user/video/<id>` URL. Timeout 5s.
   - Instagram and other forms: no resolution needed; use as-is.
   - If the HEAD fails (offline, timeout): proceed with the share-time URL as-is; the worker call later will still resolve correctly, and we'll backfill `url` + `content_hash` at that point (see step 6).
2. **Normalize** the canonical URL: lowercase host, strip query params, strip trailing slash.
3. Compute `content_hash = SHA-256(normalizedCanonicalUrl)`.
4. Compute `platform` from hostname (`instagram` / `tiktok`).
5. `INSERT INTO sources (kind='url', platform, url=normalizedCanonicalUrl, content_hash, file_path=NULL, ocr_status='pending', extraction_status='pending', captured_at=now, trip_id=suggestedTripId, origin='share', ...)`.
6. Enqueue the URL processing job (Section: Processing pipeline). If step 1's HEAD was skipped/failed, the worker returns the canonical URL in its response; before enqueuing OCR, `UPDATE sources SET url=canonical, content_hash=SHA-256(canonical)`. Handle a UNIQUE collision here the same way as step 7.
7. If `content_hash` collides with an existing source (either at insert or at step-6 backfill), surface a one-time toast ("Already saved to <trip>"), open the existing source, and soft-delete the duplicate row — same UX as duplicate-screenshot today.

## Worker — `POST /fetch-post`

New endpoint on `workers/extract-proxy`.

**Request:**

```json
{ "url": "https://www.instagram.com/p/ABC123/" }
```

**Success response:**

```json
{
  "platform": "instagram",
  "permalink": "https://www.instagram.com/p/ABC123/",
  "caption": "Best ramen in Shibuya — Maru Tonkatsu …",
  "imageUrls": ["https://scontent.../slide1.jpg", "https://scontent.../slide2.jpg"],
  "author": "@foodietravels"
}
```

`imageUrls` is normally a non-empty array — length 1 for single posts and for TikTok responses, length > 1 for IG carousels — **but may be empty** when the platform returned a usable caption but no image URL (e.g. a TikTok with a null `thumbnail_url`, or an IG post where the embed exposed the caption but no `og:image` or carousel slides). When `imageUrls` is empty and `caption` is non-empty, the phone proceeds with the caption-only path (see Processing pipeline failure handling).

**Error response:** `{ "error": "<code>" }` with HTTP status:

- `400 unsupported_url` — hostname not in the allowlist (should not occur given share-extension prefilter; defence in depth).
- `404 not_found` — post doesn't exist or was deleted.
- `403 private` — post requires auth.
- `502 fetch_failed` — upstream HTTP error or HTML parse failure.
- `504 timeout` — upstream took > 10s.

**Internal dispatch by hostname:**

### Instagram handler

1. Fetch the **canonical post URL** — `https://www.instagram.com/p/<shortcode>/` — with an **iPhone Safari User-Agent**. (Chrome UA returns a JS-heavy bundle without og tags; Safari / FB-bot / Twitter-bot / iPhone-Safari all return the og-tag preview. iPhone Safari has the smallest payload, ~280 KB.)
2. Parse the response HTML for `<meta property="og:*">` tags:
   - **Caption** ← `og:description`. Decode HTML entities (`&amp;`, `&quot;`, `&#x<hex>;`, `&#<dec>;`) before storing.
   - **Cover image URL** ← `og:image`. This is a direct `scontent-*.cdninstagram.com` CDN URL, ~640×640 JPEG, downloadable without auth.
   - **Author** ← parse `og:title` (format: `<Name> on Instagram: "..."`); take the substring before " on Instagram:". Decode entities.
   - **Post-type hint (optional)** ← decode the base64 `efg` query param on `og:image`. Values include `CAROUSEL_ITEM` / `CLIPS` (reel) / single. Useful for the UI badge.
3. Return `imageUrls: [<og:image url>]` (always length 1 for IG in v0.2.1).
4. If `og:description` is missing or empty AND `og:image` is missing → `502 fetch_failed`. If only `og:image` is missing but caption exists → return `imageUrls: []` and let the phone use the caption-only path. If only caption is missing → still return the image; the phone will run OCR.

**What's deliberately not done in v0.2.1:**

- **Carousel slides 2..N.** Phase 0 spike confirmed these are not server-side reachable from the canonical URL. The WebView playback in the source detail screen still renders all slides natively (IG's embed iframe handles it), so the user can swipe through them — we just can't OCR them. If extraction quality suffers in practice, the longevity-risk pivot ladder (CF Browser Rendering / paid scraper) escalates this. Not blocking launch.
- **`/embed/` parsing.** Spike showed both `/embed/` and `/embed/captioned` are now JS shells; not used.
- **GraphQL endpoints.** Authenticated, brittle, not worth the maintenance surface for v0.2.1.

**Longevity risk — IG anti-bot escalation:** the risk is "IG progressively makes anonymous server-side `fetch()` harder over time." Plausible escalations: CDN-level rate limits on the CF egress IP pool, login walls on the canonical URL, captchas, og-tag stripping. Mitigation strategy (graduated, only escalate when telemetry forces it):

1. **Telemetry from day one.** Worker logs `parser_outcome: ok | empty_og_desc | empty_og_image | http_429 | http_4xx | http_5xx` per request (no URL, no body). The phone logs `extraction_outcome: ok | caption_only | failed` per URL source. Both feed Sentry.
2. **Early warning bar.** If the IG `parser_outcome=ok` rate drops below 80% week-over-week, or HTTP 429 appears at all, treat that as a signal to pivot — not wait for users to complain.
3. **Pivot ladder, in order:**
   - a. Add randomized iPhone Safari / FB-bot / Twitter-bot User-Agent rotation and modest jitter on retries (cheap, in worker).
   - b. Add Cloudflare Browser Rendering for the cases where og tags come back empty (small per-request cost, no new vendor). Browser Rendering can also extract carousel slides 2..N when extraction quality matters — that's a free side-effect of needing it for the canary case.
   - c. Switch IG entirely to a paid scraping vendor (Apify or RapidAPI). Adds vendor secret + spend.
   - d. Worst case: deprecate the IG URL path and route IG users back to share-screenshot. The screenshot path remains the product's primary capture and is unaffected.

Each rung up the ladder is a documented call-out, not a silent re-implementation — the spec is amended before any pivot lands. The point: **the design has a fallback path at every degradation level**.

TikTok longevity risk is materially lower: og-tag previews are used by every social-link engine on the web and oEmbed is an officially documented backup. No mitigation ladder needed beyond the same telemetry pulse.

### TikTok handler

1. If the URL is a short link (`vm.tiktok.com/...`, `vt.tiktok.com/...`), resolve it via a HEAD request to get the canonical `tiktok.com/@user/video/<id>` URL.
2. Fetch the canonical URL with iPhone Safari UA. Parse `og:*` meta tags — same pattern as IG.
   - `caption ← og:description` (decoded). TikTok's preview format is typically `<author> on TikTok: "<caption text>"`.
   - `imageUrls ← [og:image]` (the cover frame; one URL).
   - `author ← og:title` author segment, OR extract from URL path `/@<handle>/video/...`.
3. **Fallback to oEmbed** if og tags are missing or `og:description` is empty: hit `https://www.tiktok.com/oembed?url=<canonicalUrl>`, map `title → caption` and `thumbnail_url → imageUrls[0]`. oEmbed is officially documented; it's the safety net, not the primary path.

### Caching

`Cache-Control: public, s-maxage=86400` on success responses. Cache key = normalized URL. Pre-launch the cache will mostly serve the user's own re-shares; post-launch it amortizes across users.

### Privacy

Continue the existing proxy posture: log HTTP status, latency, error class. Never log the URL, caption text, or response body.

### Secrets / env

None for MVP. Both fetchers are auth-free. If we later swap IG to Apify or add YouTube, `APIFY_TOKEN` / `YOUTUBE_API_KEY` would be added then.

## Storage / schema

**One migration:**

```sql
ALTER TABLE sources ADD COLUMN platform TEXT NULL;
-- Values: 'instagram' | 'tiktok' | NULL. NULL for kind='screenshot' rows.
```

**Field usage for a URL source:**

| Column                             | Value                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `kind`                             | `'url'`                                                                                                            |
| `platform`                         | `'instagram'` or `'tiktok'`                                                                                        |
| `url`                              | Canonical post URL (TikTok short links resolved to long form)                                                      |
| `file_path`                        | Local path to the downloaded **cover image** (slide 1)                                                             |
| `content_hash`                     | SHA-256 of the normalized URL                                                                                      |
| `ocr_text`                         | On-device OCR of the cover image + `\n---\n` + caption text from `og:description`, stored as one concatenated blob |
| `ocr_status` / `extraction_status` | `pending` → `done` / `failed` as the pipeline progresses                                                           |
| `captured_at`                      | Time of share                                                                                                      |
| `trip_id`                          | From the share-extension trip picker                                                                               |
| `origin`                           | `'share'`                                                                                                          |

`ocr_text` carries both OCR'd image text **and** caption text. The column name is now slightly imprecise but the downstream wiring (`/extract` input, `place_sources.raw_text` FTS indexing, search) already keys off it. A separate `caption_text` column would force every downstream consumer to learn about it. A one-line schema comment documents the revised meaning.

**Only the cover image is downloaded and persisted.** Phase 0 spike confirmed carousel slides 2..N are not server-side reachable from the canonical URL; they're loaded client-side after JS execution. The WebView playback (below) renders all slides natively via IG's embed iframe from its CDN — so the user still gets visual access to every slide; we just don't OCR them. No `source_images` junction table, no temp-file cleanup invariant.

**Deliberately not added:** `author_handle`, `post_timestamp`, `like_count` columns. Fetchers return these but nothing in the v0.2.1 UI uses them. Add when there's a surface that needs them.

## Processing pipeline

Lives in the existing `modules/processing` state-machine. URL sources slot in as a third entry-point, with a new "fetch + download" stage that runs before OCR. After OCR, the flow merges into today's screenshot path.

End-to-end:

```
[Share ext writes pending URL]
        ↓ (app foreground)
[Ingest: INSERT sources row, kind='url', status=pending]
        ↓
[Worker POST /fetch-post] → { imageUrls: [cover], caption }
        ↓
[Phone downloads imageUrls[0] → sources.file_path]
        ↓
[Run on-device OCR on the downloaded cover (modules/vision-ocr)]
        ↓
[Concat: ocrText = ocr + "\n---\n" + caption]
        ↓
[UPDATE sources SET ocr_text=concatText, ocr_status='done']
        ↓
[POST /extract with ocrText → places]
        ↓
[INSERT places + place_sources rows]
[UPDATE extraction_status='done']
```

In v0.2.1 the worker always returns at most one image URL per source (carousels are descoped — see Worker / Instagram handler). The pipeline therefore handles a single cover image, simplifying the OCR step to the existing single-image module call. If the longevity-risk pivot ladder ever brings multi-slide support back via CF Browser Rendering, the pipeline grows back to the multi-image variant described in prior drafts of this spec.

### Status state machine

| Stage                     | `ocr_status` | `extraction_status` | Persisted                                    |
| ------------------------- | ------------ | ------------------- | -------------------------------------------- |
| Ingested                  | `pending`    | `pending`           | `url`, `platform`, `content_hash`, `trip_id` |
| Worker fetched            | `pending`    | `pending`           | (caption held in memory)                     |
| Cover persisted           | `pending`    | `pending`           | + `file_path`                                |
| OCR + caption concat done | `done`       | `pending`           | + final `ocr_text`                           |
| Extracted                 | `done`       | `done`              | + `places` + `place_sources`                 |

### Per-stage failure handling

| Stage fails                                                       | Outcome                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/fetch-post` returns `not_found` / `private` / `unsupported_url` | `ocr_status='failed'`, `extraction_status='failed'`. No `file_path`. UI shows platform placeholder tile.                                                         |
| `/fetch-post` returns `502` / `504` / network error               | One automatic retry with 30s backoff. If retry also fails → `failed`. User can re-share to retry.                                                                |
| Worker succeeds but `imageUrls` is empty (caption present)        | Skip image-download + OCR. `ocr_text = caption`, `ocr_status='done'`, `file_path=NULL`. Tile uses placeholder; extraction runs on caption alone.                 |
| Cover image download fails (`imageUrls[0]`)                       | Continue with caption-only: skip OCR, `ocr_text = caption`, `ocr_status='done'`, `file_path=NULL`. Tile uses placeholder; places may still extract from caption. |
| OCR fails on cover image                                          | `ocr_text = caption` (caption-only fallback), `ocr_status='done'`, keep `file_path` since image is fine for display.                                             |
| `/extract` returns empty                                          | `extraction_status='done'`, 0 places. Same as screenshot path today.                                                                                             |
| `/extract` returns error                                          | `extraction_status='failed'`. Same as screenshot path today.                                                                                                     |
| WebView playback fails on detail screen                           | n/a — data is fine. Toast + collapse to cover image; deep-link button stays available.                                                                           |
| Network unavailable at share time                                 | Source inserted as `pending`. Existing screenshot offline-resume logic resumes the URL pipeline on next online window.                                           |

The pipeline persists only the single cover image (`imageUrls[0]`) — the multi-slide temp-file cleanup invariant from earlier drafts is no longer needed because we never download more than one image per URL source in v0.2.1.

The **caption-only fallback** matters: list-style IG posts ("6 must-visit Mt Fuji spots: Chureito Pagoda, ...") extract great from caption alone. Failing the source just because the image step had a hiccup would be needless.

### No worker image proxying

IG and TikTok cover URLs are public CDN endpoints (no auth required). Phone downloads directly. The existing `/photo/:name` proxy is specifically for Google Places photos which need API-key auth — not relevant here.

## UI

URL sources reuse existing surfaces. The design intent is "a source that happens to have a link," not a parallel UI track.

### Tile (inbox grid + trip Sources sub-tab)

- Same layout as a screenshot tile. `file_path` is the cover image, sized identically.
- New: a small monochrome platform badge in the top-right corner (~20pt, IG/TikTok logo, semi-transparent over the image).
- Cover-download failure state: platform-tinted placeholder card with the platform icon centered and "Couldn't load" copy beneath.
- Tap tile → existing source detail screen. Tap badge → opens original post via `Linking.openURL(source.url)` (iOS routes to platform app if installed).

### Source detail screen

- **Hero** (URL sources):
  - Initial: cover image, full-bleed, same as today's screenshot hero.
  - Overlaid centred: a ▶ play affordance (~64pt, white, subtle backdrop blur).
  - Tap ▶ → cover is replaced in-place by a `react-native-webview` loaded with the platform's embed URL:
    - IG: `https://www.instagram.com/p/<shortcode>/embed/captioned`
    - TikTok: `https://www.tiktok.com/embed/v2/<id>`
  - **Aspect ratio:** container defaults to the cover image's intrinsic aspect (which the phone already has from the downloaded `file_path`), clamped to a sensible range: `min 1:1` (don't go wider than square), `max 9:16` (don't go taller than reel). Out-of-range content is letterboxed with a blurred extension of the cover image as background. Rationale: IG feed posts are 1:1 / 4:5 / 1.91:1; Reels and TikToks are 9:16. Hard-coding 9:16 made square feed posts look bad.
  - Cover image stays visible as a poster until WebView `onLoadEnd`.
  - Small `✕` button top-right of the WebView → collapse back to cover.
  - WebView `onError` or 10s load timeout → collapse to cover, toast "Couldn't load player — tap to open in Instagram", deep-link button remains.
  - The IG embed iframe natively renders carousel slides with swipe controls. No extra code needed for carousel playback.
  - **Required iOS `react-native-webview` props for inline playback:**
    - `allowsInlineMediaPlayback={true}` — without this, iOS defaults to fullscreen-on-play, breaking the inline-hero intent.
    - `mediaPlaybackRequiresUserAction={false}` — IG/TikTok embeds attempt autoplay on load; this allows it. (Both platforms require user gesture for _audio_, so this won't blast sound out — just enables silent autoplay of muted preview, which matches the platform's own behavior.)
    - `scalesPageToFit={false}` — embed iframes handle their own sizing; letting RN scale them causes layout drift.
    - `injectedJavaScriptBeforeContentLoaded` — inject a tiny snippet that hides IG/TikTok's "follow" / "like" overlays if they prove distracting (deferred to polish unless they're clearly intrusive in QA).
- **Below hero:**
  - A small action chip: `↗ Open in Instagram` / `↗ Open in TikTok` (`Linking.openURL(source.url)`). Distinct intent from the inline player — the chip goes to the platform app for comments/sound/likes.
  - A subtle metadata strip line: "From instagram.com" (host derived from the URL, no new column required).
- **Places found sheet, OCR text view, triage actions, trip assignment** — unchanged.

### Triage flow

No changes. The existing layout reuses the source detail's hero, which now correctly handles URL sources via the ▶ play affordance.

### Place tiles (places-first home)

Zero changes. A place is a place — same enrichment, same Google Places photo, same tap-to-open-Maps. Source kind is invisible at the place level.

### Search

No changes. Caption text is concatenated into `ocr_text` → indexed by FTS5 via the existing `place_sources.raw_text` pipeline → URL-sourced places become searchable by caption keywords automatically.

### Filter chips on the home grid

No changes. Filter logic is per `trip_id`, not per source kind.

### Empty-state copy

Update the inbox empty-state copy from "Share a screenshot to get started" → "Share a screenshot or a link to get started." Folded into the existing v0.2 empty-state audit already in flight.

### Dependencies

`react-native-webview` (Expo-supported, ~100 KB to bundle).

### Tile mock (text)

```
┌─────────────────────────┐
│                         │
│   [ cover image ]   IG │  ← platform badge, top-right
│                         │
│   ─────────────────    │
│   Maru Tonkatsu  ✏ ⋯   │  ← existing place line
└─────────────────────────┘
```

## Edge cases

- **IG carousel:** only the cover (slide 1) is downloaded and OCR'd. Caption (which often enumerates places in list-style posts, the most common carousel format for travel content) contributes to extraction. The WebView handles slides 2..N playback on demand from IG's CDN — visual access preserved even though we don't OCR them. Image-only carousels (no place names in caption) extract only the cover's place; revisit if real users complain.
- **IG Story shared:** Stories have no `/embed/` endpoint. Worker returns `unsupported_url`; share-extension hostname filter also catches `instagram.com/stories/...`. Document the limitation; no in-app surfacing for MVP.
- **TikTok short link** (`vm.tiktok.com/...`): worker resolves via HEAD before calling oEmbed; canonical URL is stored in `sources.url`.
- **Same post shared twice:** existing `content_hash` dedupe (now over normalized URL) catches it. Second share opens the existing source and surfaces a "Already saved" toast.
- **Both URL and image present in share intent:** disambiguation prefers URL (see Capture path section).
- **User shares an IG post they've already saved as a screenshot:** treated as a separate source (different `content_hash`). Acceptable for MVP; future dedupe by extracted place identity is out of scope.
- **Non-allow-listed hostname** (e.g. a generic `news.com` link): share extension's hostname check causes the OS-level cancellation. Trip Pocket does not appear in the share sheet for non-supported URLs in the long run (Info.plist predicate restriction can be added in a follow-up), but the runtime check is the immediate guard.

## Open questions / explicitly deferred

1. **Author handle storage and "via @user" surfacing** — fetchers return it, MVP doesn't store. Add when a UI surface wants it.
2. **IG `__additionalDataLoaded` parser stability** — depends on IG keeping the embed JSON shape stable. The Phase 0 spike confirms feasibility but doesn't immunize against future breakage. Add a Sentry-tagged log when the parser returns 0 images for an IG embed; act on it if the rate climbs.
3. **YouTube support** — out of MVP. Lives in v1.x parking lot of `docs/ROADMAP.md`.
4. **TikTok video frame OCR / transcript** — not pursued. Revisit if real-user extraction quality on TikTok proves weak.
5. **Telemetry on empty-extraction rate per platform** — not built. Rely on manual TestFlight feedback in v0.3.
6. **Worker URL canonicalisation rules** — exact rules for which query params to strip, locale handling, etc. — finalise in the implementation plan.
7. **`react-native-webview` performance on older iOS devices** — measure once integrated; if poor, fall back to a Safari-View-Controller deep-link instead of inline playback.

## Implementation phase 0 — spike completed

**Result:** [`2026-05-12-url-share-spike-results.md`](./2026-05-12-url-share-spike-results.md).

Headline: `/embed/captioned` no longer carries post data in static HTML (became a JS shell). The **canonical post URL** (`https://www.instagram.com/p/<id>/`) still serves a full social-share preview via `og:*` meta tags (caption + cover image), readable by any `fetch()` with a non-Chrome User-Agent. Carousel slides 2..N are not server-side reachable from the canonical URL either, so they are **descoped** from v0.2.1; the spec above already reflects this. Implementation may proceed against the amended design.

Follow-up validation (not blocking, captured in spike results follow-ups):

- TikTok canonical-URL og-tag pattern to be validated during worker implementation against 2–3 real public URLs.
- Worker tests should snapshot a recorded HTML fixture so they don't hit IG every run.
- Sentry instrumentation around `og:description` being absent — the canary for IG changing the og-tag generation pipeline.
