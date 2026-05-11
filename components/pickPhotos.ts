import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import {
  createImportFs,
  getOrCreateOwnerId,
  getStorageDirectory,
  importImage,
} from '@/modules/capture';
import type { Database } from '@/modules/storage';
import { ensurePhotosAccess } from '@/lib/permissions/photos';
import { classifyImportError } from '@/lib/errors/captureErrors';
import { showToast } from '@/lib/toast/toast';

export type PickPhotosOptions = {
  tripId?: string | null;
};

export type PickPhotosOutcome = {
  imported: number; // includes 'duplicate' (same net state for the user)
  failed: number; // hard failures + items skipped after storage-full short-circuit
  storageFull: number;
  denied: boolean;
};

// Opens the system photo library and imports the selected images. When
// `tripId` is provided, freshly imported sources are assigned to that
// trip up front so the user doesn't have to triage them from the Inbox.
export async function pickPhotosForImport(
  db: Database,
  options: PickPhotosOptions = {},
): Promise<PickPhotosOutcome> {
  const access = await ensurePhotosAccess();
  if (access === 'denied') {
    return { imported: 0, failed: 0, storageFull: 0, denied: true };
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 20,
  });
  if (result.canceled) {
    return { imported: 0, failed: 0, storageFull: 0, denied: false };
  }
  const outcome = await runImports(db, result.assets, options.tripId ?? null);
  reportOutcome(outcome, result.assets.length);
  return outcome;
}

async function runImports(
  db: Database,
  assets: ImagePicker.ImagePickerAsset[],
  tripId: string | null,
): Promise<PickPhotosOutcome> {
  const storage = getStorageDirectory().uri;
  const ownerId = getOrCreateOwnerId();
  const now = new Date().toISOString();
  const fs = createImportFs();

  const outcome: PickPhotosOutcome = {
    imported: 0,
    failed: 0,
    storageFull: 0,
    denied: false,
  };
  const queue = [...assets];
  let storageFullDetected = false;

  const next = async () => {
    while (queue.length > 0) {
      const asset = queue.shift();
      if (!asset) return;
      // Best-effort short-circuit: once any worker sees storage-full, the
      // remaining queue is drained as failed without further write attempts.
      if (storageFullDetected) {
        outcome.failed += 1;
        continue;
      }
      try {
        const r = await importImage(db, {
          sourceUri: asset.uri,
          origin: 'manual',
          ownerId,
          capturedAt: now,
          suggestedTripId: tripId,
          transfer: 'copy',
          storageDir: storage,
          fs,
        });
        if (r.status === 'imported' || r.status === 'duplicate') {
          outcome.imported += 1;
        }
      } catch (err) {
        const kind = classifyImportError(err);
        if (kind === 'storage-full') {
          outcome.storageFull += 1;
          storageFullDetected = true;
        }
        outcome.failed += 1;
        console.warn('[capture] import failed', err);
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < 4; i += 1) workers.push(next());
  await Promise.all(workers);

  if (process.env.EXPO_OS === 'ios') {
    const haptic =
      outcome.failed > 0 && outcome.imported === 0
        ? Haptics.NotificationFeedbackType.Error
        : outcome.imported > 0
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning;
    Haptics.notificationAsync(haptic).catch(() => {});
  }
  return outcome;
}

function reportOutcome(outcome: PickPhotosOutcome, total: number): void {
  if (outcome.storageFull > 0) {
    showToast({ kind: 'error', message: 'Your device is out of storage' });
    return;
  }
  if (outcome.failed === 0) return;
  if (outcome.imported > 0) {
    showToast({
      kind: 'error',
      message: `${outcome.failed} of ${total} photos didn't import`,
    });
    return;
  }
  showToast({ kind: 'error', message: "Couldn't import photos" });
}
