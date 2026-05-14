import { File, Paths } from 'expo-file-system';
import type { EntitlementStatus } from './status';

const FILE_NAME = 'entitlement-status.txt';

function file(): File {
  return new File(Paths.document, FILE_NAME);
}

export function readCachedStatus(): EntitlementStatus | null {
  const f = file();
  if (!f.exists) return null;
  const text = f.textSync().trim();
  if (text === 'active' || text === 'inactive') return text;
  return null;
}

export function writeCachedStatus(status: EntitlementStatus): void {
  const f = file();
  if (!f.exists) f.create();
  f.write(status);
}

export function resetCachedStatus(): void {
  const f = file();
  if (f.exists) f.delete();
}
