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
 * The main app's private sandbox for stored screenshots. The architecture says the
 * App Group container is the share-extension *mailbox*, not the long-term store —
 * once the main app drains a pending import it moves the image into its own sandbox.
 */
export function getSandboxDirectory(): Directory {
  const dir = new Directory(Paths.document, 'screenshots');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}
