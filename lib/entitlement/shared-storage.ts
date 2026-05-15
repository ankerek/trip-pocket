import { Directory, File } from 'expo-file-system';
import { getAppGroupContainerUri } from '@/modules/capture/paths';
import type { EntitlementStatus } from './status';

/**
 * Filename inside the App Group container. The iOS Share Extension reads this
 * via `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)` and
 * mirrors the parse logic — keep the schema below stable across releases.
 *
 * Schema:
 *   {
 *     "status": "active" | "inactive",
 *     "updated_at": "<ISO 8601 UTC timestamp>"
 *   }
 *
 * Both fields are required. Missing or unparseable file → Swift treats as
 * "unknown" / fail-open (see ShareViewController).
 */
export const SHARED_ENTITLEMENT_FILE_NAME = 'entitlement-status.json';

export type SharedEntitlementSnapshot = {
  status: EntitlementStatus;
  updated_at: string;
};

function sharedFile(): File | null {
  const containerUri = getAppGroupContainerUri();
  if (!containerUri) return null;
  return new File(new Directory(containerUri), SHARED_ENTITLEMENT_FILE_NAME);
}

/**
 * Mirror entitlement status into the App Group container so the Share
 * Extension can decide whether to write to `pending_imports` without running
 * the JS bridge. Throws on write failure; callers should catch and log a
 * Sentry breadcrumb (the extension fail-opens if this is ever missing).
 */
export function writeSharedEntitlementStatus(
  status: EntitlementStatus,
  now: Date = new Date(),
): void {
  const f = sharedFile();
  if (!f) return; // off-iOS or App Group misconfigured — silent no-op
  if (!f.exists) f.create();
  const payload: SharedEntitlementSnapshot = {
    status,
    updated_at: now.toISOString(),
  };
  f.write(JSON.stringify(payload));
}

export function readSharedEntitlementStatus(): SharedEntitlementSnapshot | null {
  const f = sharedFile();
  if (!f || !f.exists) return null;
  const text = f.textSync().trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<SharedEntitlementSnapshot>;
    if (parsed.status !== 'active' && parsed.status !== 'inactive') return null;
    if (typeof parsed.updated_at !== 'string') return null;
    return { status: parsed.status, updated_at: parsed.updated_at };
  } catch {
    return null;
  }
}

export function resetSharedEntitlementStatus(): void {
  const f = sharedFile();
  if (f?.exists) f.delete();
}
