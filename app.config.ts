import type { ExpoConfig } from 'expo/config';

// APP_VARIANT=development gives a side-by-side install with its own bundle
// identifier, display name, and URL scheme. The App Group stays shared
// with production so SQLite + pending-imports inbox are the same; this is
// usually fine but means dev migrations can mutate prod's schema. Promote
// to a per-variant App Group if that bites.
const IS_DEV = process.env.APP_VARIANT === 'development';

const BUNDLE_ID = IS_DEV ? 'com.trippocket.app.dev' : 'com.trippocket.app';
const ANDROID_PACKAGE = IS_DEV ? 'com.trippocket.app.dev' : 'com.trippocket.app';
const APP_NAME = IS_DEV ? 'Trip Pocket Dev' : 'Trip Pocket';
const SCHEME = IS_DEV ? 'trippocket-dev' : 'trippocket';

const config: ExpoConfig = {
  name: APP_NAME,
  slug: 'trip-pocket',
  version: '0.3.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: SCHEME,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: '5',
    icon: './assets/AppIcon.icon',
    supportsTablet: false,
    entitlements: {
      'com.apple.security.application-groups': ['group.com.trippocket.shared'],
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      LSApplicationQueriesSchemes: [
        'comgooglemaps',
        'instagram',
        'tiktok',
        'snssdk1233',
      ],
    },
    appleTeamId: 'WL5ALL46C4',
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: ['android.permission.RECORD_AUDIO', 'android.permission.RECORD_AUDIO'],
    package: ANDROID_PACKAGE,
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#ffffff',
        dark: { backgroundColor: '#000000' },
      },
    ],
    './plugins/with-share-extension',
    './plugins/with-resource-bundle-signing-fix',
    [
      'expo-image-picker',
      {
        photosPermission:
          'Trip Pocket needs to read photos so you can add screenshots to your trips.',
      },
    ],
    'expo-font',
    'expo-sqlite',
    'expo-web-browser',
    'expo-image',
    [
      '@sentry/react-native',
      {
        organization: 'cong-nguyen',
        project: 'trip-pocket-ios',
        url: 'https://sentry.io/',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    extractionProxyUrl: 'https://trip-pocket-extract-proxy.ankerek.workers.dev/extract',
    enrichmentProxyUrl: 'https://trip-pocket-extract-proxy.ankerek.workers.dev/enrich',
    photoProxyUrlBase: 'https://trip-pocket-extract-proxy.ankerek.workers.dev/photo',
    fetchPostProxyUrl: 'https://trip-pocket-extract-proxy.ankerek.workers.dev/fetch-post',
    appVariant: IS_DEV ? 'development' : 'production',
    eas: {
      projectId: '2dee30ac-eb35-4cc6-80d7-4e6a664237b5',
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: 'TripPocketShare',
                bundleIdentifier: `${BUNDLE_ID}.share`,
                entitlements: {
                  'com.apple.security.application-groups': ['group.com.trippocket.shared'],
                },
              },
            ],
          },
        },
      },
    },
  },
  owner: 'ankerek',
};

export default config;
