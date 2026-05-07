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
  const uri = Paths.appleSharedContainers[APP_GROUP_ID]?.uri;
  if (!uri) {
    // Surfaces an entitlement misconfig immediately — without this the main app
    // silently falls back to its private sandbox and the share-extension writes
    // into a different DB, leaving the inbox perpetually empty.
    console.warn(`[paths] App Group "${APP_GROUP_ID}" not available — check ios.entitlements`);
  }
  return uri;
}

/**
 * Long-term home for screenshot image files. Colocated with the SQLite DB inside the
 * App Group container so the files survive a dev reinstall (the main app's private
 * Documents directory gets wiped on each `expo run:ios` rebuild, which would otherwise
 * leave DB rows pointing at non-existent files). Off-iOS or when the entitlement is
 * misconfigured, falls back to the private documents dir.
 */
export function getStorageDirectory(): Directory {
  const root = getAppGroupContainerUri();
  const dir = root
    ? new Directory(root, 'screenshots')
    : new Directory(Paths.document, 'screenshots');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}
