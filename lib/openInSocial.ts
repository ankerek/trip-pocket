import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export type SocialPlatform = 'instagram' | 'tiktok' | null;

// Bare URL-schemes used only for installation detection via canOpenURL.
// Must also be listed in ios.infoPlist.LSApplicationQueriesSchemes for the
// check to return true on iOS.
const SCHEMES: Record<NonNullable<SocialPlatform>, readonly string[]> = {
  instagram: ['instagram://app'],
  // snssdk1233 is TikTok's official scheme (ByteDance); 'tiktok' works on
  // some builds. Check both — true on either means the app is installed.
  tiktok: ['snssdk1233://app', 'tiktok://app'],
};

type Detection = 'unknown' | 'installed' | 'absent';
const cache: Record<NonNullable<SocialPlatform>, Detection> = {
  instagram: 'unknown',
  tiktok: 'unknown',
};
let inflight: Promise<void> | null = null;

export async function warmSocialAppDetection(): Promise<void> {
  if (cache.instagram !== 'unknown' && cache.tiktok !== 'unknown') return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [ig, tt] = await Promise.all([
        anyOpenable(SCHEMES.instagram),
        anyOpenable(SCHEMES.tiktok),
      ]);
      cache.instagram = ig ? 'installed' : 'absent';
      cache.tiktok = tt ? 'installed' : 'absent';
    } catch {
      cache.instagram = 'absent';
      cache.tiktok = 'absent';
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function _resetSocialDetectionForTests(): void {
  cache.instagram = 'unknown';
  cache.tiktok = 'unknown';
  inflight = null;
}

export function _setSocialDetectionForTests(
  platform: NonNullable<SocialPlatform>,
  state: 'installed' | 'absent',
): void {
  cache[platform] = state;
}

/**
 * Open an Instagram / TikTok post URL. If the native app is installed, hands
 * off via `Linking.openURL` so iOS Universal Links route into the app;
 * otherwise falls back to SFSafariViewController so the user stays inside
 * Trip Pocket.
 */
export async function openSourceUrl(url: string, platform: SocialPlatform): Promise<void> {
  await warmSocialAppDetection();
  const appInstalled =
    platform === 'instagram'
      ? cache.instagram === 'installed'
      : platform === 'tiktok'
        ? cache.tiktok === 'installed'
        : false;

  if (appInstalled) {
    try {
      await Linking.openURL(url);
      return;
    } catch (err) {
      console.warn('[openSourceUrl] Linking.openURL failed, falling back', err);
    }
  }
  await WebBrowser.openBrowserAsync(url, {
    dismissButtonStyle: 'close',
    controlsColor: '#ffffff',
    toolbarColor: '#000000',
  });
}

async function anyOpenable(schemes: readonly string[]): Promise<boolean> {
  for (const s of schemes) {
    try {
      if (await Linking.canOpenURL(s)) return true;
    } catch {
      // continue
    }
  }
  return false;
}
