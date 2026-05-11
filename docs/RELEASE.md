# Release runbook — TestFlight

This file is the source of truth for getting a build from this repo onto an internal tester's iPhone. v0.3 ships internal-only (≤100 testers, no Apple Beta App Review). Design rationale in `docs/superpowers/specs/2026-05-11-testflight-pipeline-design.md`.

---

## One-time bootstrap

Do once, before the first production build. Steps 1–4 must be done in order; step 5 can happen anytime.

### 1. Register App IDs in the Apple Developer portal

- Sign in: <https://developer.apple.com/account/resources/identifiers/list>
- Add an App ID for `com.trippocket.app`. Enable capabilities: **App Groups** (existing group `group.com.trippocket.shared`).
- Add a second App ID for `com.trippocket.app.share` (the share extension). Same App Groups capability, same group.

**Done when:** both identifiers show up in the list with App Groups checked.

### 2. Create the App Store Connect app record

- Sign in: <https://appstoreconnect.apple.com/apps>
- **My Apps → ＋ → New App**.
- Platform: iOS. Name: `Trip Pocket - Travel Inbox` (the bare `Trip Pocket` was already taken on the App Store; this is the standard `Name - subtitle` pattern Apple uses for apps like Notion, Threads, Reddit). Primary Language: English (U.S.). Bundle ID: `com.trippocket.app` (picked from the dropdown — must already exist from step 1). SKU: `trip-pocket-001`. User Access: Full Access.
- The home-screen label stays `Trip Pocket` via `app.json` → `expo.name` — they don't have to match.
- After creation, open the app and note the **Apple ID** field (a 10-digit number in the App Information panel). This is `ascAppId`.

**Done when:** the new app appears in App Store Connect and you have the 10-digit Apple ID.

### 3. Paste `ascAppId` into `eas.json`

- Open `eas.json`, find `submit.production.ios.ascAppId`, replace `REPLACE_WITH_ASC_APP_ID_AFTER_BOOTSTRAP` with the 10-digit string from step 2.
- Commit. This is a one-line change.

**Done when:** `git diff eas.json` shows the new ID and the file still parses (`jq . eas.json`).

### 4. Configure App Store Connect API key

Two paths — pick one, not both:

**Path A — let EAS generate the key (easiest):**

- `eas credentials` → iOS → build profile `production` → **App Store Connect: Manage your API Key** → **Set up your project to use an API Key for EAS Submit** → **Generate new**.
- EAS prompts for your Apple ID + password + 2FA code, then creates a key named `[Expo] EAS Submit ...` in ASC with App Manager role and stores it server-side. No `.p8` to handle.

**Path B — bring your own key:**

- App Store Connect → **Users & Access → Integrations → App Store Connect API → Team Keys → Generate API Key**. Role: **App Manager**. Download the `.p8` (Apple shows it once).
- `eas credentials` → iOS → build profile `production` → **App Store Connect: Manage your API Key** → **Use an existing API Key** → paste the `.p8` path, Key ID, Issuer ID.

**Done when:** `eas credentials` shows the ASC API key under iOS credentials with no warnings.

### 5. Add internal testers

- App Store Connect → app → **TestFlight → Internal Group** (default group exists).
- Add Apple ID emails (your own first; friends later).
- Each tester gets an invite email once the first build is processed; they install the TestFlight app and accept.

**Done when:** your own Apple ID appears in the Internal Group.

### 6. Configure Sentry

- Create the Sentry organization (suggested slug: `trip-pocket`) and a project for iOS (suggested slug: `trip-pocket-ios`).
- Edit `app.json` → `expo.plugins[@sentry/react-native]` and replace the two `REPLACE_BEFORE_FIRST_PROD_BUILD` placeholders with the real `organization` and `project` slugs.
- Sentry → **Settings → Account → API → Auth Tokens** → create a token with scope `project:write` and `project:releases`. Copy the value.
- Sentry → project → **Settings → Client Keys (DSN)** → copy the DSN.
- Push both as project-scoped EAS secrets so they auto-inject into every build:

  ```sh
  eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token>
  eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN --value <dsn>
  ```

- Sentry → project → **Settings → Performance & SDK → Limits** (or **Project Settings → Limits**) → set the per-project event rate limit to ~100 events/minute. Guard-rail against a runaway loop draining the free-tier quota (5k/month).

**Done when:** `eas secret:list` shows both names with `Scope: project`, and the two slugs in `app.json` are real values.

---

## Each release

### 1. (Optional) Bump marketing version

- Open `app.json`, edit `expo.version` if crossing a milestone (e.g. `0.3.0` → `0.3.1` for a bugfix beta, `0.3.1` → `0.4.0` if features changed materially).
- Leave it alone for incremental builds within a milestone — `buildNumber` auto-increments on EAS, so two builds of `0.3.0` won't collide.

### 2. Update release notes

- Open `whatsnew/en-US.txt`. Replace contents with 1–3 lines describing what changed for testers.
- Keep under 4000 characters (Apple limit). Aim for ~200.

### 3. Build

```sh
eas build --profile production --platform ios
```

- The first production build will prompt for distribution credentials. Accept EAS-generated defaults for both `com.trippocket.app` **and** `com.trippocket.app.share` (the share extension target needs its own provisioning profile — this is expected).
- Pass `--wait` if you want the command to block until the build is done, otherwise check status with `eas build:list --platform ios --limit 1`.

### 4. Submit

```sh
eas submit --platform ios --latest
```

- `--latest` picks the most recent finished build for iOS.
- Do **not** add `--what-to-test`; the flag is gated behind Expo's Enterprise plan and rejects free-tier submissions with `Changelog submission is currently available for Enterprise plan only`. The release notes get pasted in ASC manually in step 5.

### 5. Paste release notes + verify

- Open App Store Connect → app → **TestFlight** tab. The new build appears with status `Processing` → `Ready to Test` within ~30 minutes.
- Click the build, scroll to **Test Details** → **What to Test**, paste the contents of `whatsnew/en-US.txt`, **Save**.
- Internal testers receive an email once the build is ready. Confirm on your own device that the install + launch works.

### 6. Confirm Sentry release visible

- Open Sentry → project → **Releases**. The newly built release should appear as `com.trippocket.app@<version>+<buildNumber>` (e.g. `com.trippocket.app@0.3.0+7`) within a few minutes of the build finishing.
- If it doesn't appear, sourcemap upload failed silently. Check the EAS build log for the `eas-build-on-success` step and re-run it locally if needed:

  ```sh
  RELEASE="com.trippocket.app@$(node -e 'console.log(require(\"./app.json\").expo.version)')+<buildNumber>" \
    SENTRY_AUTH_TOKEN=<token> \
    npx sentry-expo-upload-sourcemaps --release "$RELEASE" dist
  ```

  Without the release visible, crashes from this build will arrive with unsymbolicated stacks.

---

## Each release — local build alternative

EAS' free tier queues can be slow. The same TestFlight release can be produced from a local Xcode archive in ~8–12 min instead of waiting. Both paths are kept supported; pick whichever is faster on the day.

**One-time setup (done once per machine):**

- Copy `.env.local.example` to `.env.local` and paste your real `SENTRY_AUTH_TOKEN` (Organization Token, `org:ci` scope) and `EXPO_PUBLIC_SENTRY_DSN` (project DSN). The file is gitignored.
- Ensure Xcode is installed and your Apple Developer team (`WL5ALL46C4`) is signed in (Xcode → Settings → Accounts).

**Each release:**

### L1. Bump the build number

Open `app.json` and increment `ios.buildNumber` by one (e.g. `"1"` → `"2"`). App Store Connect rejects builds with duplicate `(version, buildNumber)` pairs.

### L2. Source the env vars

```sh
export $(cat .env.local | xargs)
```

Both `SENTRY_AUTH_TOKEN` and `EXPO_PUBLIC_SENTRY_DSN` must be in the shell environment when Xcode runs the archive — the `@sentry/react-native` Xcode build phase reads them at archive time.

### L3. Regenerate the iOS project from app.json

```sh
npx expo prebuild --platform ios
```

Materializes the share-extension target (via `plugins/with-share-extension`) and ensures `ios/` reflects the current `app.json`. Safe to re-run — won't blow away non-generated files.

### L4. Archive in Xcode

```sh
open ios/TripPocket.xcworkspace
```

- Scheme: **Trip Pocket** (top-left next to play/stop).
- Destination: **Any iOS Device (arm64)** (top of the device list).
- Configuration: **Release** (Edit Scheme → Run / Archive → Build Configuration).
- **Product → Archive**.

The first archive takes ~10 min (Hermes bundle + native compile + dSYM generation). Subsequent archives are faster with cache hits.

When complete, **Organizer** opens automatically with the new archive selected.

### L5. Upload to App Store Connect

In Organizer:

- Click **Distribute App** → **App Store Connect** → **Next**.
- Distribution options: defaults are fine. Check **Upload your app's symbols** (gives Apple the dSYMs).
- Distribution signing: **Automatically manage signing** (assuming Xcode is set up with your team). Confirm both `com.trippocket.app` and `com.trippocket.app.share` certificates are issued.
- **Upload**.

Upload takes ~2 min. Same processing window as the EAS path (~15–30 min until "Ready to Test").

### L6. Verify Sentry release

Same as step 6 of the EAS flow — open Sentry → Releases, confirm `com.trippocket.app@<version>+<buildNumber>` appears within a few minutes. The Xcode build phase that the Sentry plugin patched should have uploaded JS sourcemaps + native dSYMs automatically.

If the release didn't appear, the most common cause is `SENTRY_AUTH_TOKEN` not being in the shell env at archive time — `export $(cat .env.local | xargs)` only affects the current shell, and Xcode picks up the env from however *it* was launched. If Xcode was already open before you exported, quit and reopen it from the same shell.

### L7. Paste release notes

Same as step 5 of the EAS flow — paste `whatsnew/en-US.txt` into ASC's What to Test field once the build is processed.

---

## Troubleshooting

### `Build number is already used`

Cause: EAS' auto-increment state got out of sync with App Store Connect (rare but possible after manual deletions).

Fix:

```sh
eas build:list --platform ios --limit 5     # see what numbers EAS thinks were used
eas build --profile production --platform ios --clear-cache
```

If that's still rejected, set `ios.buildNumber` in `app.json` explicitly to a number higher than anything in ASC, run one build, then remove the field again so EAS resumes auto-increment.

### Share-extension provisioning prompt on first prod build

Expected. The share-extension target (`com.trippocket.app.share`) needs its own distribution certificate + provisioning profile. EAS will offer to generate them — accept. Subsequent builds reuse them silently.

If something goes sideways and the profile becomes invalid: `eas credentials` → iOS → `com.trippocket.app.share` → reset.

### ASC API key revoked or expired

Default key lifespan is 1 year. Symptom: `eas submit` fails with an auth error referencing the API key.

Fix: regenerate the key in App Store Connect (step 4 of bootstrap), then re-attach via `eas credentials`.

### Submit succeeds but build never appears in TestFlight

- Check email for an Apple-side rejection (export compliance, missing required device capabilities, etc.).
- Common cause for a brand-new app: missing required screenshots or app icon at certain sizes. Internal TestFlight is more lenient than App Store submission, but if Apple flags it, the email tells you what's missing.

---

## What this runbook deliberately does **not** cover

- Apple Beta App Review (only matters when adding external testers — separate sub-project).
- App Privacy nutrition labels, Privacy Policy URL, App Store screenshots, App Store description — those are App Store launch (v1.0), not TestFlight.
- Crash reporting / Sentry sourcemap upload — separate v0.3 sub-project. When that lands, this runbook's step-3 build command will gain a prebuild hook; update here at that time.
- EAS Workflows automation. Trigger is manual until cadence makes it painful.
