import { ActionSheetIOS, Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import {
  createImportFs,
  getOrCreateOwnerId,
  getStorageDirectory,
  importImage,
} from '@/modules/capture';
import type { Database } from '@/modules/storage';

type Outcome = {
  imported: number;
  skipped: number;
  failed: number;
};

// Drives the iOS action sheet that appears when the user taps the
// center capture FAB. Same import path as the existing camera-roll
// header button — keeps OCR/extraction pipelines untouched.
export function showCaptureActionSheet(db: Database) {
  if (Platform.OS !== 'ios') {
    void importFromLibrary(db);
    return;
  }

  ActionSheetIOS.showActionSheetWithOptions(
    {
      options: ['Pick from Photos', 'Take photo', 'Cancel'],
      cancelButtonIndex: 2,
      title: 'Add screenshots',
    },
    (index) => {
      if (index === 0) void importFromLibrary(db);
      else if (index === 1) void importFromCamera(db);
    },
  );
}

async function importFromLibrary(db: Database) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 20,
  });
  if (result.canceled) return;
  await runImports(db, result.assets);
}

async function importFromCamera(db: Database) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Camera access denied');
    return;
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] });
  if (result.canceled) return;
  await runImports(db, result.assets);
}

async function runImports(
  db: Database,
  assets: ImagePicker.ImagePickerAsset[],
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
