import { File, Paths } from 'expo-file-system';
import { v4 as uuidv4 } from 'uuid';

const OWNER_FILE_NAME = 'owner.txt';

export function getOrCreateOwnerId(): string {
  const file = new File(Paths.document, OWNER_FILE_NAME);
  if (file.exists) return file.textSync().trim();
  const id = uuidv4();
  file.create();
  file.write(id);
  return id;
}
