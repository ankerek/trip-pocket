# URL share & extraction — design

**Status:** approved (2026-05-12) · ready for implementation plan
**Targets:** v0.2 follow-up (likely v0.2.1). Adds a third capture path alongside share-sheet screenshots and camera-roll import.

## Why

PRODUCT.md's capture path is "see something on Instagram or TikTok, tap Share → Trip Pocket." Today that only works when the user taps Instagram's *screenshot* option — sharing the post URL itself is rejected by the share extension (Info.plist activation rule is image-only, and `ShareViewController` only reads `UTType.image`).

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

| Platform | Fetcher | Notes |
|---|---|---|
| Instagram | Parse `https://www.instagram.com/p/<id>/embed/captioned` HTML | Free, no auth. Handles posts and reels. Stories not supported. |
| TikTok | TikTok oEmbed (`https://www.tiktok.com/oembed?url=…`) | Free, no auth. `title` field carries the post caption. |

YouTube is explicitly **deferred** to the v1.x parking lot in `docs/ROADMAP.md` — it would have needed a separate Data API path and adds maintenance surface.

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

Sanity check on hostname before writing the pending import — reject anything that isn't `instagram.com`, `instagr.am`, `tiktok.com`, or `vm.tiktok.com`. Rejection inside the share extension shows the OS-level "extension cancelled" affordance; that's acceptable for MVP (a richer "Unsupported link" inline message is a v0.3 polish item).

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

1. Normalize the URL (strip query params, trailing slash, lowercase host).
2. Compute `content_hash = SHA-256(normalizedUrl)`.
3. Compute `platform` from hostname (`instagram` / `tiktok`).
4. `INSERT INTO sources (kind='url', platform, url=normalizedUrl, content_hash, file_path=NULL, ocr_status='pending', extraction_status='pending', captured_at=now, trip_id=suggestedTripId, origin='share', ...)`.
5. Enqueue the URL processing job (Section: Processing pipeline).

If `content_hash` collides with an existing source, surface a one-time toast ("Already saved to <trip>") and open that source — same UX as duplicate-screenshot today.

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

`imageUrls` is always a non-empty array. Length 1 for single posts and for all TikTok responses. Length > 1 for IG carousels.

**Error response:** `{ "error": "<code>" }` with HTTP status:
- `400 unsupported_url` — hostname not in the allowlist (should not occur given share-extension prefilter; defence in depth).
- `404 not_found` — post doesn't exist or was deleted.
- `403 private` — post requires auth.
- `502 fetch_failed` — upstream HTTP error or HTML parse failure.
- `504 timeout` — upstream took > 10s.

**Internal dispatch by hostname:**

### Instagram handler

1. Fetch `https://www.instagram.com/p/<shortcode>/embed/captioned` with a desktop User-Agent.
2. Parse the response HTML for:
   - **Carousel slide URLs**: locate the `<script>` tag containing `window.__additionalDataLoaded(` (or the equivalent JSON-LD blob). Parse the embedded JSON for `edge_sidecar_to_children.edges[].node.display_url` (carousel) or `display_url` (single).
   - **Caption**: prefer the JSON blob's `edge_media_to_caption.edges[0].node.text`. Fallback to `og:description` if the blob is missing.
   - **Author**: parse from the JSON blob's `owner.username` or fallback to `og:url` path segment.
3. If no images can be extracted from the blob but `og:image` exists, return `imageUrls: [og:image]` and continue. This is the "carousel data missing but single image fallback" case.
4. If `og:image` is also missing → return `502 fetch_failed`.

**Carousel implementation risk:** the `__additionalDataLoaded` blob is undocumented and IG can change its shape. The implementation plan must include a **Phase 0 spike** on 5+ real carousel URLs to confirm slide URLs are reliably present. If the spike fails, the fallback is Cloudflare Browser Rendering (~$0.0009/req on JS-rendered carousels only). The spec assumes the spike succeeds; if it doesn't, that's a design amendment, not a hidden requirement.

### TikTok handler

1. If the URL is a short link (`vm.tiktok.com/...`), resolve it via a HEAD request to get the canonical `tiktok.com/@user/video/<id>` URL.
2. Fetch `https://www.tiktok.com/oembed?url=<canonicalUrl>`.
3. Map response fields:
   - `caption ← title` (TikTok's oEmbed `title` field carries the post caption).
   - `imageUrls ← [thumbnail_url]`.
   - `author ← "@" + author_name`.

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

| Column | Value |
|---|---|
| `kind` | `'url'` |
| `platform` | `'instagram'` or `'tiktok'` |
| `url` | Canonical post URL (TikTok short links resolved to long form) |
| `file_path` | Local path to the downloaded **cover image** (slide 1) |
| `content_hash` | SHA-256 of the normalized URL |
| `ocr_text` | OCR of slide 1 + `\n` + OCR of slide 2 + ... + `\n---\n` + caption text, stored as one concatenated blob |
| `ocr_status` / `extraction_status` | `pending` → `done` / `failed` as the pipeline progresses |
| `captured_at` | Time of share |
| `trip_id` | From the share-extension trip picker |
| `origin` | `'share'` |

`ocr_text` carries both OCR'd image text **and** caption text. The column name is now slightly imprecise but the downstream wiring (`/extract` input, `place_sources.raw_text` FTS indexing, search) already keys off it. A separate `caption_text` column would force every downstream consumer to learn about it. A one-line schema comment documents the revised meaning.

**Carousel slides 2..N are not persisted.** They are downloaded to temp files, OCR'd, concatenated into `ocr_text`, then deleted. Only slide 1 (the cover) persists as `file_path`. Rationale: the WebView playback (below) renders all slides from IG's own CDN on demand, so the app has no need to be a local mirror. This keeps storage simple and avoids a `source_images` junction table.

**Deliberately not added:** `author_handle`, `post_timestamp`, `like_count` columns. Fetchers return these but nothing in the v0.2.1 UI uses them. Add when there's a surface that needs them.

## Processing pipeline

Lives in the existing `modules/processing` state-machine. URL sources slot in as a third entry-point, with a new "fetch + download" stage that runs before OCR. After OCR, the flow merges into today's screenshot path.

End-to-end:

```
[Share ext writes pending URL]
        ↓ (app foreground)
[Ingest: INSERT sources row, kind='url', status=pending]
        ↓
[Worker POST /fetch-post]
        ↓
[Phone downloads ALL imageUrls to temp files (parallel)]
        ↓
[Persist imageUrls[0] → sources.file_path]
[Run on-device OCR on every temp image (parallel, via modules/vision-ocr)]
        ↓
[Concat: ocrText = ocr1 + "\n" + ocr2 + ... + "\n---\n" + caption]
[Delete temp files for slides 2..N]
        ↓
[UPDATE sources SET ocr_text=concatText, ocr_status='done']
        ↓
[POST /extract with ocrText → places]
        ↓
[INSERT places + place_sources rows]
[UPDATE extraction_status='done']
```

### Status state machine

| Stage | `ocr_status` | `extraction_status` | Persisted |
|---|---|---|---|
| Ingested | `pending` | `pending` | `url`, `platform`, `content_hash`, `trip_id` |
| Worker fetched | `pending` | `pending` | (caption held in memory) |
| Cover persisted | `pending` | `pending` | + `file_path` |
| OCR + caption concat done | `done` | `pending` | + final `ocr_text` |
| Extracted | `done` | `done` | + `places` + `place_sources` |

### Per-stage failure handling

| Stage fails | Outcome |
|---|---|
| `/fetch-post` returns `not_found` / `private` / `unsupported_url` | `ocr_status='failed'`, `extraction_status='failed'`. No `file_path`. UI shows platform placeholder tile. |
| `/fetch-post` returns `502` / `504` / network error | One automatic retry with 30s backoff. If retry also fails → `failed`. User can re-share to retry. |
| Any cover image download fails (slide 1) | Continue with caption-only: skip OCR, `ocr_text = caption`, `ocr_status='done'`, `file_path=NULL`. Tile uses placeholder; places may still extract from caption. |
| OCR fails on a single slide (carousel) | Skip that slide's OCR contribution; continue with others + caption. |
| OCR fails on slide 1 (single post) | Same as cover-download failure: caption-only fallback. |
| `/extract` returns empty | `extraction_status='done'`, 0 places. Same as screenshot path today. |
| `/extract` returns error | `extraction_status='failed'`. Same as screenshot path today. |
| WebView playback fails on detail screen | n/a — data is fine. Toast + collapse to cover image; deep-link button stays available. |
| Network unavailable at share time | Source inserted as `pending`. Existing screenshot offline-resume logic resumes the URL pipeline on next online window. |

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
  - 9:16 aspect ratio. Cover image stays visible as a poster until WebView `onLoadEnd`.
  - Small `✕` button top-right of the WebView → collapse back to cover.
  - WebView `onError` or 10s load timeout → collapse to cover, toast "Couldn't load player — tap to open in Instagram", deep-link button remains.
  - The IG embed iframe natively renders carousel slides with swipe controls. No extra code needed for carousel playback.
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

- **IG carousel:** all slides are downloaded, OCR'd, contribute text to extraction. Only slide 1 persists; the WebView handles slides 2..N playback on demand.
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

## Implementation phase 0 — required spike

Before any production work, validate the IG `/embed/` carousel-slide parser:

1. Pick 5 real IG carousel URLs (varied: travel, food, lifestyle, with 2/4/6/8/10 slides).
2. From a CF Worker (or a Node script using a desktop User-Agent), `fetch()` `https://www.instagram.com/p/<id>/embed/captioned` for each.
3. Inspect the response HTML for `window.__additionalDataLoaded`, JSON-LD blob, or other structured data containing slide image URLs.
4. Outcome decides:
   - **All 5 carousels expose full slide URLs reliably** → proceed with this spec as written.
   - **Some carousels expose them, some don't** → either accept the gap (single-image fallback) or amend the spec to add Cloudflare Browser Rendering for the missing cases.
   - **None expose them** → amend the spec to use CF Browser Rendering for all IG carousel posts. Estimate cost impact before proceeding.

The spike outcome must be recorded in the implementation plan before code lands.
