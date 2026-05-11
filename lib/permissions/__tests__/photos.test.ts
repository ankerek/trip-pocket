jest.mock('expo-image-picker', () => ({
  getMediaLibraryPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
}));

import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';
import { ensurePhotosAccess } from '../photos';

const getMock = ImagePicker.getMediaLibraryPermissionsAsync as jest.Mock;
const requestMock = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const alertMock = Alert.alert as jest.Mock;
const openSettingsMock = Linking.openSettings as jest.Mock;

beforeEach(() => {
  getMock.mockReset();
  requestMock.mockReset();
  alertMock.mockReset();
  openSettingsMock.mockReset();
});

describe('ensurePhotosAccess', () => {
  test('returns granted without prompting when status is granted', async () => {
    getMock.mockResolvedValue({ status: 'granted', canAskAgain: true });
    await expect(ensurePhotosAccess()).resolves.toBe('granted');
    expect(requestMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('prompts when undetermined and canAskAgain — granted after prompt', async () => {
    getMock.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    requestMock.mockResolvedValue({ status: 'granted', canAskAgain: true });
    await expect(ensurePhotosAccess()).resolves.toBe('granted');
    expect(requestMock).toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('prompts when canAskAgain — denied after prompt', async () => {
    getMock.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    requestMock.mockResolvedValue({ status: 'denied', canAskAgain: false });
    await expect(ensurePhotosAccess()).resolves.toBe('denied');
    // Spec: we don't follow a fresh denial with the Settings alert — iOS
    // already rendered its own dialog. The Settings alert is only for users
    // who previously denied and cannot be re-prompted.
    expect(alertMock).not.toHaveBeenCalled();
  });

  test('shows Settings alert when status denied and cannot ask again', async () => {
    getMock.mockResolvedValue({ status: 'denied', canAskAgain: false });
    await expect(ensurePhotosAccess()).resolves.toBe('denied');
    expect(requestMock).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(1);
    const [title, body, buttons] = alertMock.mock.calls[0];
    expect(title).toBe('Photos access is off');
    expect(typeof body).toBe('string');
    expect(Array.isArray(buttons)).toBe(true);
    const settingsButton = buttons.find((b: { text: string }) => b.text === 'Open Settings');
    expect(settingsButton).toBeDefined();

    settingsButton.onPress();
    expect(openSettingsMock).toHaveBeenCalled();
  });

  test('treats restricted (parental controls) the same as denied', async () => {
    getMock.mockResolvedValue({ status: 'restricted', canAskAgain: false });
    await expect(ensurePhotosAccess()).resolves.toBe('denied');
    expect(alertMock).toHaveBeenCalledTimes(1);
  });
});
