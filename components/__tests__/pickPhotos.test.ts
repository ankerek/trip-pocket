import * as ImagePicker from 'expo-image-picker';
import type { ImagePickerAsset } from 'expo-image-picker';
import { importImage } from '@/modules/capture';
import { ensurePhotosAccess } from '@/lib/permissions/photos';
import { showToast } from '@/lib/toast/toast';
import { pickPhotosForImport } from '../pickPhotos';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 's', Warning: 'w', Error: 'e' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/modules/capture', () => ({
  createImportFs: jest.fn(() => ({})),
  getOrCreateOwnerId: jest.fn(() => 'owner-1'),
  getStorageDirectory: jest.fn(() => ({ uri: 'file:///storage' })),
  importImage: jest.fn(),
}));

jest.mock('@/lib/permissions/photos', () => ({
  ensurePhotosAccess: jest.fn(),
}));

jest.mock('@/lib/toast/toast', () => ({
  showToast: jest.fn(),
}));

const launchMock = ImagePicker.launchImageLibraryAsync as jest.Mock;
const importMock = importImage as jest.Mock;
const ensureMock = ensurePhotosAccess as jest.Mock;
const showToastMock = showToast as jest.Mock;

const db = {} as never;

function asset(id: string): ImagePickerAsset {
  return { uri: `file:///asset-${id}`, width: 10, height: 10 } as unknown as ImagePickerAsset;
}

beforeEach(() => {
  launchMock.mockReset();
  importMock.mockReset();
  ensureMock.mockReset();
  showToastMock.mockReset();
});

describe('pickPhotosForImport', () => {
  test('returns denied outcome when permission is denied and never opens the picker', async () => {
    ensureMock.mockResolvedValue('denied');
    const outcome = await pickPhotosForImport(db);
    expect(outcome).toEqual({ imported: 0, failed: 0, storageFull: 0, denied: true });
    expect(launchMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('user cancels picker — no toast, no imports', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({ canceled: true });
    const outcome = await pickPhotosForImport(db);
    expect(outcome).toEqual({ imported: 0, failed: 0, storageFull: 0, denied: false });
    expect(importMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('all imports succeed — silent (no toast)', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [asset('a'), asset('b')],
    });
    importMock.mockResolvedValue({ status: 'imported', sourceId: 'x' });
    const outcome = await pickPhotosForImport(db);
    expect(outcome).toMatchObject({ imported: 2, failed: 0, storageFull: 0, denied: false });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('duplicate results count toward imported (silent)', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [asset('a'), asset('b')],
    });
    importMock.mockResolvedValueOnce({ status: 'imported', sourceId: 'x' });
    importMock.mockResolvedValueOnce({ status: 'duplicate', existingSourceId: 'y' });
    const outcome = await pickPhotosForImport(db);
    expect(outcome).toMatchObject({ imported: 2, failed: 0 });
    expect(showToastMock).not.toHaveBeenCalled();
  });

  test('partial failure — "X of Y photos didn\'t import"', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [asset('a'), asset('b'), asset('c')],
    });
    importMock
      .mockResolvedValueOnce({ status: 'imported', sourceId: 'x' })
      .mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'))
      .mockResolvedValueOnce({ status: 'imported', sourceId: 'z' });
    await pickPhotosForImport(db);
    expect(showToastMock).toHaveBeenCalledWith({
      kind: 'error',
      message: "1 of 3 photos didn't import",
    });
  });

  test('total failure — "Couldn\'t import photos"', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [asset('a'), asset('b')],
    });
    importMock.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));
    await pickPhotosForImport(db);
    expect(showToastMock).toHaveBeenCalledWith({
      kind: 'error',
      message: "Couldn't import photos",
    });
  });

  test('storage-full short-circuits remaining queue and shows storage toast', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [
        asset('a'),
        asset('b'),
        asset('c'),
        asset('d'),
        asset('e'),
        asset('f'),
        asset('g'),
        asset('h'),
      ],
    });
    // First call: storage-full. Remaining calls: should never be reached
    // for the drained items (workers see the flag and skip).
    let callCount = 0;
    importMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('ENOSPC: no space left on device');
      }
      return { status: 'imported', sourceId: `id-${callCount}` };
    });
    const outcome = await pickPhotosForImport(db);
    expect(outcome.storageFull).toBeGreaterThanOrEqual(1);
    expect(outcome.failed).toBeGreaterThanOrEqual(outcome.storageFull);
    expect(outcome.imported + outcome.failed).toBe(8);
    expect(showToastMock).toHaveBeenCalledWith({
      kind: 'error',
      message: 'Your device is out of storage',
    });
  });

  test('storage-full toast takes priority over partial-failure toast', async () => {
    ensureMock.mockResolvedValue('granted');
    launchMock.mockResolvedValue({
      canceled: false,
      assets: [asset('a'), asset('b')],
    });
    importMock
      .mockResolvedValueOnce({ status: 'imported', sourceId: 'x' })
      .mockRejectedValueOnce(new Error('NSFileWriteOutOfSpaceError'));
    await pickPhotosForImport(db);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith({
      kind: 'error',
      message: 'Your device is out of storage',
    });
  });
});
