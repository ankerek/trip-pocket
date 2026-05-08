# Trip Pocket — App Redesign

**Status:** Approved design  ·  **Date:** 2026-05-08  ·  **Branch:** `feat/places-first-restructure`

## 1. Goal

Reimagine Trip Pocket as a modern iOS app where two moments feel exceptional:

1. **The library** — opening Pocket and browsing saved places feels alive and beautiful.
2. **The capture** — sorting newly-arrived screenshots feels fast, magical, and never tedious.

The redesign keeps the existing places-first data model and pipelines (capture → OCR → extraction → enrichment) untouched. Everything below the model is in scope.

## 2. Direction (locked through brainstorming)

| Decision           | Locked                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Scope              | Full reimagining (IA, screens, motion, visual system on the table)      |
| Personality        | iOS Native Premium — SF Pro, blurred materials, photo-led               |
| Motion vocabulary  | Expressive — shared-element morph, list parallax, spring with overshoot |
| Hero moments       | Library + Capture (twin priorities)                                     |
| IA                 | Two tabs (Pocket, Trips) + center capture FAB                           |
| Triage flow        | Hero photo + bottom sheet (swipe between items, edit fields inline)     |
| Palette            | Sea + Teal — Sea `#0c4a6e`, Teal `#14b8a6`, Snow `#f8fafc`, Mint `#ccfbf1` |
| Color modes        | Light + dark, both first-class                                          |

## 3. Information architecture

```
[ Pocket ]   [ + Capture ]   [ Trips ]
   |              |              |
   v              v              v
 Home tab     Action sheet    Trip list
                  → Photos picker → Triage flow
                  → Take photo → Triage (single)
                  → Paste image → Triage (single)
```

- **Pocket** is the library home. Inbox banner appears at the top only when at least one source has not been triaged.
- **+ Capture** is a center-tab-bar FAB. Tapping it raises an iOS action sheet (`Pick from Photos · Take photo · Paste from clipboard`). The existing share extension keeps working unchanged and feeds the Inbox.
- **Trips** is the destination canvas list. Each trip is a rich page with a cover photo, stats, and a places grid (and a future map mode).
- **Settings** moves out of the tab bar into a profile-avatar button in the header of every tab, opening as a sheet.

This is a deliberate IA change from the current `Places / Trips / Settings` three-tab layout. The motivation: capture must be unmissable, settings is rare, and "Places" / "Pocket" deserves the same name and prominence the user already calls it.

## 4. Surfaces

### 4.1 Pocket (home)

- **Header:** large title `Pocket` (SF Pro Display 34pt, -0.5 letter-spacing). Avatar button right (opens settings sheet). Search glyph right of title.
- **Inbox banner** — shown only when `inbox_count > 0`. Card on Mint `#ccfbf1` surface, Sea text. Format: badge with count, "New screenshots", "Tap to triage", chevron right. Dismissible with a horizontal pan (snooze for the session, not destructive). Sticky parallax — translateY at half scroll speed until it pins under the large title, then becomes a blurred chip.
- **Filter pills** — `All · <Trip A> · <Trip B> · …`. Horizontal scroll, active pill = Sea bg + Snow text, inactive = Snow-200 bg + slate text.
- **Place grid** — 2 columns, 3:4 aspect tiles, 12pt radius, 6pt gutter. Tile shows hero photo (or placeholder gradient if pre-enrichment) with bottom gradient and white place name overlay. Trip chip top-left: Snow translucent material, tiny.
- **Empty state** — centered illustration + line: "Save your first travel screenshot — share from Photos."
- **Pull to refresh** — runs `processor.runOcrSweep` + `extractor.runExtractionSweep`.

### 4.2 Triage flow (modal)

Opens from the Inbox banner or after a manual capture.

- **Top half** (45% of screen) — full-bleed screenshot. Top overlay: close `✕`, progress `1 of 3`, edit affordance.
- **Bottom sheet** — rounded-top sheet, three detents (`0.55`, `0.85`, `1.0`).
  - **AI extracted** label pill (Teal accent gradient).
  - Place name (large title 22pt) + location subtitle.
  - Field rows: `Trip ›`, `Category ›`, `Notes ›`. Tapping any row pushes a focused picker sheet.
  - Primary button: `Save & next →` (Teal, full-width).
  - Secondary actions row above primary: `Skip`, `Save without trip`.
  - At full detent, sheet expands to show OCR text, source thumbnail, and "Found in this screenshot" list (existing places-found UI surfaced here).
- **Horizontal swipe** between items (`PagerView`-style). Bottom dot indicator under the sheet.
- **Save behavior** — confirmed item moves out of inbox; if it's the last, sheet animates closed and returns to Pocket with a success haptic.

### 4.3 Place detail (`/places/[id]`)

- **Hero photo** full-bleed at top (~40% screen). The photo is the *receiver* of the shared-element transition from the grid tile. Trip chip overlays top-left, close button top-right.
- **Title block** below: place name (28pt), location, rating chips (4.6 ★ · $$ · Tonkatsu).
- **Primary CTA:** `Open in Maps` (Teal, full-width). Long-press for app picker (Apple Maps / Google Maps / Citymapper).
- **Notes section** with a single inline editable line.
- **Source row** — a small thumbnail of the original screenshot. Tap opens viewer with OCR debug toggle.
- **"Found in this screenshot"** — collapsible list of other places extracted from the same source.
- **Trip section** — current trip pill, tap to change.
- **Close gesture** — pull-down dismisses with reverse shared-element back to the originating tile.

### 4.4 Trips tab

- **Header:** large title `Trips`. New-trip `+` right.
- **List of trip rows** — each row is a card with cover photo (left, 80×100, 12pt radius), trip name, place count, last-activity relative date, and a horizontal preview strip of recent place thumbs (existing pattern, restyled).
- Tap → trip detail.
- Empty state: "No trips yet — tap + to start your first."

### 4.5 Trip detail (`/trips/[id]`)

- **Cover photo header** — full-bleed, ~30% screen. Auto-picked from the highest-rated enriched place in the trip; editable in the trip-edit sheet.
- **Title block** under the cover: trip name, place count, category breakdown chips, last activity.
- **View toggle:** `Grid | Map`. Grid = same 2-col tile layout, scoped to this trip. Map mode is out of scope for this redesign — the toggle renders the Map option in a disabled state with a "Coming soon" subtitle so the layout is final.
- **Edit / rename / delete** lives in a sheet triggered from the title's `…` button.

### 4.6 Capture sheet

- React Native `ActionSheetIOS.showActionSheetWithOptions`.
- Options: `Pick from Photos`, `Take photo`, `Paste from clipboard`, `Cancel`.
- After selection, screenshots feed straight into the triage flow with a stagger (one card lands per item, 80ms offset). Result haptic on success.

## 5. Motion vocabulary

| Interaction              | Motion                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Tile → Place detail      | Shared-element morph (photo + trip chip), surrounding tiles fall away (-8px Y, 0.94 scale, 0 opacity), 380ms spring, overshoot tension 180. |
| Place detail close       | Reverse of the above. Pinch-to-zoom-out also dismisses.                                 |
| Inbox banner             | Half-speed parallax until it pins; on pin, swaps to blurred-chip variant in the header. |
| Triage save              | Current card -y 30px + fade out; next card slides in from x: +24px, spring.              |
| FAB tap                  | Scale 0.92 → spring back. Sheet rises with `cubic-bezier(0.32, 0.72, 0, 1)`, 320ms.      |
| Tab switch               | Cross-fade with content stagger (children fade in 40ms apart).                          |
| Pull to refresh          | Custom indicator: Teal arc draws as user pulls; springs to chevron when threshold met.  |

Implementation: Reanimated 4 layout transitions for shared-element where supported, with `react-native-screens` native push as fallback. View Transitions API used on web build only.

## 6. Visual system

### 6.1 Color tokens

| Token              | Light            | Dark             | Use                                |
| ------------------ | ---------------- | ---------------- | ---------------------------------- |
| `--color-bg`       | `#ffffff`        | `#020617`        | App background                     |
| `--color-surface`  | `#f8fafc` (Snow) | `#0f172a`        | Cards, sheets                      |
| `--color-text`     | `#0c4a6e` (Sea)  | `#e2e8f0`        | Primary text                       |
| `--color-text-muted` | `#64748b`      | `#94a3b8`        | Secondary text                     |
| `--color-accent`   | `#14b8a6` (Teal) | `#2dd4bf`        | CTA, active state, brand           |
| `--color-info-bg`  | `#ccfbf1` (Mint) | `#134e4a`        | Inbox banner background            |
| `--color-info-text` | `#115e59`       | `#5eead4`        | Inbox banner text                  |
| `--color-hairline` | `rgba(15,23,42,0.06)` | `rgba(255,255,255,0.08)` | Tile/sheet strokes        |

### 6.2 Type scale

- Display 34 / Display 28 / Title 22 / Headline 17 / Body 15 / Caption 12 / Micro 10
- All SF Pro Display ≥17, SF Pro Text below
- Tabular nums for counts and dates
- Letter-spacing -0.5 on Display 34, -0.4 on Display 28, -0.3 on Title 22

### 6.3 Surfaces & materials

- Tab bar, headers, picker sheets use `BlurView` with `systemMaterial` (existing project pattern from `_layout.tsx`).
- Tile photos: 12pt radius, 1px hairline at 6% opacity.
- Sheets: 20pt top radius, grabber 40×4 at 12pt above content.
- Shadows are subtle: `0 6px 16px rgba(15,23,42,0.10)` for elevated cards; tiles are flat.

### 6.4 Density

Airy, photo-led. 14pt page padding. 6pt grid gutter. 16pt vertical rhythm between sections.

## 7. Component changes

| Component                | Action                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `PlaceTile`              | Rebuild as shared-element host. Add trip chip slot, gradient overlay.   |
| `PlaceGrid`              | Keep, restyle gutter and aspect (3:4).                                  |
| `InboxBanner`            | New. Sticky-parallax variant + collapsed-chip variant.                  |
| `TripPill` filter row    | Refactor existing chip pattern, add active state with Teal bg.          |
| `CaptureFAB`             | New. Center tab-bar overlay. Triggers action sheet.                     |
| `CaptureActionSheet`     | New. Wraps `ActionSheetIOS`.                                            |
| `TriageScreen`           | New. Modal route, replaces inbox-detail navigation.                     |
| `TriageHeroSheet`        | New. Bottom sheet with three detents.                                   |
| `PlaceDetailHero`        | New. Shared-element receiver for the hero photo.                        |
| `TripDetailHeader`       | Restyle as cover-photo header.                                          |
| `Avatar`/`HeaderProfile` | New. Settings entry point.                                              |
| `TabBar`                 | Spike first: try absolute-positioned `CaptureFAB` overlaid above `NativeTabs` (cheapest). If layout/safe-area issues arise, fall back to a custom three-zone JS tab bar (tab \| FAB \| tab). Decision recorded in the spike notes. |
| Theme tokens             | New file `tw/theme.ts` exporting palette, type scale, spring presets.   |

Existing `_layout.tsx`'s `SHARED_HEADER_OPTIONS` (transparent + system blur) carries over; route registrations get updated for the modal `triage` and the dropped `(settings)` group.

## 8. Light + dark mode

Both first-class. Tab bar and headers use native `BlurView` (`systemMaterial` light/dark). Photo overlays for tile names use a stronger gradient on dark mode (more black at the bottom) to keep contrast. Teal accent stays vibrant in both modes; Sea text inverts to Snow-200.

## 9. Accessibility

- All tappable surfaces meet 44×44pt target.
- Place name overlays meet WCAG AA against worst-case photos (use 0.4 alpha black gradient; verify per-photo if luminance is high).
- Reduced motion: shared-element transitions degrade to fade; parallax disables; springs reduce to ease curves.
- VoiceOver labels: existing `accessibilityLabel` props in `PlaceTile`, `TripPicker`, etc. carry over and get re-validated on the new components.
- Dynamic Type: type scale uses scaled units; large-text mode reflows tiles to 1-column at body size XL+.

## 10. Out of scope

- In-app map view of saved places (future per ROADMAP)
- Cloud sync, account, auth (future)
- Itinerary generation
- Social and sharing features
- Web and Android variants of the redesign (current redesign targets iOS only)
- Changes to capture / OCR / extraction / enrichment pipelines — those modules stay as-is
- Onboarding redesign — handled separately

## 11. Risk & open questions

| Risk                                                          | Mitigation                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NativeTabs` may not allow a center FAB overlay               | Spike: try absolute-positioned FAB above NativeTabs first; fall back to custom JS tab bar.       |
| Shared-element transitions on RN 0.83 / Reanimated 4          | Spike with Reanimated 4 layout animations; alternate is `react-native-screens` shared element.   |
| Photo overlay legibility in dark mode                         | Verify with a test set of 10 hero photos across luminance ranges; tune gradient stops per mode. |
| Settings-as-sheet may hurt discoverability                    | Avatar in header is a known iOS pattern (Apple Music, Mail). Track via session telemetry post-ship. |
| Existing `(settings)` route group needs migration             | Move `app/(tabs)/(settings)/*` to `app/settings.tsx` modal; redirect old paths.                  |

## 12. Implementation phasing (high-level — drives the plan)

1. **Theme + tokens.** New `tw/theme.ts`, dark mode wired through, palette migrated.
2. **Tab bar + FAB.** Spike, then build. Settings sheet moved.
3. **Pocket home.** New header, Inbox banner, filter pills, restyled grid.
4. **Place detail.** Hero photo, shared-element transition, restyled body.
5. **Triage flow.** New modal, hero + bottom sheet, swipe pager.
6. **Trips list + detail.** Cover photo header, view toggle scaffold.
7. **Motion polish.** Parallax, stagger, custom pull-to-refresh, haptics.
8. **Accessibility pass.** Reduced motion, dynamic type, contrast audit.

Each phase is independently shippable; phases 1–4 deliver the library wow, 5 delivers the capture wow, 6–8 polish.
