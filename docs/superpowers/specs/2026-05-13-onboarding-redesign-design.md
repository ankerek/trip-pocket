# Onboarding redesign — design

**Status:** approved (2026-05-13) · ready for implementation plan
**Replaces:** the 12-screen onboarding flow scaffolded in `app/onboarding/` over the preceding session. Memory record at `memory/onboarding_implementation.md` captures the prior shape.

## Why

The first-pass onboarding leaned on patterns from generation-style apps (Noom, Calm) that don't fit Trip Pocket. Three specific frictions surfaced:

1. **The demo lied about the product.** Users swiped through curated "starter trip" cards, which implied Trip Pocket _generates_ travel content. The app's actual job is the opposite — it catches and organizes what the user already screenshots from social media. A demo that hands the user content sets the wrong expectation before the paywall.
2. **Mid-flow screens duplicated each other.** Pain Points (multi-select) and Tinder ("Tap if this is you") asked the same self-identification question in two forms. The flow read as two consecutive therapy beats.
3. **A photos permission primer ran during the modal.** Photos is a soft permission — the share sheet works without it, and the only in-app surface that needs it ("Add from Photos" empty-state CTA) can prime it in context. Asking during onboarding spends a permission grant before the user has felt the value.

Additional small drift: Preferences (category grid) and the "Building your starter trip…" processing beat existed only to feed the now-removed swipe-pick demo. Social proof leaned on placeholder testimonials, which on a brand-new app reads as filler.

## Scope

In scope:

- Collapse the 12-screen flow to 6 screens.
- Rewrite the demo screen as a tap-to-transform showcase with two examples: one multi-place extraction from a screenshot, one IG-share-sheet path with a real user tap on the trip picker.
- Personalize the paywall headline by destination, and remove the placeholder testimonial slot from the paywall.
- Refresh the Destination sub-copy.
- Delete six obsolete screen files and the demo-seed library.
- Trim `OnboardingAnswers` to the single field the new flow still persists (`destination`).

Not in scope:

- StoreKit / RevenueCat / `expo-iap` wiring on the paywall — still a TODO from the prior implementation; the paywall remains a placeholder that flips `markOnboardingComplete()` on either CTA.
- Real photo-library integration during onboarding. The "Add from Photos" CTA on the empty-state in `(tabs)/(places)/index.tsx` already primes photos in context.
- Any change to `app/_layout.tsx` first-launch gate, `lib/onboarding/storage.ts`, or the Settings "Replay onboarding" button — all stay as-is.
- Animation polish beyond what's specified below (no shared-element morphs, no reduced-motion variants beyond Reanimated's defaults).
- Re-introducing social proof or any share/viral hook from the demo or value-delivery screen — both intentionally dropped. See Risks for the rationale.

## Final flow

Six screens. Welcome and Paywall don't show a progress bar; the four middle screens do, with a denominator of 4.

```
1. Welcome           (no progress)
2. Destination       step 1 / 4   single-select
3. Pain Points       step 2 / 4   multi-select
4. Solution          step 3 / 4   mirrored pain → app capability
5. Demo              step 4 / 4   tap-to-transform, 2 examples
6. Paywall           (no progress) destination-personalized headline
```

Files and routes:

| #   | Route                     | File                             | Status                   |
| --- | ------------------------- | -------------------------------- | ------------------------ |
| 1   | `/onboarding`             | `app/onboarding/index.tsx`       | unchanged                |
| 2   | `/onboarding/destination` | `app/onboarding/destination.tsx` | minor copy change        |
| 3   | `/onboarding/pain-points` | `app/onboarding/pain-points.tsx` | next-screen link change  |
| 4   | `/onboarding/solution`    | `app/onboarding/solution.tsx`    | next-screen link change  |
| 5   | `/onboarding/demo`        | `app/onboarding/demo.tsx`        | full rewrite             |
| 6   | `/onboarding/paywall`     | `app/onboarding/paywall.tsx`     | headline personalization |

## Per-screen specs

### Screen 1 — Welcome (unchanged)

No changes from current. Headline, sub, preview tiles, "Get started" CTA stay as implemented.

### Screen 2 — Destination

Sub copy refresh, headline kept:

- Headline: **"What trip are you collecting ideas for?"** (unchanged from prior implementation; concrete + curator-voice — aligns with MARKETING.md §2)
- Sub: **"One quick question — we'll personalize the rest."** (was: "We'll tailor your starter trip around it." which referenced the deleted starter-trip mechanic)
- Same 7 single-select options, same SF Symbols, same data field (`destination`)
- Same "Continue" CTA, same disabled-until-pick behaviour
- Next screen: `/onboarding/pain-points` (unchanged)

### Screen 3 — Pain Points

No content change. Two wiring changes:

- "Continue" CTA navigates to **`/onboarding/solution`** instead of `/onboarding/social-proof`
- The selected pain points are now **component-local state only** — no `set('painPoints', …)` call into `useOnboarding`. See the State + storage section for the rationale.

### Screen 4 — Solution

No content change. One wiring change:

- "Continue" CTA navigates to **`/onboarding/demo`** instead of `/onboarding/preferences`

### Screen 5 — Demo (full rewrite)

The novel piece. Specced in detail in the next section.

### Screen 6 — Paywall

Two content changes: the headline becomes destination-aware, and the placeholder testimonial section is removed.

**Destination-aware headline.** Hand-written lookup keyed by `destination` — `DESTINATION_LABEL` alone produces awkward strings ("Your US road trip trip starts here.", "Your city break trip starts here."), so the paywall uses its own explicit map:

```ts
const PAYWALL_HEADLINE: Record<Destination | 'fallback', string> = {
  japan: 'Your Japan trip starts here.',
  sea: 'Your Southeast Asia trip starts here.',
  europe: 'Your Europe trip starts here.',
  'us-roadtrip': 'Your US road trip starts here.',
  'city-break': 'Your city break starts here.',
  'bucket-list': 'Your bucket list starts here.',
  general: 'Your next trip starts here.',
  fallback: 'Your next trip starts here.', // destination === null, e.g. user replayed and skipped
};
```

Each value is hand-written, not derived — every read should be a clean English sentence.

**Testimonial removed.** The single placeholder review (5-star + Maya quote) gets deleted from the paywall layout. Rationale: we already dropped Social Proof on the grounds that placeholder testimonials read as filler on a pre-launch app; keeping a placeholder on the paywall would re-introduce that inconsistency. The slot is removed entirely — no replacement stat-card, no aspirational quote. Quieter, more confident, and one fewer thing to swap before App Store submission.

Post-change paywall structure: app lockup → headline → sub → plan selector → primary CTA → fine print → restore/terms/privacy row. No social-proof slot.

Sub, plan selector, primary CTA ("Start your 7-day free trial"), fine print, and footer links unchanged. `handleStartTrial` and `handleRestore` behaviour unchanged — both call `markOnboardingComplete()` and `router.replace('/(tabs)/(places)')`. The StoreKit wiring TODO stays.

## Demo screen — detailed design

The screen is one driver (`app/onboarding/demo.tsx`) running a 2-step sequence. The step counter at the top reads `1 / 2 · From a screenshot` then updates to `2 / 2 · From a share`.

### Layout (both examples)

Uses `OnboardingScaffold` with `step={4}`, `scroll={false}`. From top to bottom inside the body:

- Step pill (small, top-center): `1 / 2 · FROM A SCREENSHOT` (uppercase, 11pt, 0.4 letter-spacing, slate-500).
- Headline: **"Watch it work."**
- Sub: **"Two ways places land in Trip Pocket."**
- Transformation stage (the body of the screen, flexes between the headline area and the CTA).
- Primary CTA at the bottom (in the scaffold footer slot) — label changes by state, see below.

### Example 1 — "From a screenshot" (multi-place extraction)

**Before state.** A tilted (~−4°) faux-IG-list-post card, drop-shadowed so it reads as "this is a screenshot, not the live UI." Composed of regular RN views, not images, except for the hero photo:

- Header strip: small avatar circle (initial "T") + `@tokyo.eats` handle (semibold, 13pt) + a horizontal-dots `ellipsis` SF Symbol.
- Hero photo: 280pt-tall square, `expo-image`, Unsplash CDN URL for a Shibuya street/ramen shot.
- Title overlay (white text on a soft scrim): **"TOP 3 RAMEN IN SHIBUYA"** (uppercase, 18pt, 800).
- Below the photo, a small caption block with three numbered lines:
  ```
  1. Maru Tonkatsu — Shibuya
  2. Ichiran — Shibuya
  3. Afuri Ramen — Shibuya
  ```
- IG-style interaction row at the bottom: `heart`, `bubble.right`, `paperplane`, `bookmark` SF Symbols at 16pt, slate-700.

A faint accent-coloured ring pulses around the whole tilted card to invite the tap. Pulse is a Reanimated `withRepeat(withTiming, -1, true)` on opacity 0.3 → 0.6 (1s period). Suppress under `useReducedMotion()`.

**Footer CTA before tap:** `See it extract` (primary, full-width).

**On tap → transformation choreography (~1.4s total):**

1. (0–300ms) Tilted card scales down to 95% and fades to 70% opacity; the pulse stops.
2. (300–1000ms) A centred `sparkles` SF Symbol fades in at 28pt, accent-tinted, with a `withRepeat` rotation. Below it, caption text fades in: **"Extracting 3 places…"**.
3. (1000–1400ms) Tilted card and sparkles fade out; three `DemoPlaceCard` rows slide in vertically with a 100ms stagger.

**After state.** A short header above the three cards:

- `checkmark.seal.fill` icon (accent) + **"3 places found"** (15pt, semibold)

Then three vertically-stacked `DemoPlaceCard` rows:

- Maru Tonkatsu · Shibuya · Food
- Ichiran · Shibuya · Food
- Afuri Ramen · Shibuya · Food

`DemoPlaceCard` is a _row_-shaped card (full width, 64pt tall), not the 3:4 tile. It uses the same visual recipe as `components/PlaceRow.tsx` (which already exists) — round 44pt photo on the left, name + city + category dot-separated to the right. Photos come from Unsplash.

**Footer CTA after reveal:** `Next: from a share` (primary).

**Tap → load example 2.** All transient state for example 1 resets (cards fade out, then example 2's before-state mounts).

### Example 2 — "From a share" (IG/TikTok share-sheet path)

**Before state.** A faux _live IG screen_ — not a tilted screenshot, but full-bleed-looking, framed to read as "the IG app, in your hand right now." Same component tree as example 1's mock minus the tilt + shadow:

- Header strip (same shape as Ex 1 but with `@kyoto.found` handle)
- Hero photo: Fushimi Inari torii gates, Unsplash CDN
- Caption: small "Vermilion morning before the crowds. Kyoto, 6:30am." in regular weight under the photo
- Interaction row at the bottom, but the `paperplane` (share) icon is highlighted: 22pt instead of 16pt, accent-tinted, with a `withRepeat` opacity pulse 0.5 → 1.0.

**Footer CTA before tap:** `Tap the share button` (secondary text style, no button — the share icon itself is the tap target). Below it, very small kicker text: "or tap anywhere on the card".

**Three real taps drive the rest of the example.** None of them are timer-scripted — each transition only happens when the user taps the highlighted target. This mirrors the real iOS share-extension flow honestly: tap share, tap Trip Pocket, tap trip.

**Tap 1 — share icon.** Share icon registers tap → faux iOS share-sheet rises (~340ms) from the bottom ~50% of the IG card. Background is an `expo-blur` `BlurView` (`tint='systemMaterial'`, `intensity={75}`) with rounded top corners, containing a row of three app icons:

- Left and right: decorative placeholders — flat coloured squares with `square.grid.2x2` (label "Messages") and `envelope` (label "Mail") SF Symbols. They aren't real share targets, just neutral filler so the row reads as a real share sheet.
- Centre: the **Trip Pocket icon** — a rounded gradient square with the `tray.full.fill` SF Symbol and a soft accent shadow. Pulses (opacity + small scale) while awaiting tap. Below the row: "Tap Trip Pocket to save this post."

**Tap 2 — Trip Pocket icon.** TP icon registers tap → share-sheet slides down (~340ms) while the trip-picker rises in the same slot from below (also ~340ms, simultaneous cross-pass). Trip-picker layout: header **"Save to"** + two pills:

- **`Japan`** — filled, accent-outlined, opacity pulse while awaiting tap.
- **`+ New trip`** — outlined, dimmed at 60% opacity, `onPress: undefined`. We don't fake the create-new-trip sub-flow inside onboarding; users will see the real one post-paywall.

Below the pills: "Tap Japan to save."

**Tap 3 — Japan pill.** Pill registers tap (haptic) → trip-picker fades out and the IG card stack fades out together (~380ms) as the reveal slides in.

**After state.** Header above the result:

- `checkmark.seal.fill` icon (accent) + **"Saved to Japan"** (15pt, semibold)

Then a single `DemoPlaceCard` row:

- Fushimi Inari Taisha · Kyoto · Place

**Footer CTA after reveal:** `Continue` (primary) → navigates to `/onboarding/paywall`.

The `+ New trip` pill is **non-interactive** — tapping it does nothing in the demo. We don't fake the "create a new trip" sub-flow here; the user will see the real one post-paywall. A subtle accessibility note: the pill has `accessibilityHint="Only used inside the app after the trial starts."` so a screen-reader user understands why it's inert.

### State machine

```
idle1         → user taps "See it extract"
extracting1   → 1.4s timer runs
revealed1     → footer CTA = "Next: from a share" → user taps → idle2
idle2         → user taps share icon
shareSheet2   → user taps Trip Pocket icon
waitingPick   → user taps Japan pill
revealed2     → footer CTA = "Continue" → paywall
```

Implementation: a single `useState<Phase>` enum drives the screen. Only `extracting1 → revealed1` is timer-driven (1.4s `setTimeout`). Every other transition fires from a Pressable's `onPress`. Phase transitions for example 2 trigger visual animations inside `DemoSharePathMockup` via the `phase` prop — share-sheet and trip-picker slide on/off via Reanimated `withTiming` whenever the parent phase changes.

**Why timers and not Reanimated callbacks.** Reanimated `withTiming(value, opts, callback)` does not reliably fire its completion callback in our RN 0.83 + Reanimated 4.2.1 setup. We learned this the hard way on the prior demo implementation — the screen got stuck after the first card swipe because the callback never JS-thread-bridged. Reanimated shared values still drive the _visual_ animations (opacity, transform), but state advancement is timer-based. This lesson is captured in `memory/onboarding_implementation.md` and the patched-out callback path is documented inline in the prior `demo.tsx` comments.

### Back navigation per phase

| Phase         | Back chevron | Behaviour on press                         |
| ------------- | ------------ | ------------------------------------------ |
| `idle1`       | visible      | `router.back()` → Solution                 |
| `extracting1` | hidden       | n/a (no in-flight escape)                  |
| `revealed1`   | visible      | `router.back()` → Solution                 |
| `idle2`       | visible      | `router.back()` → Solution                 |
| `shareSheet2` | visible      | `router.back()` → Solution                 |
| `waitingPick` | visible      | `router.back()` → Solution                 |
| `revealed2`   | hidden       | the user is "done"; only Continue advances |

Rationale: hiding the chevron only during `extracting1` (timer-driven) and `revealed2` (terminal) — all the user-driven share-flow phases stay backable since their animations are simple slides that don't leak state when interrupted by unmount.

### App backgrounding mid-timeline

`setTimeout` IDs are not cleared on background. iOS will pause JS-thread execution on background; on foreground, any timer past its deadline fires immediately. Practical behaviour: a user who backgrounds during `extracting1` returns to the app and the phase advances to `revealed1` instantly. The visual jump is acceptable for the only timer-driven beat (1.4s) we have.

No special handling. Do not introduce `AppState` listeners or pause-resume logic for the demo — the cost outweighs the win for a single short timer.

`useEffect` cleanup clears any pending timer when the screen unmounts (e.g. back-nav from `idle1` → Solution), so a user who exits mid-`extracting1` and re-enters doesn't see a stale timer fire on the new mount.

### No skip-demo button

The demo is short (≤6s of attention to see both reveals if a user taps through quickly) and is the only screen that explains the product before the paywall. The Continue CTA from the final reveal is the only forward exit; the back chevron is the only backward exit.

### Accessibility

- The faux-screenshot card on Ex 1 has `accessibilityRole="button"`, `accessibilityLabel="Demo screenshot of a list of 3 ramen spots."`, `accessibilityHint="Extracts the places from the screenshot."`. The entire card is the tap target. _(Don't write "double-tap to..." in labels — VoiceOver appends the activation gesture automatically; including it in the label produces "double tap to double-tap to..." duplication.)_
- The faux-IG-live card on Ex 2 has `accessibilityRole="button"`, `accessibilityLabel="Demo Instagram post for Fushimi Inari, Kyoto."`, `accessibilityHint="Opens the share sheet."`.
- The pulsing Japan pill in `waitingPick` is its own `accessibilityRole="button"`, `accessibilityLabel="Save to Japan"`, `accessibilityHint="Saves the place to your Japan trip."`.
- The share-sheet sheet and the inert `+ New trip` pill are decorative within the choreography — set `accessibilityElementsHidden={true}` and `importantForAccessibility="no-hide-descendants"` on the share-sheet container. The `+ New trip` pill stays focusable with the hint noted above, but its `onPress` is a no-op.
- Progress pill at the top is annotated with `accessibilityRole="text"` + the literal step label.
- Reduce-motion respected: opacity-pulse rings, rotating sparkles, and pill pulses fall back to static visuals; the timeline still advances on the same `setTimeout` schedule.

### Demo fixtures

A new `lib/onboarding/demoFixtures.ts` exports the two static fixtures. Shape:

```ts
export type DemoScreenshotFixture = {
  handle: string; // e.g. '@tokyo.eats'
  heroImageUrl: string; // Unsplash CDN
  titleOverlay: string; // 'TOP 3 RAMEN IN SHIBUYA'
  captionLines: string[]; // ['1. Maru Tonkatsu — Shibuya', ...]
  reveals: DemoPlaceFixture[]; // 3 entries for Example 1
};

export type DemoShareFixture = {
  handle: string; // e.g. '@kyoto.found'
  heroImageUrl: string;
  caption: string;
  tripPickerLabel: string; // 'Japan' — also shows in the post-reveal header
  reveal: DemoPlaceFixture; // 1 entry for Example 2
};

export type DemoPlaceFixture = {
  name: string;
  city: string;
  category: 'food' | 'place' | 'activity';
  photoUrl: string; // Unsplash CDN
};

export const DEMO_SCREENSHOT: DemoScreenshotFixture;
export const DEMO_SHARE: DemoShareFixture;
```

These are intentionally separate types from the prior `DemoPlacePick` — the new flow doesn't share state with the deleted swipe-pick demo, and merging the types would force the user-pick fields onto a shape that no longer needs them.

## State + storage changes

`lib/onboarding/state.tsx`:

Reduce `OnboardingAnswers` to a single field:

```ts
export type OnboardingAnswers = {
  destination: Destination | null;
};
```

`painPoints` becomes **ephemeral component state** inside `pain-points.tsx` — no persistence. Rationale: the Solution screen renders four fixed pain/solution rows regardless of which pain points the user picked, and no analytics SDK consumes the answer. Persisting it is dead state.

Delete:

- `Category` type and its label-mapping
- `DemoPlacePick` type (moves out to `demoFixtures.ts` as `DemoPlaceFixture`, see above)
- `agreedPains`, `categories`, `photosPrimed`, `starterPlaces`, `painPoints` fields from `OnboardingAnswers`
- The matching keys in `EMPTY_ANSWERS`

`DESTINATION_LABEL` is no longer used by the paywall (paywall has its own hand-written headline map, see Screen 6 above). It remains exported because `lib/onboarding/state.tsx` is the canonical home for destination metadata; remove if no consumer is left after refactor.

**`loadInitial` migration safety.** The current `loadInitial` uses spread (`{ ...EMPTY_ANSWERS, ...parsed }`), which **does not** drop unknown keys — it carries them into the runtime object even when the TypeScript type doesn't include them. For the trimmed answer set, replace with explicit key extraction so old v1 payloads (containing `categories`, `painPoints`, etc.) are not silently smuggled into v2's in-memory state:

```ts
function loadInitial(): OnboardingAnswers {
  try {
    const raw = readOnboardingAnswers();
    if (!raw) return EMPTY_ANSWERS;
    const parsed = JSON.parse(raw) as Partial<OnboardingAnswers>;
    return {
      destination: parsed.destination ?? null,
    };
  } catch {
    return EMPTY_ANSWERS;
  }
}
```

`lib/onboarding/storage.ts`: unchanged.

## Deletions

Files removed wholesale:

- `app/onboarding/social-proof.tsx`
- `app/onboarding/tinder.tsx`
- `app/onboarding/preferences.tsx`
- `app/onboarding/photos.tsx`
- `app/onboarding/processing.tsx`
- `app/onboarding/value.tsx`
- `lib/onboarding/demoPlaces.ts`

No `_layout.tsx` change: expo-router auto-discovers routes from filesystem, so the deletions remove the routes.

## New files

- `lib/onboarding/demoFixtures.ts` — shape above.
- `components/onboarding/DemoScreenshotMockup.tsx` — renders the tilted faux-IG-list-post card with its hover-pulse. Props: `fixture: DemoScreenshotFixture`, `pulsing: boolean`.
- `components/onboarding/DemoSharePathMockup.tsx` — renders the live-IG card, plus the share-sheet and trip-picker overlays during the timeline. Props: `fixture: DemoShareFixture`, `phase: 'idle' | 'sheet' | 'picker' | 'fading'`, `onJapanPick: () => void` (only fires from the `picker` phase; ignored in other phases).
- `components/onboarding/DemoPlaceCard.tsx` — row-shaped reveal card. Props: `name`, `city`, `category`, `photoUrl`. Visual recipe matches `components/PlaceRow.tsx` (already exists in the codebase) but doesn't take a DB row — pure presentational.

The mockup components are demo-only. They live under `components/onboarding/` rather than `components/` to keep them out of the general-purpose component surface and to make their disposability obvious.

## Risks and trade-offs

- **The share-sheet mockup is illustrative, not interactive.** Users who try to long-press or otherwise interact with the faux share-sheet (other than the Japan pill) won't get a system response. Mitigation: the only mid-choreography pause is on the Japan pill itself; everything else is short auto-advance.
- **Three Unsplash images per session.** First-launch is offline-tolerant for the rest of the app, but the demo will show blank placeholders if the user is offline. Acceptable: onboarding is typically first-time-online; if offline, the rest of the app's empty state still onboards them once connectivity returns.
- **Multi-place reveal for example 1 sets an expectation that single-screenshot posts can yield 3 places.** True today (the extractor and OCR already support multi-place results) but a user whose first real screenshot extracts only one place might feel under-served. Mitigation: the post-paywall in-app behaviour shows however many places extraction finds, so any subsequent screenshot that yields fewer is consistent with the actual product, not a demo bait-and-switch.
- **No real network call in the demo.** The "Extracting…" caption implies AI work that isn't happening. Acceptable: the AI work _is_ the thing the user is paying for; this is a marketing fiction, not a functional one. Both fixtures are real places the app would extract correctly given the real input.
- **No social proof and no value-delivery "viral moment."** Explicit choice: the prior flow had three placeholder testimonials and a "Share my trip" button on a value-delivery screen. Both are gone. Pre-launch placeholder testimonials read as filler; the value-delivery screen shared canned content as if the user had made it. This redesign trades a (small) growth-loop opportunity for honest framing. If a real review or organic-share mechanic emerges post-launch, both can be re-introduced as their own changes.

## Out-of-band TODOs (open after this redesign)

These survive the redesign and are explicitly out of scope here:

1. Wire StoreKit / RevenueCat / `expo-iap` in `paywall.tsx`. Both `handleStartTrial` and `handleRestore` currently stub success by calling `markOnboardingComplete()` and navigating to `/(tabs)/(places)`.

Net change vs. the prior implementation: the placeholder-testimonial replacement TODO drops off the list — this redesign removes the testimonial slot entirely, so there's no placeholder left to replace.
