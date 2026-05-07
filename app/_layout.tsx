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
  getStorageDirectory,
  createImportFs,
  cleanupOrphanScreenshots,
} from '@/modules/capture';
import {
  createProcessor,
  provideProcessor,
  type Processor,
} from '@/modules/processing';
import { recognizeText } from '@/modules/vision-ocr';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [ctx, setCtx] = useState<{
    db: Database;
    ownerId: string;
    storageDirUri: string;
    processor: Processor;
  } | null>(null);
  const ingesting = useRef(false);

  useEffect(() => {
    (async () => {
      // Open the SQLite file inside the App Group container so the share extension
      // and the main app read/write the same database.
      const db = await openDatabase('trip-pocket.db', getAppGroupContainerUri());
      await runMigrations(db, migrations);
      provideDatabase(db);

      // OCR pipeline. createProcessor + provideProcessor wires up the
      // singleton importImage talks to. runStartupRecovery is the
      // once-per-process retry promotion: 'failed' rows roll back to
      // 'pending' so they get one more 3-try budget this session.
      const processor = createProcessor({ db, ocr: recognizeText });
      provideProcessor(processor);
      await processor.runStartupRecovery();

      // Sweep rows whose image file is gone (typically: dev reinstall wiped
      // the old private-sandbox path before screenshots were colocated into
      // the App Group). Soft-delete keeps the schema invariant clean.
      await cleanupOrphanScreenshots(db);

      const storage = getStorageDirectory();
      const ownerId = getOrCreateOwnerId();
      setCtx({ db, ownerId, storageDirUri: storage.uri, processor });
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
          storageDir: ctx.storageDirUri,
          fs: createImportFs(),
        });
        // Catch any 'pending' rows the share extension dropped while the
        // app was closed, plus anything left mid-OCR by the previous
        // session. Mid-session sweeps deliberately skip 'failed'.
        await ctx.processor.runOcrSweep();
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
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="places/[id]" options={{ headerShown: true }} />
      <Stack.Screen name="search" options={{ headerShown: true, presentation: 'modal' }} />
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
