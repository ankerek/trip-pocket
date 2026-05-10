import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import {
  createImportFs,
  getOrCreateOwnerId,
  getStorageDirectory,
  importImage,
} from '@/modules/capture';
import type { Database } from '@/modules/storage';

export type PickPhotosOptions = {
  tripId?: string | null;
};

type Outcome = {
  imported: number;
  skipped: number;
  failed: number;
};

// Opens the system photo library and imports the selected images. When
// `tripId` is provided, freshly imported sources are assigned to that
// trip up front so the user doesn't have to triage them from the Inbox.
export async function pickPhotosForImport(
  db: Database,
  options: PickPhotosOptions = {},
) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 20,
  });
  if (result.canceled) return;
  await runImports(db, result.assets, options.tripId ?? null);
}

async function runImports(
  db: Database,
  assets: ImagePicker.ImagePickerAsset[],
  tripId: string | null,
) {
  const storage = getStorageDirectory().uri;
  const ownerId = getOrCreateOwnerId();
  const now = new Date().toISOString();
  const fs = createImportFs();

  const outcome: Outcome = { imported: 0, skipped: 0, failed: 0 };
  const queue = [...assets];
  const next = async () => {
    while (queue.length > 0) {
      const asset = queue.shift();
      if (!asset) return;
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
        if (r.status === 'imported') outcome.imported += 1;
        else outcome.skipped += 1;
      } catch (err) {
        console.warn('[capture] import failed', err);
        outcome.failed += 1;
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

  const parts: string[] = [];
  if (outcome.imported > 0) parts.push(`Imported ${outcome.imported}`);
  if (outcome.skipped > 0)
    parts.push(`skipped ${outcome.skipped} duplicate${outcome.skipped === 1 ? '' : 's'}`);
  if (outcome.failed > 0) parts.push(`${outcome.failed} failed`);
  Alert.alert(parts.join(' · ') || 'Nothing to import');
}
