import { File, Paths } from 'expo-file-system';
import { v4 as uuidv4 } from 'uuid';

const OWNER_FILE_NAME = 'owner.txt';

export async function getOrCreateOwnerId(): Promise<string> {
  const file = new File(Paths.document, OWNER_FILE_NAME);
  if (file.exists) return (await file.text()).trim();
  const id = uuidv4();
  file.create();
  file.write(id);
  return id;
}
