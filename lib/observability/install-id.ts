import * as Crypto from 'expo-crypto';
import { getDatabaseHandle } from '@/modules/storage';

const KEY = 'sentry_install_id';

let cached: string | null = null;

export async function getInstallId(): Promise<string> {
  if (cached) return cached;

  const db = getDatabaseHandle();
  if (!db)
    throw new Error('Database not provided yet; call getInstallId() after provideDatabase()');

  const row = await db.getFirstAsync<{ value: string | null }>(
    'SELECT value FROM meta WHERE key = ?',
    KEY,
  );

  if (row?.value) {
    cached = row.value;
    return cached;
  }

  const id = Crypto.randomUUID();
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', KEY, id);
  cached = id;
  return id;
}
