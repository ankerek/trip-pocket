import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

const OWNER_FILE_NAME = 'owner.txt';

export function getOrCreateOwnerId(): string {
  const file = new File(Paths.document, OWNER_FILE_NAME);
  if (file.exists) return file.textSync().trim();
  const id = Crypto.randomUUID();
  file.create();
  file.write(id);
  return id;
}
