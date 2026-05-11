import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

export type PhotosAccess = 'granted' | 'denied';

// Gate before launching the system photo picker. iOS Limited Library access
// is reported as `status: 'granted'` with `accessPrivileges: 'limited'` —
// the user can still pick photos, so we treat it as granted. If iOS won't
// let us re-prompt, surface a Settings deeplink.
export async function ensurePhotosAccess(): Promise<PhotosAccess> {
  const initial = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (initial.status === 'granted') {
    return 'granted';
  }
  if (initial.canAskAgain) {
    const after = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (after.status === 'granted') {
      return 'granted';
    }
    return 'denied';
  }
  showDeniedAlert();
  return 'denied';
}

function showDeniedAlert(): void {
  Alert.alert(
    'Photos access is off',
    'Trip Pocket needs photo access to add screenshots. Turn it on in Settings.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open Settings', onPress: () => void Linking.openSettings() },
    ],
    { cancelable: true },
  );
}
