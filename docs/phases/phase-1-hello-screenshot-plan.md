# Phase 1 Implementation Plan — "Hello, screenshot"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the smallest end-to-end loop for Trip Pocket — share a screenshot from Photos, see it later in a list view on a real iPhone — proving the custom Swift share-extension architecture works end-to-end.

**Architecture:** React Native via Expo (prebuild + config plugins). TypeScript on the JS side, custom Swift Share Extension target on the iOS side. SQLite (`expo-sqlite`) is the source of truth from day 1, populated by both the main app and the share extension via a shared App Group container. Cross-process handoff uses a `pending_imports` table consumed on app foreground. The architecture is laid out fully in `docs/ARCHITECTURE.md`; the spec for this phase is `docs/phases/phase-1-hello-screenshot.md`.

**Tech Stack:** Expo SDK 54+, TypeScript (strict), Expo Router, NativeWind v4 (4.2.x), `expo-sqlite`, `expo-file-system` (modern class-based API: `File`, `Paths`), Jest + `@testing-library/react-native`, Swift + SwiftUI for the share extension, EAS for builds.

---

## Verified library notes (Context7, 2026-05-04)

- **App Group access from JS is built in.** `Paths.appleSharedContainers['group.com.trippocket.shared'].uri` (from `expo-file-system`) returns the container path on iOS. No custom Expo Module needed for this.
- **Main-app App Group entitlement** is set declaratively in `app.json` under `ios.entitlements`. The Expo build pipeline writes the entitlements file. The config plugin we still need is only for adding the *extension target itself*, not for entitlements on the main app.
- **`expo-sqlite` accepts a `directory`** for the database. Combined with the App Group path, this lets the main app and the share extension read the same `trip-pocket.db` file with no extra plumbing.
- **`expo-file-system` modern API is class-based:** `new File(parent, 'name')`, `file.create()`, `file.move(target)`, `file.copy(target)`, `file.exists`, `file.uri`, `Paths.document`, `Paths.cache`. The legacy `FileSystem.documentDirectory` / `FileSystem.moveAsync` API is still importable from `expo-file-system/legacy` if needed.
- **NativeWind v4** pins are `tailwindcss@^3.4.17`, `prettier-plugin-tailwindcss@^0.5.11`.
- **Hashing for dedup** is deferred to Phase 2. Phase 1 always inserts; duplicate screenshots are rare in practice and trivially deletable once Phase 2 ships delete.

## File structure

This plan creates the following files (paths relative to repo root):

**Configuration:**
- `package.json`, `app.json`, `tsconfig.json`, `eas.json`, `babel.config.js`, `metro.config.js`, `tailwind.config.js`, `global.css`
- `.eslintrc.cjs`, `.prettierrc`, `.gitignore`
- `jest.config.js`, `jest.setup.ts`

**App / screens (Expo Router):**
- `app/_layout.tsx` — root layout
- `app/index.tsx` — the list screen (only screen in Phase 1)

**Modules:**
- `modules/storage/db.ts` — `expo-sqlite` singleton + migration runner
- `modules/storage/migrations/0001_init.ts` — full schema migration (every column from ARCHITECTURE.md)
- `modules/storage/screenshots.ts` — repository: `insertScreenshot`, `listScreenshots`
- `modules/storage/live-query.ts` — `useLiveQuery` hook
- `modules/storage/__tests__/db.test.ts`
- `modules/storage/__tests__/screenshots.test.ts`
- `modules/capture/ingest.ts` — `ingestPendingImports`
- `modules/capture/__tests__/ingest.test.ts`

**Native iOS:**
- `plugins/with-share-extension.js` — Expo config plugin
- `native/ShareExtension/Info.plist`
- `native/ShareExtension/TripPocketShare.entitlements`
- `native/ShareExtension/ShareViewController.swift`
- `native/ShareExtension/SaveButtonView.swift`
- `native/ShareExtension/PendingImportWriter.swift`

Each module file has one clear responsibility. The storage module is the *only* place that touches SQL — every other module asks it for typed objects.

---

## Tasks

### Task 1: Install system tools

**Why:** Need Xcode for any iOS development; Watchman for React Native file watching; CocoaPods for Expo prebuild; EAS CLI for builds.

**Files:** none (system).

- [ ] **Step 1: Start Xcode download (background)**

Open the Mac App Store and start downloading Xcode. ~50 GB. Continue with the other steps while it downloads.

- [ ] **Step 2: Install Watchman + CocoaPods via Homebrew**

```sh
brew install watchman cocoapods
```

- [ ] **Step 3: Install EAS CLI**

```sh
npm install -g eas-cli
```

- [ ] **Step 4: Verify Watchman + CocoaPods + EAS**

```sh
watchman --version
pod --version
eas --version
```

Expected: each prints a version, no errors.

- [ ] **Step 5: Wait for Xcode + accept license**

Once Xcode is installed:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
```

Expected: license accepted, no errors.

- [ ] **Step 6: Verify Xcode**

```sh
xcodebuild -version
```

Expected: prints Xcode version + build.

---

### Task 2: Set up accounts

**Why:** EAS needs an Expo account; sideloading to iPhone needs an Apple ID configured in Xcode (Personal Team is enough for Phase 1).

**Files:** none.

- [ ] **Step 1: Create Expo account**

Visit https://expo.dev/signup and create an account.

- [ ] **Step 2: Log in to EAS CLI**

```sh
eas login
```

Expected: prompts for email/password, succeeds.

- [ ] **Step 3: Add Apple ID in Xcode**

Open Xcode → Settings → Accounts → `+` → Apple ID. Sign in. Confirm "Personal Team" appears.

---

### Task 3: Scaffold the Expo app

**Why:** Need a working Expo + Expo Router + TypeScript project before any feature code.

**Files:**
- Create: many (Expo template generates the standard set).

- [ ] **Step 1: Scaffold the project into the existing repo**

Repo already exists with `docs/`, `.git/`, `.gitignore`. Use the Expo `default` template and merge into the current directory.

```sh
cd /Users/thanhcong.nguyen/my-apps/trip-pocket
npx create-expo-app@latest tmp-scaffold --template default
mv tmp-scaffold/{*,.[!.]*} . 2>/dev/null || true
rmdir tmp-scaffold
```

If any file conflicts (e.g., `.gitignore`), merge by hand — keep both project entries and the existing repo's entries.

- [ ] **Step 2: Verify the project boots in simulator**

```sh
npm install
npx expo start --ios
```

Expected: simulator launches, default Expo template UI appears. Press `Ctrl-C` to stop.

- [ ] **Step 3: Configure TypeScript strict**

Edit `tsconfig.json` to extend Expo's config and enable strict:

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```sh
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Add ESLint + Prettier**

```sh
npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-config-expo prettier
```

Create `.eslintrc.cjs`:

```js
module.exports = {
  root: true,
  extends: ['expo', 'prettier'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
```

Create `.prettierrc`:

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true
}
```

- [ ] **Step 6: Verify ESLint runs cleanly**

```sh
npx eslint .
```

Expected: no errors (warnings on default Expo template are acceptable).

- [ ] **Step 7: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "chore: scaffold Expo app with TS strict + ESLint + Prettier"
```

---

### Task 4: Configure NativeWind v4

**Why:** Architecture locks in NativeWind for styling. Setting it up now means every screen uses Tailwind classes from the start.

**Files:**
- Create: `tailwind.config.js`, `global.css`, `metro.config.js`, `nativewind-env.d.ts`
- Modify: `babel.config.js`, `app/_layout.tsx`

- [ ] **Step 1: Install NativeWind**

```sh
npm install nativewind react-native-reanimated react-native-safe-area-context
npm install --save-dev tailwindcss@^3.4.17 prettier-plugin-tailwindcss@^0.5.11
```

- [ ] **Step 2: Initialize Tailwind**

Create `tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './modules/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

Create `global.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create `nativewind-env.d.ts`:

```ts
/// <reference types="nativewind/types" />
```

- [ ] **Step 3: Configure Babel**

Edit `babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
  };
};
```

- [ ] **Step 4: Configure Metro**

Create `metro.config.js`:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
```

- [ ] **Step 5: Import global.css from the root layout**

Edit `app/_layout.tsx` — add at the top:

```tsx
import '../global.css';
```

- [ ] **Step 6: Smoke test NativeWind**

Edit `app/index.tsx` to use a Tailwind class:

```tsx
import { Text, View } from 'react-native';

export default function Index() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text className="text-lg font-semibold text-slate-900">Trip Pocket</Text>
    </View>
  );
}
```

Run:

```sh
npx expo start --ios --clear
```

Expected: simulator shows centered "Trip Pocket" text on white. `Ctrl-C` to stop.

- [ ] **Step 7: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "chore: add NativeWind v4"
```

---

### Task 5: Configure EAS for dev builds

**Why:** Need a dev build profile to install on a real iPhone. Phase 1 only has a `dev` profile; preview/production come at v0.3 / v1.0.

**Files:**
- Create: `eas.json`
- Modify: `app.json`

- [ ] **Step 1: Set bundle identifier and App Group entitlement**

Edit `app.json` and set:

```json
{
  "expo": {
    "name": "Trip Pocket",
    "slug": "trip-pocket",
    "ios": {
      "bundleIdentifier": "com.trippocket.app",
      "supportsTablet": false,
      "entitlements": {
        "com.apple.security.application-groups": ["group.com.trippocket.shared"]
      }
    }
  }
}
```

The `ios.entitlements` block makes the main app a member of the App Group at build time — no config plugin needed for *this* part. (The extension target itself still needs a config plugin; that's Task 14.)

- [ ] **Step 2: Run `eas init`**

```sh
eas init
```

Accept defaults. This creates the project on Expo's servers.

- [ ] **Step 3: Configure EAS profiles**

Edit `eas.json`:

```json
{
  "cli": {
    "version": ">= 12.0.0"
  },
  "build": {
    "dev": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": false
      }
    },
    "dev-sim": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": true
      }
    }
  }
}
```

`dev-sim` builds for the simulator (fast, no signing); `dev` builds for a real device.

- [ ] **Step 4: First simulator build**

```sh
eas build --profile dev-sim --platform ios --local
```

(Use `--local` to build on your Mac since you have Xcode now — much faster than cloud builds for sim.)

Expected: build succeeds, `.tar.gz` artifact appears. Drag the simulator app onto a running simulator to install.

- [ ] **Step 5: Run the dev build**

```sh
npx expo start --dev-client
```

Open the installed app on the simulator; it should connect to the dev server and show the Phase 1 screen.

- [ ] **Step 6: First device build**

Plug in your iPhone, trust the computer, then:

```sh
eas device:create
```

Follow the prompt to register the device. Then:

```sh
eas build --profile dev --platform ios --local
```

Install the resulting `.ipa` via Xcode → Window → Devices and Simulators (drag the file onto the device).

Expected: app appears on the iPhone home screen and runs.

- [ ] **Step 7: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "chore: configure EAS dev + dev-sim profiles"
```

---

### Task 6: Set up Jest

**Why:** Need a working Jest setup before the storage module's TDD steps land.

**Files:**
- Create: `jest.config.js`, `jest.setup.ts`, `__mocks__/expo-sqlite.ts`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Install Jest**

```sh
npm install --save-dev jest @types/jest jest-expo @testing-library/react-native @testing-library/jest-native ts-jest
```

- [ ] **Step 2: Add Jest config**

Create `jest.config.js`:

```js
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEach: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native|expo(nent)?|@expo|@expo/.*|nativewind|react-native-css-interop)/)',
  ],
};
```

Create `jest.setup.ts`:

```ts
import '@testing-library/jest-native/extend-expect';
```

- [ ] **Step 3: Add `test` script**

Edit `package.json` and add to `scripts`:

```json
"test": "jest",
"test:watch": "jest --watch"
```

- [ ] **Step 4: Write a smoke test**

Create `__tests__/smoke.test.ts`:

```ts
describe('jest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

```sh
npm test
```

Expected: 1 test passing.

- [ ] **Step 6: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "chore: set up Jest with jest-expo preset"
```

---

### Task 7: Storage — DB singleton + migration runner

**Why:** Every other storage feature depends on having a managed DB connection and a way to apply migrations linearly.

**Files:**
- Create: `modules/storage/db.ts`, `modules/storage/migrations/index.ts`, `modules/storage/__tests__/db.test.ts`

- [ ] **Step 1: Install expo-sqlite**

```sh
npx expo install expo-sqlite
```

- [ ] **Step 2: Write the failing test**

Create `modules/storage/__tests__/db.test.ts`:

```ts
import { openDatabase, runMigrations, getMigrationVersion } from '../db';

describe('runMigrations', () => {
  beforeEach(async () => {
    const db = await openDatabase(':memory:');
    await db.execAsync('DROP TABLE IF EXISTS schema_migrations');
  });

  it('starts at version 0 on a fresh database', async () => {
    const db = await openDatabase(':memory:');
    expect(await getMigrationVersion(db)).toBe(0);
  });

  it('applies a single migration and bumps the version', async () => {
    const db = await openDatabase(':memory:');
    const migrations = [
      {
        version: 1,
        up: async (d: typeof db) => {
          await d.execAsync('CREATE TABLE example (id TEXT PRIMARY KEY)');
        },
      },
    ];
    await runMigrations(db, migrations);
    expect(await getMigrationVersion(db)).toBe(1);
  });

  it('does not re-run migrations already applied', async () => {
    const db = await openDatabase(':memory:');
    let runs = 0;
    const migrations = [
      {
        version: 1,
        up: async (d: typeof db) => {
          runs += 1;
          await d.execAsync('CREATE TABLE example (id TEXT PRIMARY KEY)');
        },
      },
    ];
    await runMigrations(db, migrations);
    await runMigrations(db, migrations);
    expect(runs).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```sh
npm test -- modules/storage/__tests__/db.test.ts
```

Expected: FAIL — `Cannot find module '../db'`.

- [ ] **Step 4: Implement the migration runner**

Create `modules/storage/db.ts`:

```ts
import * as SQLite from 'expo-sqlite';

export type Database = SQLite.SQLiteDatabase;

export type Migration = {
  version: number;
  up: (db: Database) => Promise<void>;
};

export async function openDatabase(name = 'trip-pocket.db'): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  return db;
}

export async function getMigrationVersion(db: Database): Promise<number> {
  const row = await db.getFirstAsync<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );
  return row?.v ?? 0;
}

export async function runMigrations(db: Database, migrations: Migration[]): Promise<void> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getMigrationVersion(db);
  for (const m of sorted) {
    if (m.version <= current) continue;
    await db.withTransactionAsync(async () => {
      await m.up(db);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        m.version,
        new Date().toISOString(),
      );
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```sh
npm test -- modules/storage/__tests__/db.test.ts
```

Expected: 3 tests passing.

- [ ] **Step 6: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(storage): add DB singleton + migration runner"
```

---

### Task 8: Storage — full schema migration

**Why:** Lock in the full ARCHITECTURE.md schema in one migration so we never have to migrate the same tables twice as features land in v0.2.

**Files:**
- Create: `modules/storage/migrations/0001_init.ts`, `modules/storage/migrations/index.ts`
- Modify: `modules/storage/__tests__/db.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `modules/storage/__tests__/db.test.ts`:

```ts
import { migrations } from '../migrations';

describe('initial migration (0001)', () => {
  it('creates every Phase-1+v0.2+v1.0 table', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'trips',
        'screenshots',
        'tags',
        'extracted_places',
        'pending_imports',
        'meta',
        'schema_migrations',
      ]),
    );
  });

  it('creates the screenshots_fts virtual table', async () => {
    const db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    const row = await db.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='screenshots_fts'",
    );
    expect(row?.name).toBe('screenshots_fts');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npm test -- modules/storage/__tests__/db.test.ts
```

Expected: FAIL — `Cannot find module '../migrations'`.

- [ ] **Step 3: Write the migration**

Create `modules/storage/migrations/0001_init.ts`:

```ts
import type { Migration } from '../db';

export const init: Migration = {
  version: 1,
  up: async (db) => {
    await db.execAsync(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        color TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE screenshots (
        id TEXT PRIMARY KEY NOT NULL,
        trip_id TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('share','auto','manual')),
        ocr_status TEXT NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending','done','failed')),
        ocr_text TEXT,
        extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','done','failed')),
        captured_at TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (trip_id) REFERENCES trips(id)
      );

      CREATE INDEX idx_screenshots_trip ON screenshots(trip_id) WHERE deleted_at IS NULL;
      CREATE INDEX idx_screenshots_captured_at ON screenshots(captured_at DESC) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX idx_screenshots_hash ON screenshots(content_hash) WHERE deleted_at IS NULL;

      CREATE TABLE tags (
        id TEXT PRIMARY KEY NOT NULL,
        screenshot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('place','food','activity')),
        value TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (screenshot_id) REFERENCES screenshots(id)
      );

      CREATE TABLE extracted_places (
        id TEXT PRIMARY KEY NOT NULL,
        screenshot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        city TEXT,
        category TEXT,
        raw_text TEXT,
        confidence REAL,
        extraction_model TEXT,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (screenshot_id) REFERENCES screenshots(id)
      );

      CREATE TABLE pending_imports (
        id TEXT PRIMARY KEY NOT NULL,
        app_group_path TEXT NOT NULL,
        suggested_trip_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );

      CREATE VIRTUAL TABLE screenshots_fts USING fts5(
        screenshot_id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );
    `);
  },
};
```

Create `modules/storage/migrations/index.ts`:

```ts
import type { Migration } from '../db';
import { init } from './0001_init';

export const migrations: Migration[] = [init];
```

- [ ] **Step 4: Run the test to verify it passes**

```sh
npm test -- modules/storage/__tests__/db.test.ts
```

Expected: all tests passing.

- [ ] **Step 5: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(storage): add initial schema migration"
```

---

### Task 9: Storage — screenshots repository

**Why:** Phase 1 needs `insertScreenshot` (called by ingestion) and `listScreenshots` (called by the list screen). These are the only two methods the rest of Phase 1 needs.

**Files:**
- Create: `modules/storage/screenshots.ts`, `modules/storage/__tests__/screenshots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `modules/storage/__tests__/screenshots.test.ts`:

```ts
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { insertScreenshot, listScreenshots } from '../screenshots';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

describe('screenshots repository', () => {
  it('inserts a screenshot and returns it from listScreenshots', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      contentHash: 'hash-a',
      source: 'share',
      capturedAt: '2026-05-04T10:00:00Z',
      ownerId,
    });
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a',
      tripId: null,
      filePath: '/sandbox/a.jpg',
      source: 'share',
    });
  });

  it('lists screenshots ordered newest first by captured_at', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await insertScreenshot(db, {
      id: 'b',
      tripId: null,
      filePath: '/x/b.jpg',
      contentHash: 'h-b',
      source: 'share',
      capturedAt: '2026-05-04T00:00:00Z',
      ownerId,
    });
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('filters out soft-deleted screenshots', async () => {
    const db = await freshDb();
    await insertScreenshot(db, {
      id: 'a',
      tripId: null,
      filePath: '/x/a.jpg',
      contentHash: 'h-a',
      source: 'share',
      capturedAt: '2026-05-01T00:00:00Z',
      ownerId,
    });
    await db.runAsync(
      'UPDATE screenshots SET deleted_at = ? WHERE id = ?',
      '2026-05-04T00:00:00Z',
      'a',
    );
    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npm test -- modules/storage/__tests__/screenshots.test.ts
```

Expected: FAIL — `Cannot find module '../screenshots'`.

- [ ] **Step 3: Implement the repository**

Create `modules/storage/screenshots.ts`:

```ts
import type { Database } from './db';

export type ScreenshotSource = 'share' | 'auto' | 'manual';

export type Screenshot = {
  id: string;
  tripId: string | null;
  filePath: string;
  contentHash: string;
  source: ScreenshotSource;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrText: string | null;
  extractionStatus: 'pending' | 'done' | 'failed';
  capturedAt: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertScreenshotInput = {
  id: string;
  tripId: string | null;
  filePath: string;
  contentHash: string;
  source: ScreenshotSource;
  capturedAt: string;
  ownerId: string;
};

export async function insertScreenshot(
  db: Database,
  input: InsertScreenshotInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO screenshots (
      id, trip_id, file_path, content_hash, source,
      ocr_status, extraction_status, captured_at,
      owner_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`,
    input.id,
    input.tripId,
    input.filePath,
    input.contentHash,
    input.source,
    input.capturedAt,
    input.ownerId,
    now,
    now,
  );
}

type Row = {
  id: string;
  trip_id: string | null;
  file_path: string;
  content_hash: string;
  source: ScreenshotSource;
  ocr_status: 'pending' | 'done' | 'failed';
  ocr_text: string | null;
  extraction_status: 'pending' | 'done' | 'failed';
  captured_at: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

function rowToScreenshot(r: Row): Screenshot {
  return {
    id: r.id,
    tripId: r.trip_id,
    filePath: r.file_path,
    contentHash: r.content_hash,
    source: r.source,
    ocrStatus: r.ocr_status,
    ocrText: r.ocr_text,
    extractionStatus: r.extraction_status,
    capturedAt: r.captured_at,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listScreenshots(
  db: Database,
  filter: { tripId: string | null },
): Promise<Screenshot[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT id, trip_id, file_path, content_hash, source,
            ocr_status, ocr_text, extraction_status, captured_at,
            owner_id, created_at, updated_at
       FROM screenshots
      WHERE deleted_at IS NULL
        AND ((? IS NULL AND trip_id IS NULL) OR trip_id = ?)
   ORDER BY captured_at DESC`,
    filter.tripId,
    filter.tripId,
  );
  return rows.map(rowToScreenshot);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```sh
npm test -- modules/storage/__tests__/screenshots.test.ts
```

Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(storage): add screenshots repository"
```

---

### Task 10: Storage — `useLiveQuery` hook

**Why:** The list screen needs to re-render when ingestion writes new rows. We use `expo-sqlite`'s update hook if available; the architecture allows the event-bus fallback if it's flaky.

**Files:**
- Create: `modules/storage/live-query.ts`, `modules/storage/__tests__/live-query.test.ts`

- [ ] **Step 1: Write the failing test**

Create `modules/storage/__tests__/live-query.test.ts`:

```ts
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { openDatabase, runMigrations, type Database } from '../db';
import { migrations } from '../migrations';
import { insertScreenshot } from '../screenshots';
import { provideDatabase, useLiveQuery, notifyChange } from '../live-query';

describe('useLiveQuery', () => {
  let db: Database;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    await runMigrations(db, migrations);
    provideDatabase(db);
  });

  it('returns the initial query result', async () => {
    const { result } = renderHook(() =>
      useLiveQuery<{ count: number }>(
        'SELECT COUNT(*) AS count FROM screenshots',
        [],
        ['screenshots'],
      ),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.[0]?.count).toBe(0);
  });

  it('re-runs the query after notifyChange("screenshots")', async () => {
    const { result } = renderHook(() =>
      useLiveQuery<{ count: number }>(
        'SELECT COUNT(*) AS count FROM screenshots',
        [],
        ['screenshots'],
      ),
    );
    await waitFor(() => expect(result.current?.[0]?.count).toBe(0));
    await act(async () => {
      await insertScreenshot(db, {
        id: 'a',
        tripId: null,
        filePath: '/x/a.jpg',
        contentHash: 'h',
        source: 'share',
        capturedAt: '2026-05-04T00:00:00Z',
        ownerId: 'owner',
      });
      notifyChange('screenshots');
    });
    await waitFor(() => expect(result.current?.[0]?.count).toBe(1));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npm test -- modules/storage/__tests__/live-query.test.ts
```

Expected: FAIL — `Cannot find module '../live-query'`.

- [ ] **Step 3: Implement the hook (event-bus version)**

Create `modules/storage/live-query.ts`:

```ts
import { useEffect, useState } from 'react';
import type { Database } from './db';

let database: Database | null = null;
const listeners = new Map<string, Set<() => void>>();

export function provideDatabase(db: Database): void {
  database = db;
}

function getDatabase(): Database {
  if (!database) throw new Error('Database not provided. Call provideDatabase() at app boot.');
  return database;
}

export function notifyChange(table: string): void {
  listeners.get(table)?.forEach((fn) => fn());
}

function subscribe(tables: string[], fn: () => void): () => void {
  for (const t of tables) {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  }
  return () => {
    for (const t of tables) {
      listeners.get(t)?.delete(fn);
    }
  };
}

export function useLiveQuery<Row>(
  sql: string,
  params: unknown[],
  tables: string[],
): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await getDatabase().getAllAsync<Row>(sql, ...params);
      if (!cancelled) setRows(result);
    };
    run();
    const unsubscribe = subscribe(tables, run);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, JSON.stringify(params), tables.join(',')]);

  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```sh
npm test -- modules/storage/__tests__/live-query.test.ts
```

Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(storage): add useLiveQuery hook with event-bus invalidation"
```

> **Note:** The architecture also describes an `expo-sqlite` update-hook variant. We can promote later by replacing the implementation behind the same hook signature without touching consumers. Defer until we have a real reason.

---

### Task 11: List screen wired to live query

**Why:** Phase 1's only screen — shows what's been saved.

**Files:**
- Create: `modules/storage/index.ts` (barrel for the module)
- Modify: `app/_layout.tsx`, `app/index.tsx`

- [ ] **Step 1: Add a storage barrel for clean imports**

Create `modules/storage/index.ts`:

```ts
export { openDatabase, runMigrations } from './db';
export { migrations } from './migrations';
export { insertScreenshot, listScreenshots, type Screenshot } from './screenshots';
export { provideDatabase, useLiveQuery, notifyChange } from './live-query';
```

- [ ] **Step 2: Initialize the DB in the root layout**

Replace `app/_layout.tsx` with:

```tsx
import '../global.css';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { openDatabase, runMigrations, migrations, provideDatabase } from '@/modules/storage';

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const db = await openDatabase();
      await runMigrations(db, migrations);
      provideDatabase(db);
      setReady(true);
    })();
  }, []);

  if (!ready) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 3: Replace the index screen with the list view**

Replace `app/index.tsx` with:

```tsx
import { FlatList, Image, SafeAreaView, Text, View } from 'react-native';
import { useLiveQuery } from '@/modules/storage';

type Row = {
  id: string;
  file_path: string;
  captured_at: string;
};

export default function Index() {
  const rows = useLiveQuery<Row>(
    `SELECT id, file_path, captured_at
       FROM screenshots
      WHERE deleted_at IS NULL AND trip_id IS NULL
   ORDER BY captured_at DESC`,
    [],
    ['screenshots'],
  );

  if (rows === null) return null;

  if (rows.length === 0) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <Text className="px-8 text-center text-base text-slate-500">
          No screenshots yet — share one from Photos.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Text className="px-4 pb-2 pt-4 text-2xl font-semibold text-slate-900">Inbox</Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerClassName="p-2"
        renderItem={({ item }) => (
          <View className="w-1/2 p-1">
            <Image
              source={{ uri: 'file://' + item.file_path }}
              className="aspect-[3/4] w-full rounded-lg bg-slate-100"
              resizeMode="cover"
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}
```

- [ ] **Step 4: Smoke test the empty state**

```sh
npx expo start --dev-client --clear
```

Open the dev build on simulator. Expected: empty-state copy "No screenshots yet — share one from Photos."

- [ ] **Step 5: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(app): list screen wired to useLiveQuery"
```

---

### Task 12: Capture — `ingestPendingImports`

**Why:** Cross-process handoff. The share extension writes a row to `pending_imports`; this function (called on app foreground) drains the table into real `screenshots` rows.

**Files:**
- Create: `modules/capture/ingest.ts`, `modules/capture/__tests__/ingest.test.ts`, `modules/capture/index.ts`

- [ ] **Step 1: Install expo-file-system + uuid**

```sh
npx expo install expo-file-system
npm install uuid
npm install --save-dev @types/uuid
```

> **Note:** Phase 1 always inserts and does not dedup by content hash. Hashing is deferred to Phase 2 alongside delete and the OCR pipeline (which both benefit from real dedup). Duplicate screenshots in Phase 1 are rare and visually obvious; the user can delete them once Phase 2 ships delete.

- [ ] **Step 2: Write the failing test**

Create `modules/capture/__tests__/ingest.test.ts`:

```ts
import { openDatabase, runMigrations, type Database } from '@/modules/storage/db';
import { migrations } from '@/modules/storage/migrations';
import { listScreenshots } from '@/modules/storage/screenshots';
import { ingestPendingImports } from '../ingest';

const ownerId = '00000000-0000-0000-0000-000000000001';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await runMigrations(db, migrations);
  return db;
}

const fakeFs = {
  moveFile: jest.fn(async (_from: string, _to: string) => undefined),
};

describe('ingestPendingImports', () => {
  beforeEach(() => {
    fakeFs.moveFile.mockClear();
  });

  it('drains a pending import into a screenshots row', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES (?, ?, NULL, ?)`,
      'p1',
      '/appgroup/img1.jpg',
      '2026-05-04T10:00:00Z',
    );

    await ingestPendingImports(db, {
      ownerId,
      sandboxDir: '/sandbox',
      fs: fakeFs,
    });

    const rows = await listScreenshots(db, { tripId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filePath: expect.stringContaining('/sandbox/'),
      source: 'share',
      tripId: null,
    });

    const remaining = await db.getAllAsync('SELECT * FROM pending_imports');
    expect(remaining).toEqual([]);
    expect(fakeFs.moveFile).toHaveBeenCalledTimes(1);
  });

  it('drains multiple pending imports in created_at order', async () => {
    const db = await freshDb();
    await db.runAsync(
      `INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
       VALUES ('p2', '/appgroup/b.jpg', NULL, '2026-05-04T10:00:01Z'),
              ('p1', '/appgroup/a.jpg', NULL, '2026-05-04T10:00:00Z')`,
    );

    await ingestPendingImports(db, {
      ownerId,
      sandboxDir: '/sandbox',
      fs: fakeFs,
    });

    expect(fakeFs.moveFile).toHaveBeenCalledTimes(2);
    expect(fakeFs.moveFile.mock.calls[0]?.[0]).toBe('/appgroup/a.jpg');
    expect(fakeFs.moveFile.mock.calls[1]?.[0]).toBe('/appgroup/b.jpg');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```sh
npm test -- modules/capture/__tests__/ingest.test.ts
```

Expected: FAIL — `Cannot find module '../ingest'`.

- [ ] **Step 4: Implement `ingestPendingImports`**

Create `modules/capture/ingest.ts`:

```ts
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@/modules/storage/db';
import { insertScreenshot } from '@/modules/storage/screenshots';
import { notifyChange } from '@/modules/storage/live-query';

type FsLike = {
  moveFile: (from: string, to: string) => Promise<void>;
};

export type IngestOptions = {
  ownerId: string;
  sandboxDir: string;
  fs: FsLike;
};

export async function ingestPendingImports(
  db: Database,
  opts: IngestOptions,
): Promise<void> {
  const pending = await db.getAllAsync<{
    id: string;
    app_group_path: string;
    suggested_trip_id: string | null;
    created_at: string;
  }>('SELECT * FROM pending_imports ORDER BY created_at ASC');

  for (const p of pending) {
    const screenshotId = uuidv4();
    const target = `${opts.sandboxDir}/${screenshotId}.jpg`;
    await opts.fs.moveFile(p.app_group_path, target);

    // No content_hash in Phase 1 — column is NOT NULL in schema, so we stamp the
    // image filename's UUID as the placeholder. Phase 2 replaces with a real hash
    // and adds a unique index that this row will be allowed to keep (UUIDs don't
    // collide). The architecture allows this because Phase 1 has no dedup logic.
    await insertScreenshot(db, {
      id: screenshotId,
      tripId: p.suggested_trip_id,
      filePath: target,
      contentHash: screenshotId,
      source: 'share',
      capturedAt: p.created_at,
      ownerId: opts.ownerId,
    });

    await db.runAsync('DELETE FROM pending_imports WHERE id = ?', p.id);
  }

  if (pending.length > 0) {
    notifyChange('screenshots');
    notifyChange('pending_imports');
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```sh
npm test -- modules/capture/__tests__/ingest.test.ts
```

Expected: 2 tests passing.

- [ ] **Step 6: Add a barrel**

Create `modules/capture/index.ts`:

```ts
export { ingestPendingImports } from './ingest';
```

- [ ] **Step 7: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(capture): add ingestPendingImports"
```

---

### Task 13: Wire ingestion + App Group SQLite into the root layout

**Why:** `ingestPendingImports` needs a real caller. App foreground is the only trigger in Phase 1. The main app's SQLite must also point at the *same* file the share extension writes — both live in the App Group container at `group.com.trippocket.shared/trip-pocket.db`. `Paths.appleSharedContainers` from `expo-file-system` resolves the container directly, so no custom Expo Module is needed.

**Files:**
- Modify: `app/_layout.tsx`
- Create: `modules/capture/owner.ts`, `modules/capture/paths.ts`

- [ ] **Step 1: Helpers for App Group + sandbox paths**

Create `modules/capture/paths.ts`:

```ts
import { Directory, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

export const APP_GROUP_ID = 'group.com.trippocket.shared';

/**
 * Returns the App Group container URI on iOS (the same path the share extension writes
 * into), or undefined off-iOS. expo-sqlite accepts this as `directory` to open the
 * shared trip-pocket.db file.
 */
export function getAppGroupContainerUri(): string | undefined {
  if (Platform.OS !== 'ios') return undefined;
  return Paths.appleSharedContainers[APP_GROUP_ID]?.uri;
}

/**
 * The directory inside the App Group where the share extension drops images and where
 * the main app moves them to. On non-iOS (or if the App Group entitlement is missing)
 * we fall back to the document directory so the rest of the app keeps working.
 */
export function getSandboxDirectory(): Directory {
  const groupUri = getAppGroupContainerUri();
  const parent = groupUri
    ? new Directory(groupUri)
    : new Directory(Paths.document);
  const dir = new Directory(parent, 'screenshots');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}
```

- [ ] **Step 2: Stamp an owner UUID on first launch**

Create `modules/capture/owner.ts`:

```ts
import { File, Paths } from 'expo-file-system';
import { v4 as uuidv4 } from 'uuid';

const OWNER_FILE_NAME = 'owner.txt';

export function getOrCreateOwnerId(): string {
  const file = new File(Paths.document, OWNER_FILE_NAME);
  if (file.exists) return file.text().trim();
  const id = uuidv4();
  file.create();
  file.write(id);
  return id;
}
```

> **Note:** `expo-file-system`'s class-based API is synchronous for small reads/writes. The legacy `FileSystem.documentDirectory` / `readAsStringAsync` API is still available at `expo-file-system/legacy` if needed.

- [ ] **Step 3: Wire ingestion + owner-id + App Group SQLite into the root layout**

Replace `app/_layout.tsx` with:

```tsx
import '../global.css';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { File } from 'expo-file-system';
import {
  openDatabase,
  runMigrations,
  migrations,
  provideDatabase,
  type Database,
} from '@/modules/storage';
import { ingestPendingImports } from '@/modules/capture';
import { getOrCreateOwnerId } from '@/modules/capture/owner';
import { getAppGroupContainerUri, getSandboxDirectory } from '@/modules/capture/paths';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [ctx, setCtx] = useState<{ db: Database; ownerId: string; sandboxDirUri: string } | null>(null);

  useEffect(() => {
    (async () => {
      // Open the SQLite file inside the App Group container so the share extension
      // and the main app read/write the same database.
      const db = await openDatabase('trip-pocket.db', getAppGroupContainerUri());
      await runMigrations(db, migrations);
      provideDatabase(db);

      const sandbox = getSandboxDirectory();
      const ownerId = getOrCreateOwnerId();
      setCtx({ db, ownerId, sandboxDirUri: sandbox.uri });
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ctx) return;
    const run = async () => {
      await ingestPendingImports(ctx.db, {
        ownerId: ctx.ownerId,
        sandboxDir: ctx.sandboxDirUri,
        fs: {
          moveFile: async (from, to) => {
            const src = new File(from);
            const dst = new File(to);
            src.move(dst);
          },
        },
      });
    };
    run();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') run();
    });
    return () => sub.remove();
  }, [ctx]);

  if (!ready) return null;
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 4: Update the storage `openDatabase` to accept a directory**

Edit `modules/storage/db.ts` — replace the body of `openDatabase` so it forwards an optional `directory`:

```ts
import * as SQLite from 'expo-sqlite';

export type Database = SQLite.SQLiteDatabase;

export type Migration = {
  version: number;
  up: (db: Database) => Promise<void>;
};

export async function openDatabase(
  name = 'trip-pocket.db',
  directory?: string,
): Promise<Database> {
  const db = await SQLite.openDatabaseAsync(name, undefined, directory);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  return db;
}

export async function getMigrationVersion(db: Database): Promise<number> {
  const row = await db.getFirstAsync<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );
  return row?.v ?? 0;
}

export async function runMigrations(db: Database, migrations: Migration[]): Promise<void> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getMigrationVersion(db);
  for (const m of sorted) {
    if (m.version <= current) continue;
    await db.withTransactionAsync(async () => {
      await m.up(db);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        m.version,
        new Date().toISOString(),
      );
    });
  }
}
```

(Tests still pass — `:memory:` ignores the directory parameter.)

- [ ] **Step 5: Run tests + smoke test**

```sh
npm test
npx expo start --dev-client --clear
```

Expected: tests pass; empty-state screen renders on the dev build; no crashes.

- [ ] **Step 6: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(app): wire ingestion + App Group SQLite into root layout"
```

---

### Task 14: Config plugin to add the iOS Share Extension target

**Why:** Expo doesn't ship a built-in way to add a Share Extension target. A config plugin runs at `prebuild` time, edits `ios/Podfile` and the Xcode project to add the new target, and copies in our Swift sources.

**Files:**
- Create: `plugins/with-share-extension.js`, `native/ShareExtension/Info.plist`, `native/ShareExtension/TripPocketShare.entitlements`
- Modify: `app.json`

- [ ] **Step 1: Install plugin dependencies**

```sh
npm install --save-dev @expo/config-plugins xcode plist
```

> **Note:** The main app's App Group entitlement was already added declaratively in Task 5's `app.json`. This config plugin only adds the *extension target itself* — it does not touch the main app's entitlements.

- [ ] **Step 2: Stub Swift source files**

Create `native/ShareExtension/ShareViewController.swift`:

```swift
import UIKit
import SwiftUI
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: SaveButtonView(onSave: { [weak self] in
            self?.handleSave()
        }, onCancel: { [weak self] in
            self?.cancel()
        }))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func handleSave() {
        guard let item = (extensionContext?.inputItems as? [NSExtensionItem])?.first,
              let provider = item.attachments?.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) })
        else {
            cancel()
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.image.identifier) { [weak self] data, _ in
            guard let self else { return }
            guard let url = self.materializeImage(data) else { self.cancel(); return }
            do {
                try PendingImportWriter().write(imageAt: url)
                DispatchQueue.main.async {
                    self.extensionContext?.completeRequest(returningItems: nil)
                }
            } catch {
                DispatchQueue.main.async { self.cancel() }
            }
        }
    }

    private func materializeImage(_ data: NSSecureCoding?) -> URL? {
        if let url = data as? URL { return url }
        if let img = data as? UIImage,
           let jpeg = img.jpegData(compressionQuality: 0.95) {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + ".jpg")
            try? jpeg.write(to: tmp)
            return tmp
        }
        return nil
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "TripPocketShare", code: 0))
    }
}
```

Create `native/ShareExtension/SaveButtonView.swift`:

```swift
import SwiftUI

struct SaveButtonView: View {
    let onSave: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Save to Trip Pocket")
                .font(.title2).bold()
            Button(action: onSave) {
                Text("Save to Inbox")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }
            Button("Cancel", action: onCancel)
                .padding(.bottom, 8)
        }
        .padding()
    }
}
```

Create `native/ShareExtension/PendingImportWriter.swift`:

```swift
import Foundation
import SQLite3

enum PendingImportError: Error {
    case noAppGroup
    case copyFailed
    case dbFailed
}

struct PendingImportWriter {
    let appGroupId = "group.com.trippocket.shared"

    func write(imageAt sourceURL: URL) throws {
        guard let groupURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            throw PendingImportError.noAppGroup
        }

        let imagesDir = groupURL.appendingPathComponent("inbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)

        let destURL = imagesDir.appendingPathComponent(UUID().uuidString + ".jpg")
        do {
            try FileManager.default.copyItem(at: sourceURL, to: destURL)
        } catch {
            throw PendingImportError.copyFailed
        }

        let dbURL = groupURL.appendingPathComponent("trip-pocket.db")
        var db: OpaquePointer?
        guard sqlite3_open(dbURL.path, &db) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_close(db) }

        // The main app creates the table at first launch; the extension creates it
        // defensively in case it runs first.
        let create = """
            CREATE TABLE IF NOT EXISTS pending_imports (
                id TEXT PRIMARY KEY NOT NULL,
                app_group_path TEXT NOT NULL,
                suggested_trip_id TEXT,
                created_at TEXT NOT NULL
            );
        """
        if sqlite3_exec(db, create, nil, nil, nil) != SQLITE_OK {
            throw PendingImportError.dbFailed
        }

        let insert = """
            INSERT INTO pending_imports (id, app_group_path, suggested_trip_id, created_at)
            VALUES (?, ?, NULL, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, insert, -1, &stmt, nil) == SQLITE_OK else {
            throw PendingImportError.dbFailed
        }
        defer { sqlite3_finalize(stmt) }

        let id = UUID().uuidString
        let createdAt = ISO8601DateFormatter().string(from: Date())
        sqlite3_bind_text(stmt, 1, id, -1, nil)
        sqlite3_bind_text(stmt, 2, destURL.path, -1, nil)
        sqlite3_bind_text(stmt, 3, createdAt, -1, nil)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PendingImportError.dbFailed
        }
    }
}
```

> **Note:** The extension uses raw `SQLite3` (not the JS `expo-sqlite`) because Swift extensions can't use Node-bridged APIs. Path is the App Group's `trip-pocket.db`. The main app opens the same file via `Paths.appleSharedContainers` in Task 13.

Create `native/ShareExtension/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Trip Pocket</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>NSExtensionActivationRule</key>
      <dict>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key>
        <integer>1</integer>
      </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).ShareViewController</string>
  </dict>
</dict>
</plist>
```

Create `native/ShareExtension/TripPocketShare.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>group.com.trippocket.shared</string>
  </array>
</dict>
</plist>
```

- [ ] **Step 3: Write the config plugin**

Create `plugins/with-share-extension.js`:

```js
const { withXcodeProject } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const TARGET_NAME = 'TripPocketShare';
const SOURCE_DIR = path.resolve(__dirname, '..', 'native', 'ShareExtension');

const withShareExtension = (config) => withExtensionTarget(config);

function withExtensionTarget(config) {
  return withXcodeProject(config, async (cfg) => {
    const project = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;

    const targetDir = path.join(platformProjectRoot, TARGET_NAME);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of fs.readdirSync(SOURCE_DIR)) {
      fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(targetDir, file));
    }

    if (project.pbxTargetByName(TARGET_NAME)) return cfg;

    const target = project.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME);

    project.addBuildPhase(
      ['ShareViewController.swift', 'SaveButtonView.swift', 'PendingImportWriter.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid,
    );
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase(
      ['SQLite.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid,
    );

    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings) continue;
      if (buildSettings.PRODUCT_NAME && buildSettings.PRODUCT_NAME.includes(TARGET_NAME)) {
        buildSettings.CODE_SIGN_ENTITLEMENTS = `${TARGET_NAME}/TripPocketShare.entitlements`;
        buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `${cfg.ios.bundleIdentifier}.share`;
        buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '15.1';
        buildSettings.SWIFT_VERSION = '5.0';
        buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
      }
    }

    return cfg;
  });
}

module.exports = withShareExtension;
```

> **Note:** Editing the Xcode project programmatically is fragile. If `prebuild` produces a broken target, the typical recovery is `rm -rf ios && npx expo prebuild --clean`. Don't hand-edit `ios/`.

- [ ] **Step 4: Register the plugin**

Edit `app.json` and add under `expo`:

```json
"plugins": [
  "expo-router",
  "./plugins/with-share-extension"
]
```

- [ ] **Step 5: Run prebuild and verify the target appears**

```sh
npx expo prebuild --clean -p ios
ls ios/TripPocketShare
```

Expected: directory contains the four Swift / Plist / entitlement files.

```sh
grep -c "TripPocketShare" ios/*.xcodeproj/project.pbxproj
```

Expected: a non-zero number (the target is registered).

- [ ] **Step 6: Commit**

```sh
/opt/homebrew/bin/git add -A
/opt/homebrew/bin/git commit -m "feat(native): add iOS Share Extension target via config plugin"
```

---

### Task 15: Build with the extension and run on device

**Why:** Now that the config plugin is in place and the main app reads from the App Group SQLite, a fresh prebuild + EAS build produces an IPA where the share extension and the main app share `trip-pocket.db`. This is the last build before the end-to-end smoke test.

**Files:** none.

- [ ] **Step 1: Clean prebuild**

```sh
npx expo prebuild --clean -p ios
```

Expected: `ios/TripPocketShare/` exists; the entitlements file is present; `ios/*.xcodeproj/project.pbxproj` references the extension target.

- [ ] **Step 2: Local device build**

```sh
eas build --profile dev --platform ios --local
```

Expected: an `.ipa` is produced.

- [ ] **Step 3: Install on iPhone**

Open Xcode → Window → Devices and Simulators → drag the IPA onto your device.

Expected: the app installs and launches.

- [ ] **Step 4: Verify the App Group is wired both ways**

Open the app once (so the main app creates `trip-pocket.db` inside the App Group container). Then dismiss the app and confirm the share extension is visible from Photos → tap a screenshot → Share — "Trip Pocket" should appear.

If the extension does NOT appear: revisit the config plugin (Task 14) — `prebuild --clean` is the recovery.

- [ ] **Step 5: Commit any prebuild artifacts that should not be in `.gitignore`**

By default Expo's `.gitignore` excludes `ios/`. We don't need to commit native project files. Confirm there are no untracked items that *should* be tracked.

```sh
/opt/homebrew/bin/git status
```

If clean, no commit needed. Otherwise add only what should be tracked.

---

### Task 16: End-to-end smoke test

**Why:** Validate the goal — share, see, repeat.

**Files:** none.

- [ ] **Step 1: Run the dev server**

```sh
npx expo start --dev-client
```

Open the app on the iPhone — empty state visible.

- [ ] **Step 2: Take a screenshot on the iPhone**

Hold side button + volume up. The screenshot lands in Photos.

- [ ] **Step 3: Share it**

Open Photos → tap the screenshot → tap Share → scroll to find "Trip Pocket".

- [ ] **Step 4: Tap "Save to Inbox"**

The share sheet dismisses.

- [ ] **Step 5: Open the Trip Pocket app**

The screenshot should appear in the list within a few seconds (after the foreground ingestion runs).

- [ ] **Step 6: Repeat 3+ times with different screenshots**

Each one shows up.

- [ ] **Step 7: Force-quit the app and reopen**

All saved screenshots still visible — persistence confirmed.

- [ ] **Step 8: Mark Phase 1 done**

Edit `docs/phases/phase-1-hello-screenshot.md` and append a `## Status` section:

```markdown
## Status

**Done.** Dev build runs on a real iPhone, share extension saves screenshots reliably, list view renders them, persistence holds across restarts. Phase 2 (trips proper) starts next.
```

- [ ] **Step 9: Commit**

```sh
/opt/homebrew/bin/git add docs/phases/phase-1-hello-screenshot.md
/opt/homebrew/bin/git commit -m "docs: phase 1 done"
```

---

## Self-review notes

Spec coverage:

- ✅ Dev build on real iPhone — Tasks 5, 15
- ✅ Share extension shows in Photos share sheet — Task 14
- ✅ Image copies to App Group storage on Save — Task 14 (PendingImportWriter)
- ✅ Sandbox image is moved into the main app's view — Task 12, 13
- ✅ List shows the saved screenshot — Task 11
- ✅ Closing/reopening still shows it — Task 13 (real shared DB, not in-memory)
- ✅ Repeats reliably 3+ times — Task 16

What this plan does *not* do (intentional, in spec):

- No trip picker in the share extension (defer to Phase 2)
- No trips table writes (defer to Phase 2)
- No tap-to-view detail (defer to Phase 2)
- No delete (defer to Phase 2)
- No content-hash dedup (defer to Phase 2)
- No OCR / AI / auto-detect (defer to v0.2)

What changed from the first draft of this plan:

- Removed the custom `NativeIos` Expo Module — `expo-file-system` exposes `Paths.appleSharedContainers` natively as of SDK 54+.
- The main app's App Group entitlement is set declaratively in `app.json` instead of via a config plugin.
- File operations use the modern `expo-file-system` class API (`File`, `Directory`, `Paths`) instead of the legacy `FileSystem.*Async` calls.
- Content-hash dedup is deferred to Phase 2; `content_hash` is filled with the screenshot UUID for now to satisfy the NOT NULL constraint.
- NativeWind pins tightened to `tailwindcss@^3.4.17`, `prettier-plugin-tailwindcss@^0.5.11`.
