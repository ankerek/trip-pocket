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
