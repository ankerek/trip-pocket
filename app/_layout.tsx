import '../global.css';
import { Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
          fs: {
            moveFile: async (from, to) => {
              const src = new File(from);
              const dst = new File(to);
              src.move(dst);
            },
          },
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
  return <Stack screenOptions={{ headerShown: false }} />;
}
