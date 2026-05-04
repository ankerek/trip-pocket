# Phase 1 — "Hello, screenshot"

First implementation phase for Trip Pocket. Companion to ARCHITECTURE.md (the *how*) and ROADMAP.md (the *when*) — this is *what's in the first slice of code*.

## Goal

> I can share a screenshot to Trip Pocket from Photos, and see it later in a list view on my own phone, repeatably.

This is the smallest end-to-end loop. No trips UI, no OCR, no tagging, no AI, no delete — just capture → store → list.

## Why this slice

The share extension is the single riskiest piece of the architecture: custom Swift target, App Group container, cross-process SQLite, EAS build with an extra iOS target. We want to prove that path while there's nothing else to debug. A scaffold-only Phase 1 would feel like progress but tells us nothing about whether the architecture survives contact with iOS.

## Definition of done

- Dev build runs on my own iPhone via EAS, repeatably, without re-signing every time.
- Tapping Share on a screenshot in Photos shows "Trip Pocket" as a destination.
- Tapping it copies the image into the app's storage and dismisses cleanly.
- Opening the app shows the saved screenshot in a list/grid.
- Closing and reopening the app still shows it.
- I do this 3+ times in a row with no manual recovery steps.

## In scope

- Expo project scaffolded against the architecture (TypeScript, Expo prebuild, EAS dev profile only).
- The three-module skeleton: `app/`, `modules/storage/`, `modules/capture/`. Other modules deferred.
- `modules/storage`: `expo-sqlite` initialization, one migration creating the **full** schema from ARCHITECTURE.md (not a slimmed version), and a tiny `screenshots` repository (`insert`, `list`).
- One hard-coded "Inbox" semantic: `trip_id = NULL`. No `trips` table writes yet.
- `modules/capture`: an `ingestPendingImports()` function called on app foreground.
- `native/ShareExtension/` (Swift): custom share extension target, App Group setup, image copy, `pending_imports` row write. **No trip picker UI yet** — the extension hard-codes Inbox (one button: "Save to Trip Pocket").
- One screen in `app/` showing the list.
- `useLiveQuery` minimum viable implementation (the event-bus fallback is acceptable if `expo-sqlite`'s update-hook API isn't ready).

## Out of scope

- Trip creation, trip picker UI, manual assign-to-trip → Phase 2.
- "Add from camera roll" inside the app → Phase 2.
- Tap-to-view detail screen → Phase 2.
- Delete → Phase 2.
- OCR / Vision wrapper → v0.2.
- AI extraction → v0.2.
- Auto-detect / `ScreenshotObserver` → v0.2.
- Trip rename, settings, empty states → Phase 3.
- Onboarding → v0.3.
- Sentry / PostHog → v0.3 / v1.0.
- RevenueCat / paywall → v1.0.

## Locked decisions

- **SQLite from day 1.** Files + JSON index would be smaller in Phase 1 but throwaway when v0.2 needs FTS. `expo-sqlite` is one dep; the storage module's bones get written now even if only one table is read or written.
- **Custom Swift share extension, not a community package.** The whole point of Phase 1 is de-risking the share extension. Building the custom target now means Phase 2's trip picker is "add SwiftUI to a working target," not a forklift swap.
- **EAS dev profile only.** Preview / production profiles wait for v0.3 / v1.0. One profile, one signing identity (Personal Team is fine).
- **Schema is the full ARCHITECTURE.md schema.** All columns are added in Phase 1's migration — including ones no code reads or writes yet (`ocr_status`, `extraction_status`, etc.). Migrations are linear; better to stamp the full shape now than to migrate twice.
- **No trip picker in the extension yet.** The extension hard-codes Inbox until Phase 2. This keeps the Swift surface in Phase 1 to "image copy + DB write," not "image copy + DB write + UI + cross-process trip read."

## Tracks of work

Rough order. Some steps can run in parallel; numbering is sequencing intent, not dependency-strict.

1. **Setup.** Install Xcode, Watchman, CocoaPods, EAS CLI. Apple Developer free tier configured in Xcode. Expo account created.
2. **Scaffold.** `npx create-expo-app`, TypeScript strict, ESLint, Prettier, NativeWind, Expo Router, EAS dev profile. Smoke test: blank app builds and runs on simulator and physical iPhone.
3. **Storage module skeleton.** `expo-sqlite` setup, migrations runner, full-schema migration, `screenshots` repository (insert + list).
4. **List screen.** Single screen using `useLiveQuery` against `screenshots`. Bare empty state ("No screenshots yet — share one from Photos.") is enough.
5. **Share extension target.** Add the iOS Share Extension target via a config plugin. Configure the App Group. Custom Swift UI (one button: "Save to Trip Pocket"). On tap: copy image to App Group container, write `pending_imports` row.
6. **Ingestion handoff.** `modules/capture.ingestPendingImports()` called on app foreground. Reads `pending_imports`, moves images to main app sandbox, writes `screenshots` rows, deletes the pending row.
7. **End-to-end smoke test.** Real screenshot, real iPhone, repeated 3+ times. Definition of done achieved.

## Risks to watch

- **EAS build with a share extension target.** Adding an extra iOS target via config plugin is well-trodden but easy to misconfigure. Budget time for at least one EAS build cycle to fail and need debugging.
- **App Group container.** The shared path is opaque to Swift; making the same path visible to both the extension and the main app requires the entitlement on both targets *and* an exact match on the group identifier.
- **SQLite cross-process access.** Two processes (extension + main app) writing to the same SQLite file is supported but requires WAL mode and care with concurrent transactions. In Phase 1 the extension only writes `pending_imports`, so contention is minimal — but worth keeping the surface narrow.
- **`expo-sqlite` live updates.** If the API isn't there or is flaky, fall back to the event-bus version. Don't sink time into making it work — the hook signature is the same either way.

## Pre-reqs (one-time, before track 2)

- Install Xcode from the App Store.
- `brew install watchman cocoapods`
- `npm i -g eas-cli`
- Sign into Apple ID in Xcode → Settings → Accounts (Personal Team is fine for Phase 1).
- Create an Expo account at expo.dev.

## Identifiers to lock before track 5

- **Bundle identifier:** `com.trippocket.app` (suggested) and `com.trippocket.app.shareextension` for the extension target. Free Apple Developer accounts can use any identifier.
- **App Group identifier:** `group.com.trippocket.shared` per ARCHITECTURE.md.

## Next phase

**Phase 2 — "Trips, properly."** Trip CRUD, trip-picker UI in both the share extension and the app, manual camera-roll import, tap-to-view detail, delete. After Phase 2 the v0.1 "Now" + "Next" buckets are done.
