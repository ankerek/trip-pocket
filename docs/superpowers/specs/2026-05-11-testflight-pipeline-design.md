# TestFlight pipeline — design

**Status:** approved (2026-05-11) · ready for implementation plan
**Touches:** `eas.json`, `app.json`, new `docs/RELEASE.md`, new `whatsnew/en-US.txt`. App Store Connect bootstrap is manual and lives only in the runbook.
**Milestone:** v0.3 — TestFlight beta (first of 4–6 sub-projects).

## Why

The roadmap's v0.3 milestone is "TestFlight beta" — get the app into the hands of 5–10 friends so real-user feedback exists before App Store launch. Today there is no path from a `git push` to a friend's iPhone. `eas.json` defines only `dev` and `dev-sim` profiles; both use `distribution: internal` (ad-hoc), neither targets the App Store. No App Store Connect record exists for `com.trippocket.app`; no ASC API key has been wired up; no submit profile exists.

This sub-project produces the smallest end-to-end pipeline that delivers a signed build to TestFlight Internal Testing, plus a runbook so the steps don't have to be re-derived three weeks from now. It is deliberately scoped to **pipeline mechanics only** — every other v0.3 piece (Sentry, error handling, onboarding, accessibility, marketing assets) ships as its own sub-project.

## Scope

In scope:

- New `production` build profile in `eas.json`: `distribution: store`, `autoIncrement: true`, device-only iOS.
- New `production` submit profile in `eas.json` with `appleTeamId` + placeholder `ascAppId`.
- Marketing version reset in `app.json`: `expo.version` from `1.0.0` to `0.3.0`. iOS `buildNumber` stays unset (EAS owns it).
- `whatsnew/en-US.txt` as the in-repo source of truth for TestFlight "What to Test" notes. On free Expo plans the runbook treats it as a copy-paste target into ASC's TestFlight UI after each build (the `eas submit --what-to-test` flag is gated behind Expo's Enterprise plan and rejects free-tier submissions with `Changelog submission is currently available for Enterprise plan only`).
- `docs/RELEASE.md` runbook: one-time ASC bootstrap, per-release recurring checklist, troubleshooting.

Not in scope (each is a separate v0.3 sub-project unless noted):

- Crash reporting / Sentry wiring + sourcemap upload.
- Onboarding flow.
- Error-handling pass (failed import, storage full, denied permissions, proxy 4xx/5xx).
- Accessibility (VoiceOver, Dynamic Type).
- App icon redesign, launch screen redesign, marketing screenshots (v1.0 prep).
- Apple Beta App Review prep (only matters for external testers — internal-only for v0.3).
- App Privacy nutrition labels / Privacy Policy URL (blocked by App Store submission, not TestFlight internal distribution — v1.0).
- EAS Workflows (`.eas/workflows/*.yml`) automation. Manual local trigger is the v0.3 cadence.
- External TestFlight (≤10,000 testers, requires Beta Review). Internal-only suffices for the "5–10 friends" target.

## Decisions

**Tester audience: internal only.** Up to 100 testers with App Store Connect roles, added by Apple ID email. No Apple Beta App Review — builds go live in minutes. Removes the entire metadata burden (beta description, demo account, contact info) that external testing would impose.

**Build trigger: manual local `eas build`.** Solo cadence; pushing every merge to TestFlight is noisier than useful at this stage. The runbook documents the exact command. Graduating to EAS Workflows is a v1.0+ conversation.

**Versioning: marketing version manual, build number auto on EAS' remote source.** `"appVersionSource": "remote"` at the top of `eas.json` plus `autoIncrement: true` on the production profile means EAS owns `ios.buildNumber` entirely (stored server-side, never appears in `app.json`). Marketing `version` in `app.json` is bumped by hand when crossing milestones (e.g. `0.3.0` → `0.3.1`). Remote is also EAS' current recommended default and ships with explicit tooling (`eas build:version:get / set / sync`) for inspecting the server-side state. The "local" appVersionSource alternative — EAS bumps `ios.buildNumber` in `app.json` on the build worker without pushing back to the repo — was rejected: it leaves the repo's `app.json` perpetually out-of-date with the actual built number and offers no clean way to query the last value.

**Marketing version starts at 0.3.0.** Matches the roadmap milestone. Current `1.0.0` in `app.json` is placeholder boilerplate from Expo init. TestFlight internal testers see `0.3.0 (N)` and read it as "early build"; that's the correct signal. Will bump to `1.0.0` at App Store launch (v1.0).

**Sub-project ordering inside v0.3.** This pipeline ships first because every other v0.3 piece is moot if there's no way to deliver builds to testers. Sentry ships second (must be in the build before friends touch it). Error-handling pass third. Onboarding, accessibility, marketing assets layer in after.

## Contract

After this sub-project lands and the one-time bootstrap is done:

- A two-command release flow succeeds locally:
  1. `eas build --profile production --platform ios`
  2. `eas submit --platform ios --latest`
- The resulting IPA appears in App Store Connect → TestFlight within ~30 minutes (processing time varies).
- Internal testers (you + up to 9 friends) receive a TestFlight invite email and can install via the TestFlight app.
- After Apple finishes processing, the contents of `whatsnew/en-US.txt` are pasted by hand into the build's "What to Test" field in ASC's TestFlight UI.
- iOS `buildNumber` is monotonically increasing across builds with no manual intervention.

`--what-to-test` is intentionally absent from the submit command: Expo gates the flag behind their Enterprise plan and rejects free-tier submissions that include it with `Changelog submission is currently available for Enterprise plan only`. The manual paste step in ASC is the workaround.

## In-repo changes

### `eas.json`

Add `appVersionSource: "remote"` inside the `cli` block, a `production` build profile, and a `production` submit profile. Leave `dev` and `dev-sim` unchanged.

```jsonc
{
  "cli": {
    "version": ">= 12.0.0",
    "appVersionSource": "remote",
  },
  "build": {
    "dev": { "developmentClient": true, "distribution": "internal", "ios": { "simulator": false } },
    "dev-sim": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true },
    },
    "production": {
      "distribution": "store",
      "autoIncrement": true,
      "ios": { "simulator": false },
    },
  },
  "submit": {
    "production": {
      "ios": {
        "appleTeamId": "WL5ALL46C4",
        "ascAppId": "<filled in after ASC bootstrap step 2>",
      },
    },
  },
}
```

Notes:

- `distribution: store` is the EAS signal to build a release archive suitable for App Store upload (vs. `internal` ad-hoc).
- `appVersionSource: "remote"` + `autoIncrement: true` on production means EAS owns `ios.buildNumber` server-side; it never appears in `app.json`. Query with `eas build:version:get --platform ios --profile production`.
- The ASC API key itself is **not** in `eas.json` — it lives in EAS-managed credentials, encrypted server-side. Wired up via `eas credentials` during bootstrap.
- `ascAppId` is the numeric App ID Apple assigns when the App Store Connect record is created. It goes in as a placeholder string in the initial commit and is filled in once bootstrap step 2 is done. The implementation plan should flag this as a "must-edit-before-first-submit" line.

### `app.json`

Single change: `expo.version` from `1.0.0` to `0.3.0`. No `ios.buildNumber` field added (EAS owns it). All other fields including the share-extension config under `extra.eas.build.experimental.ios.appExtensions` stay untouched.

### `whatsnew/en-US.txt`

New file. In-repo source of truth for the TestFlight "What to Test" string; read by the runbook's submit command (`--what-to-test "$(cat whatsnew/en-US.txt)"`). Seed content:

```
First TestFlight build of Trip Pocket — capture from the share sheet, browse in Pocket, tap to see AI-extracted places.
```

Updating per release is a one-line edit, documented in the runbook. Directory shape (`whatsnew/<locale>.txt`) follows the fastlane convention so we can graduate to per-locale notes later without renaming. EAS Submit does **not** auto-pick this file — it's purely a repo convention we read into the CLI flag.

### `docs/RELEASE.md`

New runbook, ~80–120 lines. Three sections:

**1. One-time bootstrap.** Five steps, each with a "done when" marker:

- Register App IDs `com.trippocket.app` and `com.trippocket.app.share` in Apple Developer portal, both with App Groups capability (`group.com.trippocket.shared`).
- Create the App Store Connect app: name `Trip Pocket`, primary language English (U.S.), bundle ID `com.trippocket.app`, SKU `trip-pocket-001`, user access full.
- Note the numeric Apple ID assigned to the app; paste into `eas.json` → `submit.production.ios.ascAppId`.
- Create an App Store Connect API key with role `App Manager` (ASC → Users & Access → Integrations). Download the `.p8`, note Key ID + Issuer ID. Attach to EAS via `eas credentials` (one-time).
- Add internal testers in ASC → TestFlight → Internal Group.

**2. Each release.** Five steps:

- (If crossing a version milestone) bump `expo.version` in `app.json`.
- Edit `whatsnew/en-US.txt` with 1–3 lines describing what changed.
- `eas build --profile production --platform ios` and wait for it to finish (or pass `--wait` to block).
- `eas submit --platform ios --latest --what-to-test "$(cat whatsnew/en-US.txt)"`.
- Confirm in ASC → TestFlight that the build is processed and visible to the internal group.

**3. Troubleshooting.** Three known failure modes:

- "Build number already used" → EAS state out of sync; `eas build --clear-cache` and/or bump manually in app.json once.
- Share-extension provisioning prompt on first prod build → expected; accept the EAS-generated profile.
- ASC API key revoked/expired → re-attach via `eas credentials`; key has a 1-year lifespan by default.

## Risks & mitigations

- **Risk:** ASC API key not configured when first `eas submit` runs → submit step fails after a successful build. **Mitigation:** Runbook orders bootstrap step 4 before the first build. Cost of failure is low (re-run submit), so not worth gating in code.
- **Risk:** Share-extension target (`com.trippocket.app.share`) needs its own distribution certificate + provisioning profile, prompted at first production build. **Mitigation:** Runbook documents the prompt; accept EAS-generated defaults. The existing `appExtensions` config in `app.json` is unchanged and already correct for the share-extension entitlements/app-group.
- **Risk:** Bumping `version` from `1.0.0` to `0.3.0` looks like a regression to the App Store. **Mitigation:** App Store cares about marketing version monotonicity only across submitted releases. Nothing has been submitted yet, so the first submitted version is whatever we pick. Internal TestFlight UI shows `0.3.0 (N)` to testers, which reads correctly as "pre-1.0 beta." Will land at `1.0.0` for v1.0 milestone.
- **Risk:** Auto-increment causes drift between local app.json and EAS state if someone manually sets `ios.buildNumber`. **Mitigation:** Spec deliberately keeps `ios.buildNumber` absent from `app.json`. Runbook says "do not add it."
- **Risk:** A future sub-project (Sentry) needs sourcemap upload tied to the production build, which complicates the build command. **Mitigation:** That's the Sentry sub-project's problem. The `eas build` command in `RELEASE.md` is expected to evolve as later sub-projects add prebuild hooks.

## Verification

After implementation and bootstrap:

1. `eas build --profile production --platform ios` followed by `eas submit --platform ios --latest` runs end-to-end without manual intervention beyond accepting the share-extension provisioning prompt on the very first build.
2. The build appears in App Store Connect under TestFlight, with status processing → ready to test within ~30 min.
3. The contents of `whatsnew/en-US.txt` are pasted into the build's "What to Test" field in ASC after processing finishes.
4. An internal tester (the developer's own Apple ID) receives a TestFlight invite, installs the build, and can launch the app.
5. A second consecutive build produces a higher `buildNumber` with no manual edits.

Steps 1–5 are run-by-hand acceptance; no automated test exists or is appropriate for this layer.

## Follow-ups (deliberately deferred)

- Sentry sub-project: will add an `eas-build-pre-install` hook (or postinstall) that uploads sourcemaps tied to each production build.
- EAS Workflows: revisit at v1.0 if release cadence becomes painful manually.
- External TestFlight: revisit if internal testers' feedback suggests broadening.
- App Privacy nutrition labels + Privacy Policy URL: v1.0 work, gated by App Store submission not TestFlight.
