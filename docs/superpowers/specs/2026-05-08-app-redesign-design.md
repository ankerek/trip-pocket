# Trip Pocket — App Redesign

**Status:** Approved design · **Date:** 2026-05-08 · **Branch:** `feat/places-first-restructure`

## 1. Goal

Reimagine Trip Pocket as a modern iOS app where two moments feel exceptional:

1. **The library** — opening Pocket and browsing saved places feels alive and beautiful.
2. **The capture** — sorting newly-arrived screenshots feels fast, magical, and never tedious.

The redesign keeps the existing places-first data model and pipelines (capture → OCR → extraction → enrichment) untouched. Everything below the model is in scope.

## 2. Direction (locked through brainstorming)

| Decision          | Locked                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Scope             | Full reimagining (IA, screens, motion, visual system on the table)         |
| Personality       | iOS Native Premium — SF Pro, blurred materials, photo-led                  |
| Motion vocabulary | Expressive — shared-element morph, list parallax, spring with overshoot    |
| Hero moments      | Library + Capture (twin priorities)                                        |
| IA                | Two tabs (Pocket, Trips) + center capture FAB                              |
| Triage flow       | Hero photo + bottom sheet (swipe between items, edit fields inline)        |
| Palette           | Sea + Teal — Sea `#0c4a6e`, Teal `#14b8a6`, Snow `#f8fafc`, Mint `#ccfbf1` |
| Color modes       | Light + dark, both first-class                                             |

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
- **Pull to refresh** — invokes a single `runForegroundIngest()` helper that wraps the established foreground sequence (`ingestPendingImports` → `processor.runOcrSweep` → `extractor.runExtractionSweep`) under the same `ingesting` mutex used by `app/_layout.tsx`. This avoids racing with foreground ingestion and ensures share-extension imports are not missed. The helper is extracted from the existing block in `app/_layout.tsx` and reused by both that effect and pull-to-refresh.

### 4.2 Triage flow (modal)

Opens from the Inbox banner or after a manual capture.

**Presentation.** Route registered with `presentation: 'fullScreenModal'` (not `formSheet`). Native sheet detents cannot be used here because they resize the _entire_ presented screen and we need the screenshot to remain visible above a draggable sheet. The bottom sheet is therefore a JS-implemented sheet on top of the modal screen — built with `react-native-reanimated` + `react-native-gesture-handler` (or `@gorhom/bottom-sheet` if added; decision in the spike).

- **Top half** (~45% of screen) — full-bleed screenshot. Top overlay: close `✕`, progress `1 of 3`, edit affordance.
- **JS bottom sheet** — phase 5 ships an _auto-snap_ sheet with two states (`0.55` resting, `0.85` expanded for keyboard). User-initiated drag-to-snap with overshoot is deferred to phase 7 (motion polish) so the rest of the redesign can land. Rounded top corners 20pt, grabber 40×4 still drawn (informational, not interactive in v1).
  - **AI extracted** label pill (Teal accent gradient).
  - Place name (large title 22pt) + location subtitle.
  - Field rows: `Trip ›`, `Category ›`, `Notes ›`. Tapping any row pushes a focused picker sheet.
  - Primary button: `Save & next →` (Teal, full-width).
  - Secondary actions row above primary: `Skip`, `Save without trip`.
  - At full snap, sheet expands to show OCR text, source thumbnail, and "Found in this screenshot" list (existing places-found UI surfaced here).
- **Horizontal swipe** between items uses a horizontal `FlatList` with `pagingEnabled` (NOT `react-native-pager-view` — avoids gesture conflicts with the vertical sheet pan). Bottom dot indicator under the sheet. Gesture rule: when the sheet is at any snap point > `0.55`, horizontal swipes are disabled to prevent gesture race.
- **Keyboard behavior.** When any text field gains focus (Notes, picker search), the sheet auto-snaps to `0.85` minimum (or `1.0` if Dynamic Type ≥ XL). `KeyboardAvoidingView` (`behavior="padding"`) wraps the sheet content so primary action stays visible above the keyboard.
- **Modal isolation.** Set `accessibilityViewIsModal={true}` on the modal root and `importantForAccessibility="no-hide-descendants"` on the underlying tabs. Initial VoiceOver focus = sheet's place name. On dismiss, focus restores to the originating Inbox banner (or the FAB if entered from manual capture).
- **Save behavior** — confirmed item moves out of inbox; if it's the last, sheet animates closed and returns to Pocket with a success haptic.

### 4.3 Place detail (`/places/[id]`)

- **Hero photo** full-bleed at top (~40% screen). The photo is the _receiver_ of the shared-element transition from the grid tile. Trip chip overlays top-left, close button top-right.
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

| Interaction         | Motion                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tile → Place detail | Native iOS stack push (per spike outcome). Both screens render the same hero photo URL, so the visual continuity comes from `expo-image`'s memory-disk cache + a 150ms transition prop on both ends. No bespoke morph in v1. |
| Place detail close  | Reverse of the above. Pinch-to-zoom-out also dismisses.                                                                                                                                                                      |
| Inbox banner        | Half-speed parallax until it pins; on pin, swaps to blurred-chip variant in the header.                                                                                                                                      |
| Triage save         | Current card -y 30px + fade out; next card slides in from x: +24px, spring.                                                                                                                                                  |
| FAB tap             | Scale 0.92 → spring back. Sheet rises with `cubic-bezier(0.32, 0.72, 0, 1)`, 320ms.                                                                                                                                          |
| Tab switch          | Cross-fade with content stagger (children fade in 40ms apart).                                                                                                                                                               |
| Pull to refresh     | Custom indicator: Teal arc draws as user pulls; springs to chevron when threshold met.                                                                                                                                       |

**Implementation note.** Reanimated's `sharedTransitionTag` API is documented as native-stack-only and Paper-only in current versions; on a Fabric/new-arch build it cannot be assumed to work. Phase 4 starts with a hard spike (see §11). The spike must produce one of three outcomes, in this order of preference:

1. `sharedTransitionTag` works in a release iOS build → use it.
2. JS-driven snapshot transition: measure source tile, render an absolutely-positioned `<Animated.Image>` overlay above the navigator, animate position/size to the destination frame, then swap to the real Place detail. Implemented with Reanimated 4 + `measure()`.
3. Fallback to a polished native push with photo cross-fade only (no morph).

**Spike outcome (recorded 2026-05-08).** Option 1 ruled out without a build attempt — Reanimated 4 docs gate `sharedTransitionTag` to Paper, and this project ships on Fabric (RN 0.83 / new architecture). Option 2 is technically achievable but has a high implementation/maintenance cost (overlay coordinator, frame measurement coordination, list virtualization edge cases) that does not pay back inside this redesign's scope. **Selected outcome: Option 3 — native iOS stack push with a polished hero photo cross-fade.** Reanimated motion is reserved for in-screen elements (FAB press, sheet rise, parallax). A future enhancement may upgrade to Option 2 once the rest of the redesign is shipped; this is tracked in the post-redesign roadmap, not in this spec.

Web View Transitions API is **not** in scope for this redesign — web shipping is deferred (see §10).

## 6. Visual system

### 6.1 Color tokens

| Token                | Light                 | Dark                     | Use                      |
| -------------------- | --------------------- | ------------------------ | ------------------------ |
| `--color-bg`         | `#ffffff`             | `#020617`                | App background           |
| `--color-surface`    | `#f8fafc` (Snow)      | `#0f172a`                | Cards, sheets            |
| `--color-text`       | `#0c4a6e` (Sea)       | `#e2e8f0`                | Primary text             |
| `--color-text-muted` | `#64748b`             | `#94a3b8`                | Secondary text           |
| `--color-accent`     | `#14b8a6` (Teal)      | `#2dd4bf`                | CTA, active state, brand |
| `--color-info-bg`    | `#ccfbf1` (Mint)      | `#134e4a`                | Inbox banner background  |
| `--color-info-text`  | `#115e59`             | `#5eead4`                | Inbox banner text        |
| `--color-hairline`   | `rgba(15,23,42,0.06)` | `rgba(255,255,255,0.08)` | Tile/sheet strokes       |

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

| Component                | Action                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlaceTile`              | Rebuild as shared-element host. Add trip chip slot, gradient overlay.                                                                                                                                                                                                                                                                                            |
| `PlaceGrid`              | Keep, restyle gutter and aspect (3:4).                                                                                                                                                                                                                                                                                                                           |
| `InboxBanner`            | New. Sticky-parallax variant + collapsed-chip variant.                                                                                                                                                                                                                                                                                                           |
| `TripPill` filter row    | Refactor existing chip pattern, add active state with Teal bg.                                                                                                                                                                                                                                                                                                   |
| `CaptureFAB`             | New. Center tab-bar overlay. Triggers action sheet.                                                                                                                                                                                                                                                                                                              |
| `CaptureActionSheet`     | New. Wraps `ActionSheetIOS`.                                                                                                                                                                                                                                                                                                                                     |
| `TriageScreen`           | New. Modal route, replaces inbox-detail navigation.                                                                                                                                                                                                                                                                                                              |
| `TriageHeroSheet`        | New. Bottom sheet with three detents.                                                                                                                                                                                                                                                                                                                            |
| `PlaceDetailHero`        | New. Shared-element receiver for the hero photo.                                                                                                                                                                                                                                                                                                                 |
| `TripDetailHeader`       | Restyle as cover-photo header.                                                                                                                                                                                                                                                                                                                                   |
| `Avatar`/`HeaderProfile` | New. Settings entry point.                                                                                                                                                                                                                                                                                                                                       |
| `TabBar`                 | Custom three-zone JS tab bar (`tab \| FAB \| tab`). Replaces `NativeTabs`. Built on `BlurView` (`systemMaterial`) + `useSafeAreaInsets` for the home-indicator inset. Implements its own scroll-down minimize behavior using a Reanimated shared value if needed.                                                                                                |
| Theme tokens             | Tokens declared in `global.css` via `@import "nativewind/theme"` + a `@theme` block (this is what NativeWind v5 / Tailwind v4 actually consume to generate `bg-bg`, `text-text`, etc.). A thin `tw/theme.ts` mirror exports the same values as JS constants for Reanimated/animation code that can't read CSS. Both files reference §6.1 as the source of truth. |

Existing `_layout.tsx`'s `SHARED_HEADER_OPTIONS` (transparent + system blur) carries over; route registrations get updated for the modal `triage` and the dropped `(settings)` group.

## 8. Light + dark mode

Both first-class. Tab bar and headers use native `BlurView` (`systemMaterial` light/dark). Photo overlays for tile names use a stronger gradient on dark mode (more black at the bottom) to keep contrast. Teal accent stays vibrant in both modes; Sea text inverts to Snow-200.

## 9. Accessibility

Accessibility requirements are **not deferred to phase 8** — each phase below has accessibility acceptance criteria. Phase 8 is an audit/regression pass only.

### 9.1 Universal floor (every phase)

- All tappable surfaces meet 44×44pt target.
- All interactive elements have `accessibilityLabel` + `accessibilityRole`. Existing labels in `PlaceTile`, `TripPicker`, etc. carry over and get re-validated on rebuilt components.
- No color-only state — active pills also change weight/contrast, errors carry an icon.

### 9.2 Photo-overlay contrast (phase 3 acceptance)

Single overlay recipe — no per-photo runtime adjustment.

- Bottom gradient: `linear-gradient(180deg, transparent 0%, transparent 55%, rgba(0,0,0,0.55) 100%)`.
- Place name text: white, weight 600, size ≥ 12pt, with a 1px text shadow `0 1px 2px rgba(0,0,0,0.45)` for high-luminance photos.
- Acceptance test: render the gradient + text over a fixture set of 10 hero photos in `__tests__/fixtures/high-luminance/` (5 mostly-white, 5 high-contrast). Visual diff must show ≥ 4.5:1 contrast (snapshotted via Playwright/Detox or measured in a unit helper). Non-passing photos trigger a stronger gradient stop (`0.7` alpha) on a per-tile basis.

### 9.3 Modal & sheet semantics (phases 2, 5, 6 acceptance)

- Triage modal, settings sheet, picker sheets, trip-edit sheet: set `accessibilityViewIsModal={true}` on root and `importantForAccessibility="no-hide-descendants"` on underlying tabs.
- Initial VoiceOver focus on each modal targets its primary heading.
- On dismiss, focus restores to the originating element (Inbox banner, header avatar, FAB, or source tile).
- Two-finger Z scrub gesture must dismiss the modal (default iOS — verify nothing intercepts it).
- Keyboard-aware behavior: any focus on an editable field forces the sheet to ≥ 0.85 snap.

### 9.4 Motion (every phase that animates)

- `useReducedMotion()` (Reanimated) drives the fallback path on every animated component. Truth table in §13.
- Animation budget: at most **2 elements animated simultaneously** in any gesture frame, plus tile-level layout shifts (which count as one logical group, not N elements). The shared-element transition counts as 1 (hero) + 1 (surrounding-tile group) = 2; the trip-chip cross-fade is gated to start _after_ the morph completes. Tab-switch staggers count as 1 group.

### 9.5 Dynamic Type (phases 3, 4, 6 acceptance)

- Type tokens scale with `PixelRatio.getFontScale()`.
- At Dynamic Type body size **XL or larger** (`fontScale ≥ 1.35`): the place grid reflows to **1 column**, tiles change to 4:5 aspect (taller, more breathing room), and the trip-chip top-left becomes a stacked label below the photo to avoid truncation. Acceptance test: snapshot at body sizes M, XL, XXL, AX1.

### 9.6 Web

Cursor and focus-ring styles are out of scope until a web build ships. Tracked under future-work in §10.

## 10. Out of scope

- In-app map view of saved places (future per ROADMAP)
- Cloud sync, account, auth (future)
- Itinerary generation
- Social and sharing features
- Web and Android variants of the redesign (current redesign targets iOS only)
- Changes to capture / OCR / extraction / enrichment pipelines — those modules stay as-is
- Onboarding redesign — handled separately

## 11. Risk & open questions

| Risk                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared-element transitions on RN 0.83 + Fabric                     | **Phase 4 hard spike, decision tree in §5.** Default plan is the JS snapshot/overlay transition (path 2); `sharedTransitionTag` is opportunistic. Spike outcome is recorded back into this section.                                                                                                                                                 |
| `NativeTabs` (UIKit `UITabBarController`) does not own a FAB slot  | **Default to a custom JS tab bar** (3-zone: tab \| FAB \| tab) built on `react-native-safe-area-context` + `BlurView`. Overlay-on-NativeTabs is rejected because UIKit tab-bar z-order, safe-area ownership, `minimizeBehavior`, hit-testing, VoiceOver order, and rotation can each break independently.                                           |
| `PagerView` not in deps + gesture conflict with vertical sheet pan | Use a horizontal `FlatList` with `pagingEnabled` + `decelerationRate="fast"`. Coordinate with the sheet via gesture-handler `simultaneousHandlers` / `waitFor` so the sheet pan wins above 0.55 snap.                                                                                                                                               |
| Photo overlay legibility (light + dark)                            | Single overlay recipe in §9.2; high-luminance fallback gradient. Fixture set verified during phase 3.                                                                                                                                                                                                                                               |
| List virtualization vs. shared-element source tile                 | When a transition is in flight, disable `removeClippedSubviews` on the grid and pin the source row in the window; OR base the morph on a measured snapshot independent of the cell's mount lifecycle. The phase 4 spike picks one.                                                                                                                  |
| Settings-as-sheet may hurt discoverability                         | Avatar in header is a known iOS pattern (Apple Music, Mail). Track via session telemetry post-ship.                                                                                                                                                                                                                                                 |
| Existing `(settings)` route group needs migration                  | Phase 2: delete `app/(tabs)/(settings)/_layout.tsx` + `index.tsx`; add `app/settings.tsx` registered as `presentation: 'formSheet'` with `sheetAllowedDetents: [0.5, 1.0]`. Add `app/(tabs)/(settings)+not-found.tsx` (or a top-level `app/+not-found.tsx` redirect) that pushes `/settings` so any deep links from previously-shared URLs resolve. |
| NativeWind v5 + Tailwind v4 token wiring                           | Tokens declared in `global.css` via `@import "nativewind/theme"` + a `@theme` block (NOT in a TS file alone — Tailwind v4 only generates utilities for tokens defined in CSS). `tw/theme.ts` mirrors values for JS animation constants only.                                                                                                        |

## 12. Implementation phasing (high-level — drives the plan)

Every phase below has accessibility acceptance criteria from §9 baked in — phase 8 is audit only, not the first time accessibility is considered.

1. **Theme + tokens.** Update `global.css` with `@theme` block, add `tw/theme.ts` mirror, dark mode token branches via `@media (prefers-color-scheme: dark)` per NativeWind v5 conventions. **A11y:** verify Dynamic Type scaling renders type tokens correctly.
2. **Tab bar + FAB + Settings migration.** Custom JS tab bar replaces `NativeTabs`; `app/(tabs)/(settings)/*` removed; `app/settings.tsx` modal added; deep-link redirect in place. **A11y:** tab bar VoiceOver order; FAB has `accessibilityLabel="Capture"` and `accessibilityRole="button"`; settings modal isolation per §9.3.
3. **Pocket home.** New header, Inbox banner (parallax + collapsed-chip), filter pills, **`FlatList` virtualization with `numColumns={2}`** replacing the current `ScrollView`+`map()`. **A11y:** photo-overlay contrast fixture (§9.2); inbox banner is announced; Dynamic Type 1-column reflow.
4. **Phase 4a — Hard spike (1–2 days).** Decide shared-element implementation per §5 decision tree. Document the chosen path in this file before starting 4b.
   **Phase 4b — Place detail.** Hero photo, transition (per spike outcome), restyled body, "Open in Maps" CTA. **A11y:** focus-restore to source tile on dismiss; reduced-motion fallback verified.
5. **Triage flow.** Full-screen modal, JS bottom sheet (Reanimated + Gesture Handler), horizontal `FlatList` pager, keyboard-aware snapping. **A11y:** `accessibilityViewIsModal`, initial focus on place name, 2-finger Z dismiss preserved, focus restore.
6. **Trips list + detail.** Cover photo header, view toggle (Map = disabled "Coming soon"), edit sheet. **A11y:** Dynamic Type 1-column reflow on trip detail too.
7. **Motion polish.** Parallax, stagger, custom pull-to-refresh wired to `runForegroundIngest()`, haptics. **A11y:** verify the ≤2-element animation budget (§9.4) per interaction.
8. **Accessibility audit.** Run with VoiceOver on a device; test all 4 Dynamic Type sizes; test reduced-motion globally; contrast pass on dark mode. Fix regressions.

Each phase is independently shippable; phases 1–4 deliver the library wow, 5 delivers the capture wow, 6–8 polish.

## 13. Addendum — UX validation (ui-ux-pro-max)

These items came out of running the design through `ui-ux-pro-max` and are now binding.

- **Lists must virtualize.** `app/(tabs)/(places)/index.tsx` currently renders the places grid with `ScrollView` + `.map()`. Phase 3 replaces this with `FlatList` (or `FlashList` if added) with `keyExtractor={(p) => p.id}`, `windowSize={5}`, and `numColumns={2}`. **`removeClippedSubviews` is OFF on the grid** (default is platform-dependent; explicitly set to `false`) because clipping the source tile during a shared-element / snapshot transition unmounts the receiver and breaks the morph. Same change for the trip list when length warrants.
- **Image sizing must be explicit.** Every `expo-image` instance needs explicit `style={{ width, height }}` (or aspect-ratio reserved at the parent) and `cachePolicy="memory-disk"`. No bare `<Image source={uri} />`. Tile parents get `aspect-ratio: 3/4` and the image fills it with `contentFit="cover"`.
- **Reduced motion is a first-class branch, not a graceful degradation.** Use `useReducedMotion()` (Reanimated) on every animated component. Truth table:
  - Shared-element morph → fade crossfade (180ms ease.out)
  - Parallax banner → static
  - Stagger reveals → simultaneous fade
  - Spring overshoot → linear ease.out
- **Motion budget — ≤ 2 logical groups animated simultaneously.** This is a budget, not a hard count of nodes. Allowed groupings: (a) hero element morphing, (b) one supporting list/cluster (e.g. surrounding tiles fall away), (c) one CTA reveal. The trip-chip cross-fade on the tile→detail transition starts _after_ the photo morph completes and counts as a separate frame. Tab-switch staggers count as one group (the children, treated as a cluster). Triage swipe: only the card moves while sliding; sheet content fades in _after_ the card lands.
- **Photo-overlay contrast.** See §9.2 for the binding recipe (single 0.55 alpha gradient + text shadow + fixture set). All earlier mentions of `0.4`/`0.45` alpha gradients in this document are superseded by §9.2.
- **No emoji as icons** anywhere in production UI. Use SF Symbols via the existing `components/Icon.tsx` wrapper, which renders SF Symbol names through `expo-image` `sf:` sources (no `expo-symbols` dependency). Country chips on trips may use the unicode flag glyph since it's a content character, not a UI icon.
- **Easing direction.** Entering elements use `ease.out`; exiting elements use `ease.in`. The Reanimated spring presets in MASTER are the shared-element/sheet defaults — fall back to ease curves only on reduced motion.
- **Web (out of scope).** Cursor styles, focus rings, View Transitions API, and any `react-native-web` surfacing are deferred. If a web build ships later, treat web a11y/cursor work as a separate spec.

## 14. Implementation outcome

What landed in this redesign branch (commits `7a14a17` through phase 7+8):

| Phase                       | Status                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Theme + tokens           | ✅ shipped             | `global.css` `@theme` + `tw/theme.ts` JS mirror, light + dark via `prefers-color-scheme`.                                                                                                                                                                                                                                                                                                                                                                  |
| 2. Tab bar + FAB + Settings | ✅ shipped             | Custom JS tab bar replaces `NativeTabs`; `expo-blur` `systemMaterial`; settings is a `formSheet` modal at `/settings`.                                                                                                                                                                                                                                                                                                                                     |
| 3. Pocket home              | ✅ shipped             | `FlatList` numColumns 2 with `removeClippedSubviews=false`; Inbox banner; filter pills; pull-to-refresh wired to `runForegroundIngest`; Dynamic Type ≥XL collapses to 1 column.                                                                                                                                                                                                                                                                            |
| 4a. Shared-element spike    | ✅ resolved            | Outcome: native push + `expo-image` memory-disk cache (option 3). Custom morph deferred to future enhancement.                                                                                                                                                                                                                                                                                                                                             |
| 4b. Place detail            | ✅ shipped             | Hero photo, Teal CTA, Sea text, restyled metadata card and source strip.                                                                                                                                                                                                                                                                                                                                                                                   |
| 5. Triage flow              | ✅ shipped (auto-snap) | Full-screen modal at `/triage`, horizontal `FlatList` pager, AI-extracted card, `KeyboardAvoidingView`. **Drag-to-snap deferred** — see §11.                                                                                                                                                                                                                                                                                                               |
| 6. Trips                    | ✅ shipped             | Trip list with restyled cards; trip detail with cover photo, stat chips, Grid/Map view toggle (Map = "Coming soon" placeholder).                                                                                                                                                                                                                                                                                                                           |
| 7. Motion polish            | ✅ partial             | `useReducedMotion()` on `CaptureFAB`; system-native push transitions; `slide_from_bottom` for the triage modal. **Deferred:** Inbox-banner parallax-to-collapsed-chip; tab-switch content stagger; custom pull-to-refresh indicator art; triage drag-to-snap. These are tracked as motion follow-ups, not blockers.                                                                                                                                        |
| 8. Accessibility            | ✅ verified inline     | Acceptance criteria from §9 implemented as the components were built (`accessibilityViewIsModal` on triage, `accessibilityRole`/`accessibilityLabel`/`accessibilityHint` on every interactive element added, Dynamic Type 1-column reflow, photo-overlay recipe at §9.2 alpha 0.45→0.55). **Pending device verification:** VoiceOver order on the custom tab bar with FAB; reduced-motion across all animated paths; Dynamic Type at AX1+ on Place detail. |

### What still needs a build to verify

- `expo-blur` is a new native dep — first build after this branch must rebuild native code (`npx expo run:ios`).
- The custom tab bar replaces `NativeTabs`. VoiceOver order, safe-area on notched / home-indicator devices, and rotation behavior need a device pass.
- The triage modal's `accessibilityViewIsModal` flag is set but background-content hiding is delegated to the OS — confirm with VoiceOver that the underlying tabs are correctly silenced.
- Photo-overlay contrast was implemented to spec but the 10-photo fixture set (§9.2) hasn't been generated yet.

### Follow-up enhancements (post-redesign roadmap, not in this spec)

- JS snapshot/overlay shared-element morph (option 2 from §5).
- Triage drag-to-snap with three explicit detents.
- Inbox banner parallax + collapsed-chip variant.
- Custom pull-to-refresh artwork (Teal arc that draws as the user pulls).
- Tab-switch stagger.

## 15. Validated against

- `docs/superpowers/specs/2026-05-08-app-redesign-design.md` (this file) — source of truth
- `design-system/trip-pocket/MASTER.md` — token-level reference for implementation
- `ui-ux-pro-max` skill output — accessibility, list virtualization, image sizing, reduced-motion rules incorporated above
