import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { getInstallId } from './install-id';

function computeRelease(): string | undefined {
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  const version = Constants.expoConfig?.version;
  const build = Application.nativeBuildVersion;
  if (!bundleId || !version || !build) return undefined;
  return `${bundleId}@${version}+${build}`;
}

let initialized = false;

export function initSentry(): void {
  if (__DEV__) return;
  if (initialized) return;

  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    release: computeRelease(),
    enableNativeCrashHandling: true,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    attachStacktrace: true,
    debug: false,
  });

  initialized = true;
}

export async function attachInstallId(): Promise<void> {
  if (__DEV__ || !initialized) return;
  try {
    const id = await getInstallId();
    Sentry.setUser({ id });
  } catch {
    // Swallow: install-id failure must never block app boot. The event
    // still lands in Sentry, just without user.id.
  }
}
