import { Directory, File } from 'expo-file-system';
import { getAppGroupContainerUri } from '@/modules/capture/paths';

/**
 * Filename inside the App Group container. The iOS Share Extension reads
 * this via `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`
 * so it can send the share-time pre-warm POST /extract with the right
 * `X-RC-User-Id` header. Mirror of the entitlement-status pattern.
 *
 * Schema:
 *   {
 *     "rc_user_id": "$RCAnonymousID:<32-hex>" | "<App User ID>",
 *     "updated_at": "<ISO 8601 UTC timestamp>"
 *   }
 *
 * Missing or unparseable file → extension skips the prewarm (the app-on-
 * open foreground sweep still drives extraction via the existing path).
 */
export const SHARED_RC_USER_ID_FILE_NAME = 'rc-user-id.json';

export type SharedRcUserIdSnapshot = {
  rc_user_id: string;
  updated_at: string;
};

function sharedFile(): File | null {
  const containerUri = getAppGroupContainerUri();
  if (!containerUri) return null;
  return new File(new Directory(containerUri), SHARED_RC_USER_ID_FILE_NAME);
}

/**
 * Mirror the RevenueCat `appUserID` into the App Group container so the
 * iOS Share Extension can send authenticated prewarm requests. Silently
 * no-ops off-iOS or when the App Group is misconfigured.
 */
export function writeSharedRcUserId(
  rcUserId: string,
  now: Date = new Date(),
): void {
  const f = sharedFile();
  if (!f) return;
  if (!f.exists) f.create();
  const payload: SharedRcUserIdSnapshot = {
    rc_user_id: rcUserId,
    updated_at: now.toISOString(),
  };
  f.write(JSON.stringify(payload));
}

export function readSharedRcUserId(): SharedRcUserIdSnapshot | null {
  const f = sharedFile();
  if (!f || !f.exists) return null;
  const text = f.textSync().trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<SharedRcUserIdSnapshot>;
    if (typeof parsed.rc_user_id !== 'string' || parsed.rc_user_id.length === 0) {
      return null;
    }
    if (typeof parsed.updated_at !== 'string') return null;
    return { rc_user_id: parsed.rc_user_id, updated_at: parsed.updated_at };
  } catch {
    return null;
  }
}

export function resetSharedRcUserId(): void {
  const f = sharedFile();
  if (f?.exists) f.delete();
}
