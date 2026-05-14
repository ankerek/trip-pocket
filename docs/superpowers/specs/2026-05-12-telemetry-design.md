# Telemetry — design

**Status:** draft (2026-05-12) · awaiting review before implementation plan
**Touches:** `package.json` (deps), `app.config.ts` (env wiring + PostHog plugin if needed), new `modules/telemetry/*`, surgical `track(...)` call sites across `modules/capture`, `modules/processing`, `modules/extraction`, `modules/enrichment`, `app/triage.tsx`, `app/sources/*`, `app/trips/*`, `app/settings.tsx`, and the (future) paywall. Existing `lib/observability/*` keeps its current shape; Sentry config gains `tracesSampleRate: 0.1` in production.
**Milestone:** v0.4 — product-loop instrumentation (precedes paywall + TestFlight rollout decisions).

## Why

Today the app is observable for _failures_ — Sentry catches crashes and the pipeline breadcrumbs trace where a failure happened (`lib/observability/breadcrumbs.ts`). It is not observable for _success or use_. We can't answer: "how many testers got past first import?", "which paywall trigger converts?", "do people use triage or assign trips manually?", "is OCR latency a problem in the wild?". Without these answers, every product decision from v0.4 → v1.0 is a guess.

`docs/ARCHITECTURE.md` already commits to **PostHog for product events, Sentry for crashes**, wrapped by a `modules/telemetry/` module that doesn't exist yet. This sub-project builds that module and wires the minimum event vocabulary that makes the activation funnel and pipeline health legible. It also turns on a small slice of Sentry performance tracing so latency questions don't require a one-off instrumentation pass later.

Scope is "everything we need to read the funnel and the pipeline; nothing speculative." Feature flags are wired in transit (the SDK supports them, the cost of leaving them off is higher than the cost of leaving them on), but no flags are defined here. Experiments come when the first real A/B question shows up.

## Scope

In scope:

- `posthog-react-native` SDK added, initialized in `app/_layout.tsx` after Sentry, gated on `!__DEV__`. EU cloud (`eu.posthog.com`).
- `modules/telemetry/` with a typed event vocabulary, a thin `track()` wrapper, a consent helper, and a re-export of Sentry's error capture so the rest of the codebase has **one** telemetry surface.
- The event vocabulary defined in this spec — ~30 events across lifecycle, capture, pipeline, organization, triage, discovery, monetization, onboarding, settings. All properties are enums or bucketed numbers; no free text, no IDs.
- Consent toggle in `app/settings.tsx` ("Help improve Trip Pocket"), persisted in the `meta` table, default **on**. No first-launch prompt (justification below).
- Distinct ID = existing `install_id` (the UUID already used as Sentry `user.id`). Joins PostHog and Sentry to the same anonymous identity.
- Sentry `tracesSampleRate: 0.1` in production, with explicit `startSpan` wrapping for OCR, extraction, and enrichment — the three slow operations.
- PostHog SDK initialized with feature-flag fetching enabled (default behavior). No flags consumed in this milestone; helper hook (`useFlag`) deferred to the first real use.

Not in scope (each may become its own sub-project):

- Session replay. PostHog supports it on RN, but it's a different privacy posture (records screen content) and we don't need it yet.
- Marketing-site analytics (Umami/Plausible). Separate concern that activates when the site exists.
- Custom dashboards / Slack alerts on PostHog. The PostHog UI is enough for the beta.
- Per-event sampling. 100% events at v0.4 volume is cheap.
- Server-side event ingestion via the Cloudflare extraction proxy. The Worker doesn't see enough events to justify; client-side is fine.
- Cohort experiments, holdout groups, multi-variate testing.
- App Store Connect Analytics integration — it runs by itself, costs nothing, no SDK; we treat it as a free secondary signal but write no code for it.
- Android. iOS-first until v1.x.

## Decisions

**Vendor: PostHog EU cloud.** Already specced in `ARCHITECTURE.md`. EU residency keeps the GDPR story simple. Free tier (1M events / month) is roughly 1000× our v1.0 volume. RN SDK is mature, supports feature flags, supports session replay (off by default — kept off), supports cohorts and funnels in the dashboard with no extra work. Alternatives rejected: Amplitude/Mixpanel cost more and don't buy us anything PostHog doesn't; a custom Cloudflare-Worker event sink would have us building funnels and retention from scratch. We can revisit if PostHog volume ever crosses the paid tier.

**Sentry stays the crash + error surface.** No change to `lib/observability/sentry.ts` except adding `tracesSampleRate: 0.1`. Errors do **not** flow into PostHog. The mental split is: PostHog = "what users do" (intentional events); Sentry = "what went wrong" (crashes, captured exceptions, slow transactions). They share `install_id` as the join key, so a Sentry event can be cross-referenced to a PostHog user's recent events when needed.

**Consent model: opt-out, default on, Settings toggle, no first-launch prompt.** The toggle lives at `Settings → Privacy → Help improve Trip Pocket`, on by default, with one sentence of copy ("Sends anonymous usage events. No content from your screenshots, trips, or searches is ever included."). Three things make this defensible:

1. No PII, no IDFA, no advertising ID, no IP (PostHog's geo-IP capture is disabled at init, and `$ip` is stripped per-event in the event-preprocess hook — see Privacy stance below).
2. No content — events carry enum properties and bucketed numbers only. The event vocabulary in the next section is exhaustive; nothing else ships.
3. EU data residency.

Under these constraints, ATT does not fire (no cross-app tracking, no advertising identifier) and GDPR legitimate-interest covers structural product analytics. A first-launch consent prompt would add friction without buying us a meaningfully better privacy posture. Re-evaluate if Apple review or a user pushes back; the toggle is the kill switch and the code path through the toggle already exists.

**Event vocabulary lives in one typed file.** `modules/telemetry/events.ts` exports a discriminated union of every event. The `track()` function accepts only that union — call sites that drift (typo, wrong props, ad-hoc string) fail at compile time. This is the same shape ARCHITECTURE.md asked for ("no ad-hoc `track("button_clicked")` calls strewn around").

**Properties are enums and buckets, never raw.** Latencies are bucketed into a small ladder (`<100ms | <500ms | <2s | <10s | ≥10s`). Counts are bucketed (`0 | 1 | 2-3 | 4-10 | 10+`). Every other property is a string enum from a closed set. No screenshot IDs, place IDs, trip IDs, URLs, OCR text, place names, captions, or search queries appear anywhere — not even hashed. The bucketing protects against future drift: if someone wires up a raw `place_count` and we ship to a million users, that's a million unique values in PostHog and a privacy hole; bucketing collapses both problems.

**Distinct ID = `install_id`.** `lib/observability/install-id.ts` already produces a UUID stored in the `meta` table and used as Sentry's `user.id`. PostHog gets the same value via `posthog.identify(installId)` once on init. Same human → same UUID → joinable across the two systems. Reinstall produces a new UUID, which is correct ("install instance", not "human") and consistent with how Sentry treats it. No `posthog.alias` calls (would imply we ever know a real identity, which we don't).

**Sentry perf traces at 10% sample, explicit spans on slow ops.** `tracesSampleRate: 0.1` in production. Plus three explicit `Sentry.startSpan` wrappers around `modules/processing` (OCR), `modules/extraction` (proxy call + parse), `modules/enrichment` (enrichment call). Each span carries a `pipeline_stage` tag matching the existing breadcrumb category, so Sentry's Performance tab and breadcrumb trail line up. 10% is enough to spot a p95 regression without burning Sentry quota — bump if a real perf question needs more resolution.

**Feature-flag SDK on, no flags consumed yet.** PostHog initializes with flag fetching at its default (on app start + on identify). We don't add a `useFlag(name)` helper, a `<Gate>` component, or any `if (flag(...))` call sites — that's premature. When the first flag is needed (likely a paywall A/B), the helper lands in the same PR that adds the call site. The cost of leaving fetching on is one extra request per cold start; the win is "the kill switch exists if the extraction proxy starts misbehaving."

**Privacy stance, explicit.** Events carry:

- `distinct_id` (= install_id UUID)
- Event name (from the closed vocabulary)
- Properties (enums + buckets from the closed schema)
- PostHog's auto-context: device model, OS version, app version, locale, timezone, screen size

Events do **not** carry:

- IP address (PostHog geo-IP capture disabled at init; `$ip` overridden to `null` on every event via PostHog's event-preprocess hook — exact option name resolves in the plan; the intent is "strip `$ip` from every captured event")
- IDFA, advertising ID, vendor identifier
- Email, name, phone
- Screenshot bytes, OCR text, captions, URLs, search queries, place names, trip names, tag values
- Any free-text user input

The event-preprocess hook is the structural enforcement — even if a future event accidentally adds `$ip` via PostHog auto-collection or someone adds a property the schema forgot to forbid, the hook strips the IP. We do not add a "scrub PII" hook for content because content never enters the pipeline — there's nothing to scrub.

**One telemetry surface for the app.** `modules/telemetry/index.ts` exports `track`, `setOptOut`, `isOptedOut`, and `captureError`. `captureError` re-exports the Sentry helper. App code should not import from `@sentry/react-native` or `posthog-react-native` directly outside the telemetry module. ESLint rule (project-level) blocks the direct imports.

## Event vocabulary

Events are grouped by funnel position. Names use `snake_case`. Every property is listed; properties not listed do not exist.

### App lifecycle

- **`app_opened`** — emitted on every app foreground; `cold_start: boolean`.

### Capture / import

- **`import_started`** — when the user kicks off an import; `source: 'share' | 'url_share' | 'auto' | 'manual'`.
- **`import_completed`** — after the screenshot lands in `screenshots`; `source`, `duration_bucket: '<100ms' | '<500ms' | '<2s' | '<10s' | '>=10s'`.
- **`import_failed`** — `source`, `stage: 'fetch' | 'storage' | 'dedup' | 'unknown'`, `error_class: string` (Error.name only, never message).

### Pipeline (OCR + AI)

- **`ocr_completed`** — `duration_bucket`, `char_count_bucket: 'empty' | '<100' | '<500' | '<2000' | '>=2000'`.
- **`ocr_failed`** — `error_class`.
- **`extraction_completed`** — `places_count_bucket: '0' | '1' | '2-3' | '4+'`, `model: string` (closed set: `'gpt-4o-mini' | 'claude-haiku-4-5'`).
- **`extraction_failed`** — `error_class`.
- **`enrichment_completed`** — `had_photo: boolean`, `had_address: boolean`, `had_rating: boolean`, `duration_bucket`.
- **`enrichment_failed`** — `error_class`.

### Organization

- **`trip_created`** — no properties.
- **`trip_deleted`** — `had_screenshots: boolean`, `screenshot_count_bucket: '0' | '1-3' | '4-10' | '10+'`.
- **`screenshot_assigned_to_trip`** — `was_inbox: boolean`, `method: 'triage' | 'detail' | 'share' | 'url_share'`.
- **`tag_added`** — `kind: 'place' | 'food' | 'activity'`.

### Triage

- **`triage_session_started`** — `inbox_size_bucket: '0' | '1-3' | '4-10' | '10+'`.
- **`triage_session_ended`** — `items_triaged_bucket: '0' | '1-3' | '4-10' | '10+'`, `exit: 'completed' | 'abandoned'`.
- **`triage_item_skipped`** — no properties.

### Discovery

- **`search_performed`** — `results_count_bucket: '0' | '1-3' | '4-10' | '10+'`, `query_length_bucket: '1-3' | '4-10' | '10+'`.
- **`place_tile_opened`** — `entry: 'home' | 'trip' | 'search' | 'triage'`.
- **`place_card_opened`** — `entry: 'home' | 'trip' | 'search' | 'triage'`, `had_enrichment: boolean`.
- **`open_in_maps_tapped`** — `app: 'google' | 'apple'`, `has_city: boolean`.
- **`source_link_opened`** — `platform: 'instagram' | 'tiktok' | 'youtube' | 'other'`.

### Monetization (paywall + entitlement)

- **`paywall_viewed`** — `trigger: 'trip_limit' | 'ai_extraction' | 'settings' | 'onboarding' | 'other'`.
- **`paywall_dismissed`** — `trigger`, `had_interaction: boolean`.
- **`trial_started`** — `plan: 'monthly' | 'annual'`.
- **`subscribed`** — `plan: 'monthly' | 'annual'`, `from_trial: boolean`.
- **`subscription_cancelled`** — `plan`.

### Onboarding

- **`onboarding_started`** — no properties.
- **`onboarding_step_completed`** — `step: 'welcome' | 'permissions' | 'ai_disclosure' | 'first_trip' | 'first_import'`.
- **`onboarding_completed`** — `duration_bucket`.
- **`ai_disclosure_accepted`** — no properties.

### Settings

- **`telemetry_opted_out`** — no properties; flushes and disables.
- **`telemetry_opted_in`** — no properties; re-enables (no backfill of missed events).

Total: ~30 events. The closed vocabulary makes the PostHog event browser legible and prevents the long-tail-of-typos problem.

## Module shape

```
modules/telemetry/
  events.ts        # discriminated union of every event; the schema
  posthog.ts       # init, identify, opt-in/out plumbing, beforeSend hook
  consent.ts       # read/write `telemetry_opt_out` in `meta` table
  index.ts         # public API: track, setOptOut, isOptedOut, captureError
  index.test.ts    # unit tests: event typing, beforeSend strips IP, consent gating
```

Public API:

```ts
// modules/telemetry/index.ts
export function track<E extends TelemetryEvent>(event: E): void;
export function setOptOut(optOut: boolean): Promise<void>;
export function isOptedOut(): boolean;
export function captureError(err: unknown, ctx?: { stage?: PipelineStage }): void;
```

`TelemetryEvent` is the discriminated union from `events.ts`, so:

```ts
track({ type: 'import_started', source: 'share' }); // ok
track({ type: 'import_started', source: 'photo' }); // type error — 'photo' not in source enum
track({ type: 'extraction_completed' }); // type error — missing props
track({ type: 'fish' }); // type error — unknown event
```

`captureError` re-exports the Sentry helper so the rest of the app has one telemetry import surface. The optional `stage` arg attaches `pipeline_stage` as a Sentry tag — matching the existing `pipelineError` semantics in `lib/observability/breadcrumbs.ts`, but routed through `modules/telemetry` so the eslint rule banning direct `@sentry/react-native` imports can hold project-wide.

Init order in `app/_layout.tsx`:

1. `initSentry()` (already there)
2. `provideDatabase()` (already there)
3. `attachInstallId()` (already there) — gets the UUID into Sentry.
4. **New:** `initTelemetry()` — reads opt-out state, initializes PostHog with `installId` as distinct ID if opted-in.
5. **New:** `track({ type: 'app_opened', cold_start: true })` — guarded internally by opt-out.

`initTelemetry` is async (it reads consent from SQLite). The `track('app_opened')` call awaits init, but every subsequent `track` call is synchronous — PostHog's RN SDK queues events internally, so call sites don't need to await anything.

## Consent flow

Default state: `telemetry_opt_out = false` (= telemetry on). Stored as a row in the `meta` table, key `'telemetry_opt_out'`, value `'1'` or `'0'`. Read once on init; cached for the lifetime of the process.

Settings UI: a single `<Switch>` under `Settings → Privacy → Help improve Trip Pocket`. Toggling:

- **On → off**: `setOptOut(true)` → write to `meta` → `track({ type: 'telemetry_opted_out' })` → `posthog.optOut()` (flushes queued events, then disables). The `telemetry_opted_out` event is the last one that ships.
- **Off → on**: `setOptOut(false)` → write to `meta` → `posthog.optIn()` → `track({ type: 'telemetry_opted_in' })`. No backfill of events missed while opted out.

In-process gating: every `track()` and `captureError()` early-returns if `isOptedOut() === true`. The opt-out check is cheap (in-memory boolean); the SQLite write only happens when the user toggles. Sentry is **also** disabled by opt-out — calling `Sentry.init` is fine; we route through `captureError` which checks consent.

(Open question — see "Open questions": do we want opt-out to also kill _crash_ reporting, or only product events? Current design: kills both. Argument for splitting: crash reporting is more defensible without consent because crashes are about the app, not the user. Argument against: a single toggle is simpler and more honest. Leaning towards single toggle; flagging for review.)

## Sentry performance traces

Two changes to `lib/observability/sentry.ts`:

1. `tracesSampleRate: 0.1` (was `0`).
2. Optional: a small `withSpan(name, fn)` helper that wraps `Sentry.startSpan` and forwards `pipeline_stage` as a span tag. Used by `modules/processing`, `modules/extraction`, `modules/enrichment`.

10% gives us roughly 1 in 10 OCR/extraction/enrichment operations sampled, which at v0.4 beta volume (5–10 testers × low-dozens of imports a week) is ~30–50 traces a week per stage. Enough to spot a p95 regression, not so much that it pressures the Sentry free tier. Bump to 0.5 or 1.0 if a real perf question lands.

The existing `pipelineStep`/`pipelineError` breadcrumbs stay as they are. Spans complement breadcrumbs (durations + waterfall) without replacing them (categorical stage trail in crash reports).

## Risks and mitigations

**Bundle size.** `posthog-react-native` adds ~150KB to the JS bundle. Trade-off accepted; falls below the threshold where a lazy-load split would be worth the complexity.

**Schema drift.** The whole point of the typed `events.ts` is to prevent this. The risk is that someone — including future-me — adds a one-off event in a hurry and bypasses the union. Mitigation: ESLint rule blocking direct imports of `posthog-react-native` outside `modules/telemetry`. PR reviewers (or codex-review) catch the rest. Tests in `index.test.ts` assert that `track({ type: 'some_event_not_in_union' })` is a compile error.

**False sense of privacy via auto-properties.** PostHog auto-collects device model, OS, app version, locale, timezone. None are content but they are fingerprintable in combination. We accept this — it's the cost of any product analytics tool and is necessary to read funnels by platform/version. The privacy copy at Settings is honest about "anonymous usage events" without claiming "fully anonymous."

**Volume blow-up.** If we accidentally fire `app_opened` per render (or some equivalent), free-tier limits get burned. Mitigation: the typed vocab makes accidental call sites visible in PR review, and we set up a PostHog billing alert at 100K events/month — three orders of magnitude under the cap, two orders over expected v0.4 volume.

**ATT regression.** If Apple updates ATT rules to cover non-IDFA structural analytics, this design needs a first-launch consent prompt. Mitigation: the consent code path exists; flipping default from "opted in" to "opted out + prompt" is a few-line change.

**Opt-out kills crash reporting.** If a user opts out of telemetry, they also stop sending Sentry crashes — see open question. We may discover users want analytics off but crashes on. Mitigation listed under open questions; current design keeps one toggle for simplicity.

**PostHog SDK breaking changes.** RN SDK is at v3.x; pin to a specific minor and gate upgrades behind the regular dep-bump review.

**Bundled feature-flag fetch failing.** PostHog flag fetch is non-blocking; failure leaves all flags as their default (`false` / not set). Since no flag is consumed in this milestone, the only failure mode is a dropped fetch request. Acceptable.

## Implementation phases

Each phase is one PR-shaped chunk:

1. **Wire the SDK + consent.** Install `posthog-react-native`, create `modules/telemetry/`, hook `initTelemetry` into `app/_layout.tsx`, add the Settings toggle, ship `app_opened`, `telemetry_opted_in`, `telemetry_opted_out` only. Verify in PostHog that events arrive with no IP and no PII.

2. **Activation funnel.** Add `import_started`, `import_completed`, `import_failed`, `trip_created`, `paywall_viewed`, `paywall_dismissed`, `trial_started`, `subscribed`. This is the v1.0 funnel — the only events that gate launch decisions.

3. **Pipeline events + Sentry traces.** OCR / extraction / enrichment completed + failed events, plus `tracesSampleRate: 0.1` and `Sentry.startSpan` wrappers on the three slow ops. Pipeline health goes from "Sentry knows when it fails" to "PostHog knows the success rate and Sentry knows the p95 latency."

4. **Feature usage.** Triage events, search, place tile / card opens, maps deep-link, source-link opens. The "what to invest in" data set.

5. **Onboarding.** Once onboarding screens exist (separate sub-project), the four onboarding events land. Decoupled from this telemetry sub-project's blockers.

Phase 1 unblocks PostHog dashboards even if nothing else lands. Phases 2–4 are independent and can be done in any order; their PRs should each be small enough to review in a sitting.

## Open questions

1. **Does opt-out kill crashes too, or only product events?** Current design: kills both. Splitting would mean two toggles in Settings ("Help improve Trip Pocket" + "Send crash reports"). Leaning: keep one toggle. Confirming.
2. **Do we route paywall events through PostHog _and_ RevenueCat's own webhooks, or only PostHog?** RevenueCat will be the source of truth for `subscribed` server-side. The client `subscribed` event in PostHog is useful for client-side funnels (paywall → trial → subscribed on the same device) and is what feeds in-app dashboards before RevenueCat→PostHog server-side integration is wired. Both is fine; flagging that they'll need to be reconciled when RevenueCat lands.
3. **PostHog session replay?** Off by default in this design. Worth revisiting if user complaints land that are hard to repro from breadcrumbs alone. Privacy posture would need a stricter pass (mask-everything mode + consent prompt).
4. **Marketing-site analytics tool?** Out of scope here. Likely Umami or Plausible when the marketing site exists.

## References

- `docs/ARCHITECTURE.md` — Stack at a glance · Telemetry section (lines 28, 59, 193–198).
- `docs/superpowers/specs/2026-05-11-sentry-design.md` — the crash-reporting predecessor; this spec layers on top of it without changing it.
- `lib/observability/sentry.ts`, `lib/observability/breadcrumbs.ts`, `lib/observability/install-id.ts` — existing observability code; `installId` is reused as the PostHog distinct ID.
