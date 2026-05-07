# Trip Pocket

iOS-first travel-screenshot inbox. See `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`.

---

## Prerequisites (one-time)

- Xcode (App Store)
- Watchman + CocoaPods: `brew install watchman cocoapods`
- Node deps: `npm install`
- Apple ID added to Xcode (Settings → Accounts) — Personal Team is fine
- Signing teams set on both targets in Xcode: open `ios/TripPocket.xcworkspace`, for each of `TripPocket` and `TripPocketShare`, Signing & Capabilities → Automatically manage signing → Team = your Personal Team

> Free Personal Team certs expire after 7 days; you'll need to redeploy weekly during development.

---

## Build & install on iPhone (when native code changes)

Plug iPhone in via USB, unlock it, trust the Mac if prompted.

```sh
npx expo run:ios --device
```

Pick your iPhone from the list. First build is ~5–10 minutes; subsequent incremental builds are faster.

Run this whenever **native** code or config changes:

- Anything in `native/ShareExtension/`
- `plugins/with-share-extension.js`
- `app.json` entitlements / bundle ids
- A new native dep added to `package.json`

JS-only changes don't need a rebuild — just keep Metro running (next section).

---

## Run Metro (day-to-day JS iteration)

In a separate terminal:

```sh
npx expo start --dev-client --tunnel --clear
```

- `--dev-client` serves to your installed Trip Pocket app (not Expo Go)
- `--tunnel` exposes Metro via ngrok so the iPhone connects regardless of network (Wi-Fi mismatch, mobile data, VPN)
- `--clear` wipes Metro's cache (use when JS behaves weird; drop on subsequent runs for faster startup)

Once it's printing the QR code, open the iPhone Camera app, point at the QR, tap the banner. Or shake the phone in Trip Pocket → Enter URL manually → paste the `exp://...` URL.

Same Wi-Fi, no VPN? Drop `--tunnel` for faster startup:

```sh
npx expo start --dev-client --clear
```

---

## Manual smoke tests (share extension trip picker)

After installing a build that touched `native/ShareExtension/`:

1. **Fresh install** — delete the app, reinstall, do not create any trips. Photos → share a screenshot to Trip Pocket → picker shows Inbox only → tap → extension dismisses. Open Trip Pocket → screenshot is in Inbox.
2. **With trips** — create 2–3 trips in-app → share a screenshot → picker shows Inbox + alphabetical trips → tap a trip → extension dismisses. Open Trip Pocket → screenshot on that trip.
3. **Inbox path** — share another, tap Inbox → screenshot in Inbox.
4. **Cancel path** — share another, tap Cancel → no row written, no image copied.
5. **Repeatability** — share three different screenshots in a row, all to the same trip → all three on that trip.

Ingestion runs automatically on app foreground — opening Trip Pocket is what drains `pending_imports`.

---

## Tests

```sh
npx jest
```

43 tests across `modules/capture/` and `modules/storage/`. The share-extension Swift code has no unit tests by design — verified end-to-end via the smoke tests above.

---

## Troubleshooting

**"No development servers found"** — Metro isn't running or unreachable. Start `npx expo start --dev-client --tunnel --clear` in a separate terminal, then scan the QR or paste the URL on the device.

**`CommandError: failed to start tunnel` / `remote gone away`** — transient ngrok issue. Retry, drop `--tunnel` if iPhone + Mac are on the same Wi-Fi, or `npm install --save-dev @expo/ngrok` if the package is missing.

**`Cannot read properties of undefined (reading 'body')` from Metro** — stale cache. Reset:

```sh
lsof -ti:8081 | xargs kill -9 2>/dev/null
watchman watch-del "$(pwd)" && watchman watch-project "$(pwd)"
rm -rf $TMPDIR/metro-* $TMPDIR/haste-map-* node_modules/.cache
npx expo start --dev-client --clear
```

**Code-signing errors on the share-extension target** — open `ios/TripPocket.xcworkspace` in Xcode, select `TripPocketShare` → Signing & Capabilities → confirm the team is your Personal Team and "Automatically manage signing" is on.

**Stale Swift / plugin code after `expo run:ios`** — clean prebuild, then rebuild:

```sh
npx expo prebuild --platform ios --clean
npx expo run:ios --device
```

---

## Project layout

```
app/                  Expo Router screens
modules/storage/      SQLite repos (trips, screenshots, pending_imports)
modules/capture/      ingest + image import
native/ShareExtension/  Swift share extension (Photos → app)
plugins/              Expo config plugins
docs/                 product / architecture / roadmap / phase plans
```
