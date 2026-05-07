import '../global.css';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  openDatabase,
  runMigrations,
  migrations,
  provideDatabase,
  type Database,
} from '@/modules/storage';
import {
  ingestPendingImports,
  getOrCreateOwnerId,
  getAppGroupContainerUri,
  getSandboxDirectory,
  createImportFs,
} from '@/modules/capture';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [ctx, setCtx] = useState<{
    db: Database;
    ownerId: string;
    sandboxDirUri: string;
  } | null>(null);
  const ingesting = useRef(false);

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
    })().catch((err) => {
      console.error('[RootLayout] init failed', err);
    });
  }, []);

  useEffect(() => {
    if (!ctx) return;
    const run = async () => {
      if (ingesting.current) return;
      ingesting.current = true;
      try {
        await ingestPendingImports(ctx.db, {
          ownerId: ctx.ownerId,
          sandboxDir: ctx.sandboxDirUri,
          fs: createImportFs(),
        });
      } finally {
        ingesting.current = false;
      }
    };
    run();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') run();
    });
    return () => sub.remove();
  }, [ctx]);

  if (!ready) return null;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="places/[id]" options={{ headerShown: true }} />
      <Stack.Screen name="trips/[id]" options={{ headerShown: true }} />
      <Stack.Screen
        name="trips/new"
        options={{ headerShown: true, presentation: 'modal', title: 'New trip' }}
      />
      <Stack.Screen
        name="trips/[id]/edit"
        options={{ headerShown: true, presentation: 'modal', title: 'Edit trip' }}
      />
    </Stack>
  );
}
