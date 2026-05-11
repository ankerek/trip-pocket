# v0.3 Error-Handling Pass — Design

**Date:** 2026-05-11
**Milestone:** v0.3 (TestFlight beta)
**Status:** spec — design approved 2026-05-11

## Why

v0.3's definition of done is "5–10 friends are using it on TestFlight, app is crash-free for a week, I have a list of real-user feedback." Crash reporting (Sentry) and the TestFlight pipeline shipped in the previous sub-projects. This pass closes the three error paths the roadmap calls out for v0.3:

- **Failed share-sheet import** — today the extension silently calls `cancel()` on any failure path. The user assumes their screenshot saved.
- **Failed camera-roll import** — `pickPhotosForImport` counts failures but only fires a haptic. No message on partial or total failure.
- **Denied Photos permission** — `expo-image-picker` returns `result.canceled` for both real cancellation and a denied prompt. After a one-time denial, iOS will not re-prompt and the user cannot recover without help.
- **Storage full** — listed in roadmap. Realistically rare on iOS but a friend hitting it during the beta would be silent today.

The wedge here is *user trust*. A friend who taps share and sees nothing happen will assume the app is broken and stop. Surfacing failures is the cheapest way to keep them in the loop.

## Scope

In:
- Share-sheet import failures (Swift, in the extension UI).
- Camera-roll import failures and partial-failure summaries.
- Photos permission denial with a recovery path (Open Settings).
- Storage-full detection on import write, surfaced as a distinct error.
- A reusable toast primitive for non-blocking errors (and any future success/info confirmations).

Out (explicit non-goals for this pass):
- Destructive-action Alerts (delete trip, remove from trip, rename, etc.) — these already work and are correctly modal.
- Extraction / enrichment pipeline errors — already classified for the worker retry loop; not user-surfaced by design.
- A generic global error boundary — Sentry already captures crashes.
- Empty-state copy, onboarding, accessibility pass, app icon — separate v0.3 line items.
- Android. iOS-first per the roadmap.
- Background re-check when the user toggles Photos permission while suspended. Re-check on next capture tap is sufficient.

## UX decisions

| Decision | Choice |
|---|---|
| Surface style | **Mixed.** `Alert.alert` for *actionable* errors (permission denied with Open Settings deeplink); non-blocking toast for *partial / silent* failures ("3 of 12 didn't import"). |
| Share-extension failure UX | **Inline error in `TripPickerView`** with Retry / Cancel. The user is still looking at the sheet — that's the most discoverable place. |
| Storage-full detection | **Catch + classify** on write failure. No pre-flight free-space check. |
| Permission denial flow | **Pre-check** `ImagePicker.getMediaLibraryPermissionsAsync()` before launching the picker. If `canAskAgain`, prompt natively. Otherwise show `Alert.alert` with **Open Settings** + **Not now**. `'limited'` counts as granted. |

## Architecture

Five units, each independently testable.

### 1. Toast service — `lib/toast/toast.ts` + `components/ErrorToast.tsx`

Imperative emitter + root-mounted view. Modules can fire toasts without React context plumbing.

```ts
// lib/toast/toast.ts
export type ToastAction = { label: string; onPress: () => void };
export type ToastKind = 'error' | 'success';
export type ToastInput = {
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  durationMs?: number; // defaults: 5000 (no action) / 8000 (with action)
};

export function showToast(input: ToastInput): void;
export function dismissToast(): void;

// React-side: provider mounts a subscriber via this hook (internal).
export function useToastSubscription(): Toast | null;
```

**Behavior:**
- Single-slot. A new toast replaces the current one immediately. No queue.
- Bottom-anchored. Uses `useSafeAreaInsets()` for the bottom offset; sits above the NativeTab bar and above any modal stack (mounted at the root layout, outside the `<Stack>`).
- Auto-dismiss after `durationMs` (default 5s, 8s with an action).
- Tap message → dismiss. Tap action label → run `action.onPress()`, then dismiss.
- Accessibility: `accessibilityRole="alert"`, `accessibilityLiveRegion="polite"` (VoiceOver announces the message).

**Theme tokens:**
- Reuses existing `infoBg` / `infoText` for `kind: 'success'`.
- Adds `dangerBg` / `dangerText` to `tw/theme.ts` (light + dark) for `kind: 'error'`. Suggested values: light `#fee2e2` / `#991b1b`, dark `#3f1d1d` / `#fca5a5`. Verify contrast in the design pass.

**Internals:** the module exports `showToast` and `dismissToast` plus a private `subscribe(listener)` consumed by `useToastSubscription`. State is `let current: Toast | null = null` and a `Set<Listener>`. No external state library.

### 2. Photos permission helper — `lib/permissions/photos.ts`

```ts
export type PhotosAccess = 'granted' | 'denied';
// Side effect: shows Alert.alert with Open Settings when permission is
// already denied and iOS won't let us re-prompt.
export async function ensurePhotosAccess(): Promise<PhotosAccess>;
```

**Flow:**
1. `getMediaLibraryPermissionsAsync()`.
2. `status === 'granted'` (incl. `'limited'`) → return `'granted'`.
3. `canAskAgain === true` → call `requestMediaLibraryPermissionsAsync()`. Return based on result.
4. Otherwise → show `Alert.alert`:
   - Title: **"Photos access is off"**
   - Body: **"Trip Pocket needs photo access to add screenshots. Turn it on in Settings."**
   - Buttons: **Open Settings** (`Linking.openSettings()`), **Not now** (style `'cancel'`).
   - Always returns `'denied'`. Opening Settings is fire-and-forget — user retries capture on return.

`'restricted'` (parental controls) is treated the same as `'denied'` in this pass.

### 3. Capture error classifier — `lib/errors/captureErrors.ts`

Pure function. No I/O.

```ts
export type CaptureErrorKind = 'storage-full' | 'unknown';

export function classifyImportError(err: unknown): CaptureErrorKind;
```

**Detection:** match (case-insensitive) on the error's `code`, `message`, or stringified form for any of:
- `ENOSPC`
- `NSFileWriteOutOfSpaceError` (Cocoa file write, no space)
- Cocoa error code `640` (volume full) / `642` (file write out of space)
- substrings `"no space"`, `"out of space"`, `"out of storage"`, `"database or disk is full"` (SQLite full-disk error from `insertSource`)

Anything not matching is `'unknown'`. We do not classify network / extraction / enrichment errors here — those have their own taxonomy in the worker pipeline.

### 4. `components/pickPhotos.ts` — wire-up updates

```ts
type Outcome = {
  imported: number;
  failed: number;
  storageFull: number;
  denied: boolean;
};
```

**Changes:**
1. Before `launchImageLibraryAsync`, call `ensurePhotosAccess()`. If `'denied'`, return `{ imported: 0, failed: 0, storageFull: 0, denied: true }`. No toast — the Alert already explained it.
2. Per-asset `catch` calls `classifyImportError(err)`. If `'storage-full'`, increment `storageFull` and `failed`. Stop processing remaining assets in the batch on the first storage-full (further writes will also fail).
3. After the loop, fire exactly one toast based on outcome:
   - `denied` → none.
   - `imported > 0 && failed === 0` → none. (Silent success; the existing in-app live query updates the grid.)
   - `storageFull > 0` → `{ kind: 'error', message: "Your device is out of storage" }`. No action — iOS does not allow a deeplink to Storage settings (`Linking.openSettings()` only opens the app's own settings page, which is not what the user needs here).
   - `failed > 0 && imported > 0` → `{ kind: 'error', message: "${failed} of ${total} photos didn't import" }`.
   - `failed > 0 && imported === 0` → `{ kind: 'error', message: "Couldn't import photos" }`.
4. Existing haptic logic stays.

### 5. Share extension — `native/ShareExtension/`

**`TripPickerView.swift`** gets an inline error state.

```swift
@State private var saveError: SaveError? = nil

enum SaveError { case noImage, writeFailed }
```

When `saveError != nil`, the picker UI is replaced (or overlaid) with:
- Icon + heading **"Couldn't save"**
- Body: error-specific copy ("This share didn't include an image we can read." / "Trip Pocket couldn't save the screenshot. Try again, or open Trip Pocket if the problem keeps happening.")
- Buttons: **Retry** (re-runs the save flow) / **Cancel** (calls extension `cancel()`).

**`ShareViewController.swift`** changes:
- Lift the `handleSave` body into a method the SwiftUI view can re-invoke. The view holds a closure passed in via `TripPickerView(onSave:onCancel:)`.
- On the three failure paths (`item == nil`, `materializeImage == nil`, `PendingImportWriter().write` throws), don't call `cancel()`. Instead, dispatch to main and set the view's `saveError` via a callback the view passes in (extend constructor: `onError: (SaveError) -> Void`, or thread a binding). The view shows the error UI; the user picks Retry or Cancel.
- `Retry` re-runs the same `handleSave` with the previously-picked `tripId`.
- `Cancel` invokes the existing `cancel()` path.

**Implementation notes:**
- Disambiguate "no attachment" from "image load failed": no attachment is a user-error (they shared something we can't read), and the body copy reflects that.
- Time-bound retries: don't limit them. The user is in front of the sheet and can dismiss.
- Telemetry: we *do not* add anything new for the share extension here. Sentry's React Native SDK does not cover the extension target. Adding `sentry-cocoa` to the extension is a separate sub-project if we want signal on these failures; for this pass we accept that share-extension errors are user-surfaced only.

## Wire-up summary

| Call site | Change |
|---|---|
| `app/_layout.tsx` | Mount `<ErrorToast />` once at the root (outside the `<Stack>`, inside the safe-area provider). |
| `components/pickPhotos.ts` | Add `ensurePhotosAccess()` gate; classify per-asset errors; fire one toast on outcome. |
| `components/HeaderCaptureButton.tsx` | No change — the button calls `pickPhotosForImport` which now self-handles permission + errors. |
| `modules/capture/importImage.ts` | No change. Errors propagate as today; classification happens in the caller. |
| `modules/capture/ingest.ts` | No change in this pass. Pending-imports failures keep their row and retry on next foreground; we do not toast for them here. (Revisit if a friend reports stuck pending rows.) |
| `tw/theme.ts` | Add `dangerBg` / `dangerText` for light + dark schemes. |
| `native/ShareExtension/ShareViewController.swift` | Refactor `handleSave` to report errors back to the view rather than calling `cancel()`. |
| `native/ShareExtension/TripPickerView.swift` | Add `saveError` state + error overlay with Retry / Cancel. Constructor extended with `onError` callback. |

## Data flow

```
Camera-roll path:
  HeaderCaptureButton.onPress
    → pickPhotosForImport
        → ensurePhotosAccess        [Alert.alert if denied & !canAskAgain]
        → launchImageLibraryAsync   [iOS native prompt if canAskAgain]
        → per-asset importImage     [catch → classifyImportError]
        → showToast(outcome)        [non-blocking]

Share-sheet path (in extension process):
  iOS share → ShareViewController.viewDidLoad
    → TripPickerView (SwiftUI) — user picks trip, taps Save
    → ShareViewController.handleSave
        → materializeImage / PendingImportWriter.write
        → on failure: view.onError(.writeFailed)   [inline error UI]
        → on success: extensionContext.completeRequest

Share-sheet path (in app process, later):
  AppState foreground / cold launch
    → runForegroundIngest
        → ingestPendingImports     [silent retries today, unchanged]
```

## Testing

| Unit | Test |
|---|---|
| `lib/toast/toast.ts` | Subscription receives showToast / dismissToast events; auto-dismiss timer fires after `durationMs`; replace-on-new-show behavior. |
| `components/ErrorToast.tsx` | Renders nothing when no current toast; renders message + action; tap action calls handler then dismisses; live-region attribute present. |
| `lib/permissions/photos.ts` | Three cases — granted immediately, prompt-then-grant, denied-with-alert. Mock `ImagePicker` and `Linking.openSettings`. |
| `lib/errors/captureErrors.ts` | Pure unit tests: `ENOSPC` string, `NSFileWriteOutOfSpaceError` object, Cocoa code 640/642, "no space" substring, unknown. |
| `components/pickPhotos.ts` | New tests for the outcome → toast mapping (denied, partial, total, storage-full). Existing import success path stays green. Mock `ensurePhotosAccess` and `showToast`. |
| Share extension | Manual on device. Two paths: deny sharing a non-image attachment (e.g. share a URL via a path the extension doesn't support — verifies "noImage" copy if reachable, otherwise mock by temporarily breaking `PendingImportWriter.write` in a debug build to verify the Retry UI). |

No new e2e coverage. Existing Cloudflare Worker tests and DB tests are unaffected.

## What we do NOT do

- No queue / multi-toast stacking. Single-slot is fine.
- No toast for destructive-action errors. They stay on `Alert.alert`.
- No new translation layer for extraction / enrichment errors. Those are background-pipeline classifications, not user-surfaced.
- No pre-flight disk-space check. Catch + classify is cheaper and correct enough.
- No share-extension Sentry wiring. Out of scope.
- No telemetry beyond what Sentry already captures.

## Risks

- **`dangerBg` / `dangerText` contrast** — needs a quick check against the existing Sea+Teal palette in light and dark. If the suggested values clash, pick adjusted hex values in the implementation step; the *shape* of the design doesn't change.
- **Toast above modals** — depending on where `<Stack>` modals render relative to the root, the toast may be obscured by a presented modal. Mitigation: mount the toast as the *last* child of the safe-area provider, and verify on the trip-picker / new-trip modal in a manual pass.
- **Share-extension Retry loop** — if the underlying failure is permanent (e.g. corrupt image), Retry will fail again. Acceptable; the user has Cancel.
- **Storage-full classifier brittle to error strings** — Expo's filesystem and `expo-sqlite` may produce platform-specific messages. Mitigation: classifier matches multiple substrings + codes. If a friend hits a miss, add their string in a follow-up commit.

## Out-of-scope follow-ups (for later milestones)

- Share-extension Sentry instrumentation (separate sub-project if friends report silent failures).
- Toast queue / stacking if the app grows multiple concurrent non-blocking notifications.
- Pending-import retry surfacing (today's silent ingest is fine; revisit if rows wedge).
- Pre-flight free-space check if real-world storage-full hits become a pattern.
