# Sentry — design

**Status:** approved (2026-05-11) · ready for implementation plan
**Touches:** `package.json`, `app.json`, `eas.json`, `docs/RELEASE.md`, new `lib/observability/*`, new `components/error-fallback.tsx`, surgical edits to `app/_layout.tsx` and the existing OCR → enrichment pipeline call sites.
**Milestone:** v0.3 — TestFlight beta (second of 4–6 sub-projects; follows [TestFlight pipeline](./2026-05-11-testflight-pipeline-design.md)).

## Why

The TestFlight pipeline sub-project landed in commit `109f2ef`: a `production` EAS profile, a submit profile, `whatsnew/en-US.txt`, and `docs/RELEASE.md`. Builds can now reach 5–10 internal testers. But the moment a friend's iPhone hits a crash or unhandled exception, no signal reaches the developer — there is no error reporting in the app today (no Sentry, no Bugsnag, no Crashlytics, no native exception logging beyond the iOS Console).

This sub-project wires Sentry into the production build so crashes and unhandled JS errors from TestFlight reach a dashboard. It is deliberately the second v0.3 sub-project — every later piece (onboarding, error-handling pass, accessibility) wants to know which crashes are real before tackling polish.

Scope is the minimum that produces a useful signal for a 5–10 person beta: native + JS error capture, branded fallback UI, anonymous install grouping, automatic sourcemap upload tied to each EAS production build, no perf, no replays, no alerting.

## Scope

In scope:

- `@sentry/react-native` SDK and `@sentry/react-native/expo` config plugin added to `app.json` plugins.
- `initSentry()` module gated on `!__DEV__` so only production binaries report.
- Top-level `Sentry.ErrorBoundary` in `app/_layout.tsx` with a branded fallback screen + Reload button.
- Anonymous install UUID stored in `expo-sqlite`, set as Sentry `user.id`. No email, no IP (`sendDefaultPii: false`).
- Sourcemap upload on every EAS production build via the `@sentry/expo-upload-sourcemaps` CLI (invoked from a `package.json` script wired into the EAS build lifecycle), authenticated by `SENTRY_AUTH_TOKEN` from EAS secrets. The `@sentry/react-native/expo` plugin in `app.json` stores `org`/`project` so the CLI reads them from there instead of needing extra env vars; it also patches the iOS Xcode build phase to upload native symbols.
- Pipeline breadcrumbs at stage transitions: `share_import → storage → ocr → extraction → enrichment → trip_assign`. **No payload** — category name only. Errors keep a `pipeline_stage` tag for filtering.
- `docs/RELEASE.md` gains a Sentry section (one-time secret setup + per-release verification).

Not in scope (each may become its own sub-project):

- Performance tracing, custom transactions, profiling.
- Mobile Session Replay.
- User Feedback dialog inside the error fallback.
- Email / Slack alerting — Sentry dashboard only for v0.3.
- Android wiring (plugin supports it; iOS-first means we don't verify on Android now).
- App-side privacy policy / Sentry disclosure UI (gated by App Store submission, deferred to v1.0).
- `beforeSend` scrubbing hook (unnecessary under current scope; events have no user content to scrub).

## Decisions

**Events from production builds only.** `initSentry()` returns early when `__DEV__ === true`. Both `dev` and `dev-sim` EAS profiles build dev-client binaries with `__DEV__ === true`; only the `production` profile produces a Hermes-optimized build with `__DEV__ === false`. So `!__DEV__` is equivalent to "EAS production profile only" without a custom env var. Local crashes during development stay out of the dashboard.

**Error UX: branded fallback, no report button.** When a render-time exception escapes the React tree, `Sentry.ErrorBoundary` swaps in a fallback screen styled with the app's existing design-system primitives ("Something went wrong — Reload"). Capture is automatic; no "Send report" button. Testers see a polished surface, not a stack trace; we get the event regardless. The User Feedback dialog (where testers type what they were doing) was rejected for v0.3 because it adds UI work that only pays off if testers fill it in — re-evaluate if DM-based reports turn out to be too thin.

**Identity: anonymous install UUID only.** First launch generates `crypto.randomUUID()`, stored in a `kv` row in the existing SQLite database. Set as Sentry `user.id`. No email, no name, no IP (`sendDefaultPii: false`). This is enough to distinguish "one tester crashed 10 times" from "10 testers each crashed once" — which changes priority — without ever attaching a real human to a crash. App delete + reinstall produces a new ID; that's correct semantics ("install instance" not "human") and is explicit so we're not surprised by it.

**Breadcrumbs: stage transitions, no payload.** Each pipeline stage emits a `Sentry.addBreadcrumb({ category: 'pipeline.<stage>' })` on entry and `'pipeline.<stage>.error'` on failure. **No IDs, no place names, no OCR text, no URLs.** Errors get a `pipeline_stage` tag at capture time for dashboard filtering. The trail shows the path (`share_import → storage → ocr → enrichment.error`) and the tag tells you the failure shape; repros come from asking the tester, not from the dashboard. For 5–10 friends this is enough.

A richer variant (stage + opaque IDs like `screenshot_id`, `place_id`) was considered and rejected: even opaque IDs let us answer "is this the same screenshot failing twice?", but the simpler version was preferred to keep Sentry's payload free of anything derived from user content. If the gap becomes painful during the beta, we add the IDs back.

**Sourcemaps: explicit CLI step, plugin stores config.** Two cooperating pieces, both documented:

1. The `@sentry/react-native/expo` plugin in `app.json` stores `org` and `project` so other Sentry tooling reads them from there instead of needing `SENTRY_ORG` / `SENTRY_PROJECT` env vars. The plugin also patches the iOS Xcode build phase to upload native (iOS) debug symbols during the build.
2. JavaScript sourcemap upload runs as an **explicit post-build step**: `npx @sentry/expo-upload-sourcemaps dist` (the path argument is the Hermes/Metro bundle output dir). It reads `SENTRY_AUTH_TOKEN` from env, and `org`/`project` from the plugin config in `app.json`.

We wire step 2 via an `npm` script (`"postbuild:upload-sourcemaps"`) that EAS invokes as part of the production build lifecycle. The exact hook (`eas-build-post-install`, an `eas.json` `build.production.cache.*` hook, or a Metro `serializerHook`) is determined at implementation time after reading current EAS hook docs — there are a few valid wiring shapes and the right one depends on where the Hermes bundle lands in the EAS build worker filesystem.

The TestFlight spec flagged sourcemap upload as the Sentry sub-project's problem and gestured at an `eas-build-pre-install` hook. The actual hook will be a *post-bundle* hook, not pre-install (sourcemaps don't exist before bundling). The EAS pipeline shape from the user's perspective (`eas build --profile production --platform ios && eas submit --platform ios --latest`) is unchanged.

**Release tagging: automatic.** The plugin derives the Sentry release as `<bundleId>@<version>+<buildNumber>`, matching what EAS publishes. We do **not** set `release` manually in `Sentry.init` — that keeps the JS init and the build pipeline in sync. The `buildNumber` source of truth is EAS' remote `appVersionSource` (decided in the TestFlight spec), so a TestFlight build uploaded as `0.3.0 (7)` becomes Sentry release `com.trippocket.app@0.3.0+7`.

**Alerting: none.** Sentry dashboard only for v0.3. Email/Slack alerts re-evaluated after the first beta week — if you're checking the dashboard daily, alerts are noise; if you're not, they're worth adding.

## Contract

After this sub-project lands and the one-time secret bootstrap is done:

- A production EAS build (no command changes vs. TestFlight spec) emits a `[sentry] uploading source maps` line in the build log and the resulting build appears under Sentry → Releases as `com.trippocket.app@<version>+<buildNumber>`.
- An iOS native crash or unhandled JS exception in the TestFlight build appears in Sentry within ~1 minute, with a symbolicated stack pointing at our source files (not `index.bundle:1:NNNNN`).
- Every captured event has `user.id` set to a UUID, no email/IP, and (if a render-tree crash) breadcrumbs of the pipeline stages traversed.
- A render-time exception shows the branded fallback UI; the user can Reload back to a working app; the event lands in Sentry regardless.
- Dev-client builds (`dev`, `dev-sim`) and Expo Go produce no Sentry events under any circumstance.

## In-repo changes

### `package.json`

Add one runtime dep and one build script:

```jsonc
"dependencies": {
  "@sentry/react-native": "^<current major>"
},
"scripts": {
  "sentry:upload-sourcemaps": "sentry-expo-upload-sourcemaps dist"
}
```

The implementation plan picks the exact `@sentry/react-native` version that's current at write time and matches the Expo 55 / RN 0.83 compatibility matrix. The bundle output dir argument (`dist`) is confirmed against EAS' actual output path at implementation time — depending on Hermes vs JSC and EAS' working dir, it may be `dist`, `bundle`, or another path.

### `app.json`

Append the Sentry plugin to `expo.plugins`. Existing plugins (including the share-extension config under `extra.eas.build.experimental.ios.appExtensions`) are untouched.

```jsonc
"plugins": [
  // ...existing plugins...
  [
    "@sentry/react-native/expo",
    {
      "organization": "trip-pocket",
      "project": "trip-pocket-ios",
      "url": "https://sentry.io/"
    }
  ]
]
```

The exact key names (`organization` vs `org`, `project`, `url`) are confirmed against the `@sentry/expo-upload-sourcemaps` README at implementation time — the CLI tool reads these directly from the plugin config. The slugs themselves (`trip-pocket`, `trip-pocket-ios`) are filled in after the Sentry org/project is created in the bootstrap step.

### `eas.json`

Add `env` block to the existing `production` build profile so EAS forwards the auth token at build time:

```jsonc
"build": {
  "production": {
    "distribution": "store",
    "autoIncrement": true,
    "ios": { "simulator": false },
    "env": {
      "SENTRY_AUTH_TOKEN": "$SENTRY_AUTH_TOKEN",
      "EXPO_PUBLIC_SENTRY_DSN": "$EXPO_PUBLIC_SENTRY_DSN"
    }
  }
}
```

Both values are stored as EAS secrets (`eas secret:create`), not committed. `SENTRY_AUTH_TOKEN` is build-time-only (used by the plugin during sourcemap upload). `EXPO_PUBLIC_SENTRY_DSN` is shipped in the client bundle — that's safe (the DSN is a write-only ingest endpoint and is meant to be public).

### `lib/observability/install-id.ts` (new)

```ts
import * as Crypto from 'expo-crypto';
import { getDb } from '@/lib/db';   // exact import path confirmed at impl time

const KEY = 'install_id';

export async function getInstallId(): Promise<string> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM kv WHERE key = ?', KEY
  );
  if (row) return row.value;

  const id = Crypto.randomUUID();
  await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?)', KEY, id);
  return id;
}
```

The implementation plan determines whether a `kv` (key-value) table already exists in the schema or needs a one-row migration to create it. SQLite chosen over `expo-file-system` JSON or AsyncStorage to stay consistent with how the rest of the app stores persistent state and to avoid a new dependency.

### `lib/observability/sentry.ts` (new)

```ts
import * as Sentry from '@sentry/react-native';
import { getInstallId } from './install-id';

export function initSentry() {
  if (__DEV__) return;

  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    enableNativeCrashHandling: true,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    attachStacktrace: true,
    debug: false,
  });

  getInstallId().then(id => Sentry.setUser({ id })).catch(() => {});
}
```

Notes for the implementation plan:

- `enableNativeCrashHandling: true` is the option name in current docs (confirmed via context7). Older guides use `enableNative` — do not use that form.
- `tracesSampleRate: 0` is explicit (rather than omitted) to defend against the SDK enabling default tracing in a future version and silently consuming events.
- `debug: false` is explicit so that if someone copy-pastes the docs' `debug: __DEV__` later, they don't end up shipping verbose Sentry logs to TestFlight builds. (Init only runs when `!__DEV__`, but being explicit costs nothing.)
- Session tracking and native frames tracking are intentionally not configured here. Defaults are sufficient for v0.3 and the exact option names have shifted across SDK versions; the implementation plan confirms what (if anything) needs to be set.
- Release tag is intentionally not set here — the upload CLI derives it from the bundle and EAS metadata so JS init and the build pipeline stay in sync.

### `lib/observability/breadcrumbs.ts` (new)

```ts
import * as Sentry from '@sentry/react-native';

type Stage = 'share_import' | 'storage' | 'ocr' | 'extraction' | 'enrichment' | 'trip_assign';

export function pipelineStep(stage: Stage) {
  Sentry.addBreadcrumb({ category: `pipeline.${stage}`, level: 'info' });
}

export function pipelineError(stage: Stage, err: unknown) {
  Sentry.addBreadcrumb({ category: `pipeline.${stage}.error`, level: 'error' });
  Sentry.captureException(err, { tags: { pipeline_stage: stage } });
}
```

Entire breadcrumb API. No data payload by design. `pipeline_stage` tag on the captured event enables dashboard filtering ("all enrichment failures this week") without putting user content into Sentry.

### `app/_layout.tsx`

Two surgical edits:

```tsx
import { initSentry } from '@/lib/observability/sentry';
import * as Sentry from '@sentry/react-native';
import { ErrorFallback } from '@/components/error-fallback';

try { initSentry(); } catch {}   // top of module

// inside root component's return:
<Sentry.ErrorBoundary fallback={ErrorFallback}>
  {/* existing tree */}
</Sentry.ErrorBoundary>
```

`Sentry.ErrorBoundary` takes a **component reference** for `fallback`, not a rendered element (confirmed via context7). Sentry calls it as `<FallbackComponent error={…} resetError={…} />` and `ErrorFallback` reads `resetError` from props to wire its Reload button. `try/catch` around `initSentry()` ensures a broken Sentry init can never block app launch.

### `components/error-fallback.tsx` (new)

Component (not element) consumed by `Sentry.ErrorBoundary`'s `fallback` prop. Sentry calls it as `<ErrorFallback error={Error} resetError={() => void} />`. Branded "Something went wrong" screen using the app's existing design-system primitives. Single Reload button calls `resetError`. No "Send report" button. The `error.message` is **not** rendered into the UI — it's already in Sentry, and exposing it to testers leaks internals (stack-shape strings like "Cannot read properties of undefined…" aren't useful and look like bugs even when they ARE bugs).

### Pipeline call sites

Existing OCR → enrichment pipeline code (touched in `94fb337 feat(progress-feedback)`) gains one-line calls to `pipelineStep(stage)` at each stage transition and `pipelineError(stage, e)` at each catch block. Estimated 4–6 sites. Implementation plan identifies the exact files — likely under `lib/pipeline/` or `workers/`.

### `docs/RELEASE.md`

One additive section, ~10 lines: **"Sentry sourcemaps."** Documents:

- One-time bootstrap: create Sentry org/project, create auth token, `eas secret:create SENTRY_AUTH_TOKEN` and `eas secret:create EXPO_PUBLIC_SENTRY_DSN`, set per-project rate limit to ~100 events/minute in Sentry → Settings → Limits.
- Per-release verification: after `eas build` finishes, confirm the new release appears in Sentry → Releases.

The existing per-release checklist gains one bullet ("Sentry release visible") between "build finished" and "submit."

## Risks & mitigations

- **`SENTRY_AUTH_TOKEN` leaked.** Token lives only in EAS secrets, never in `eas.json` literally, never in source. The plugin reads it from build-time env. The `EXPO_PUBLIC_SENTRY_DSN` is intentionally public — write-only ingest key, meant to ship in client bundles.
- **Plugin option names drift.** Implementation plan verifies plugin keys against live Sentry docs at write-time, before code is committed. Substance doesn't change; JSON shape might.
- **`Sentry.init` option names drift.** Some option names have shifted across SDK versions (`enableNative` → `enableNativeCrashHandling`; session/frames-tracking options renamed). The spec uses what current docs show, but the implementation plan reads the SDK version's release notes / typings before writing the init call and silently corrects any naming the spec gets stale on.
- **Sourcemap upload hook misfires on EAS.** The post-bundle hook needs the Hermes output to exist before it runs. If it runs too early, upload silently uploads an empty directory; if too late, the build artifact ships and the upload races. Implementation plan picks the hook based on the EAS worker's filesystem layout (likely `expo-build-output` directory after the bundle phase), and verification step 3 below catches a misfire because frames stay unresolved.
- **Sourcemap upload fails silently while build succeeds.** Verification step 3 below explicitly checks a real event from the build has resolved frames; release runbook gains "confirm release shows up in Sentry → Releases" as a per-release check.
- **Free-tier quota (5k errors/mo) exhausted by a runaway loop.** Configure Sentry's per-project rate limit (dashboard, not code) to ~100 events/minute on bootstrap.
- **`initSentry()` throws.** Wrapped in `try/catch` in `_layout.tsx` so a broken Sentry never blocks app boot.
- **`Sentry.ErrorBoundary` doesn't catch async errors / event handlers.** Standard React boundary limitation. The SDK's global error handlers (enabled by default) catch unhandled rejections and uncaught JS exceptions outside the render tree; the boundary is specifically for render-time crashes so the UI can recover.
- **Install ID resets on app delete + reinstall.** Correct semantics ("Sentry user" = "install instance"). Worth flagging so the same human appearing as two `user.id`s after a reinstall isn't a surprise.

## Verification

Run-by-hand acceptance after implementation + one-time secret bootstrap:

1. **Dev builds stay silent.** Launch the `dev` profile on sim or device, force a JS throw. Sentry dashboard receives **no** event.
2. **Production builds send crashes.** `eas build --profile production --platform ios && eas submit --platform ios --latest`. Install TestFlight build, force a JS throw via a hidden debug shortcut. Within ~1 minute the event appears in Sentry, release `com.trippocket.app@0.3.0+<N>`, `user.id` set, no email/IP.
3. **Sourcemaps resolve.** The event from step 2 shows symbolicated stack frames with our source filenames (`lib/...`, `app/...`), not `index.bundle:1:NNNNN`.
4. **Native crash captured.** Trigger a native-side crash (e.g. `Sentry.nativeCrash()` from a hidden dev shortcut kept only for verification). Event appears as a native crash, not a JS error.
5. **Install ID persists across launches.** Crash twice in the same install — both events share the same `user.id`. Delete + reinstall → new `user.id`.
6. **Pipeline breadcrumbs ride along.** Run share-import → OCR → enrichment successfully, then trigger a contrived enrichment failure (e.g. network off). Captured error has breadcrumbs `pipeline.share_import`, `pipeline.storage`, `pipeline.ocr`, `pipeline.enrichment.error`, plus a `pipeline_stage: enrichment` tag. **No IDs, no place names, no OCR text, no URLs in the payload.**
7. **ErrorBoundary fallback renders.** Force an unhandled render-time exception. Branded fallback appears, Reload returns to a working app, Sentry has the event.

Steps 1–7 are acceptance, not automated tests. Unit tests aren't a good fit — value is in end-to-end wiring, which only a real device + Sentry dashboard can confirm.

## Follow-ups (deliberately deferred)

- Performance tracing / replay — re-evaluate after first beta week if "is this slow?" becomes a real question.
- **Expo Router navigation breadcrumbs** — `Sentry.reactNavigationIntegration.registerNavigationContainer(navigationRef)` would auto-add a breadcrumb on every route change ("user was on `/trips/123` when it crashed"). Cheap signal; add if "where was the user?" turns out to be a recurring question. Excluded from v0.3 because it's strictly additive — pipeline breadcrumbs cover the OCR/enrichment story, which is where most failures are expected.
- Email / Slack alerting — re-evaluate after first beta week.
- User Feedback dialog inside the error fallback — add if DM-based bug reports turn out to be too thin.
- Android wiring — plugin supports it; revisit when Android ships.
- App-side privacy disclosure for Sentry data collection — gated by App Store submission (v1.0), not internal TestFlight.
- `beforeSend` scrubbing hook — unnecessary under current scope (no user content in events); add if breadcrumb payloads ever expand.
- Restoring opaque IDs (`screenshot_id`, `place_id`) to breadcrumbs — revisit if "two testers, same screenshot or different?" becomes a question worth answering from the dashboard alone.
