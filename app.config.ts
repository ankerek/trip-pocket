import type { ExpoConfig } from 'expo/config';

// APP_VARIANT=development gives a side-by-side install with its own bundle
// identifier, display name, and URL scheme. The App Group stays shared
// with production so SQLite + pending-imports inbox are the same; this is
// usually fine but means dev migrations can mutate prod's schema. Promote
// to a per-variant App Group if that bites.
const IS_DEV = process.env.APP_VARIANT === 'development';

const BUNDLE_ID = IS_DEV ? 'com.trippocket.app.dev' : 'com.trippocket.app';

// Tie the RC key to the bundle variant. The dev RC project is a separate
// project so daily dev work (grants, test customers) doesn't pollute the
// prod project. Falls back to the prod key if the dev key isn't set so
// existing devs without the new env var keep working.
const RC_IOS_API_KEY = IS_DEV
  ? (process.env.EXPO_PUBLIC_RC_IOS_API_KEY_DEV ?? process.env.EXPO_PUBLIC_RC_IOS_API_KEY ?? '')
  : (process.env.EXPO_PUBLIC_RC_IOS_API_KEY ?? '');
const ANDROID_PACKAGE = IS_DEV ? 'com.trippocket.app.dev' : 'com.trippocket.app';
const APP_NAME = IS_DEV ? 'Trip Pocket Dev' : 'Trip Pocket';
const SCHEME = IS_DEV ? 'trippocket-dev' : 'trippocket';

const config: ExpoConfig = {
  name: APP_NAME,
  slug: 'trip-pocket',
  version: '0.3.2',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: SCHEME,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: '2026051701',
    icon: './assets/AppIcon.icon',
    supportsTablet: false,
    entitlements: {
      'com.apple.security.application-groups': ['group.com.trippocket.shared'],
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      LSApplicationQueriesSchemes: ['comgooglemaps', 'instagram', 'tiktok', 'snssdk1233'],
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
    './plugins/with-prewarm-session',
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
    // Composable extraction pipeline (spec
    // docs/superpowers/specs/2026-05-16-extraction-pipeline-composability-design.md
    // + the video follow-up spec 2026-05-16-video-place-extraction-design.md).
    //   'ocrTextLLM'        — legacy OCR-then-text path (single-flip rollback target)
    //   'vision'            — direct image → Gemini Vision (force-mode, ignores caption)
    //   'video'             — prefer videoPlusCaption on rows that have a videoUrl
    //                         (Reels / TikTok videos); other rows soft-degrade to
    //                         ocrTextLLM. Developer-only A/B testing knob.
    //   'captionPlusVision' — NOT a valid forceStrategy; picked only by auto
    //   'videoPlusCaption'  — NOT a valid forceStrategy; picked only by auto when
    //                         videoUrl is present
    //   'auto'              — image sources use vision; URL sources use
    //                         videoPlusCaption when videoUrl is present, else
    //                         captionPlusVision when a caption is present, else vision
    // Auto is the production default. To roll back (e.g. if vision quality
    // disappoints on real users): change this to 'ocrTextLLM' and ship a
    // new build. Existing in-flight vision rows finish on vision; new rows
    // route through the OCR path immediately.
    forceStrategy: 'auto' as const,
    rcIosApiKey: RC_IOS_API_KEY,
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
