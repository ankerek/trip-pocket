import '../global.css';
import * as Sentry from '@sentry/react-native';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { AppState, type AppStateStatus, useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { initSentry, attachInstallId } from '@/lib/observability';
import { ErrorFallback } from '@/components/ErrorFallback';
import { ErrorToast } from '@/components/ErrorToast';
import { isOnboardingComplete } from '@/lib/onboarding/storage';
import {
  openDatabase,
  runMigrations,
  migrations,
  provideDatabase,
  type Database,
} from '@/modules/storage';
import {
  getOrCreateOwnerId,
  getAppGroupContainerUri,
  getStorageDirectory,
  cleanupOrphanSources,
  runForegroundIngest,
} from '@/modules/capture';
import { createProcessor, provideProcessor, type Processor } from '@/modules/processing';
import { fetchPostFromProxy } from '@/modules/capture/fetchPostFromProxy';
import { initPipelineLog, sweepPipelineEvents } from '@/modules/pipeline-log';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createExtractor,
  extractFromProxy,
  provideExtractor,
  type Extractor,
} from '@/modules/extraction';
import {
  createEnricher,
  enrichFromProxy,
  provideEnricher,
  type Enricher,
} from '@/modules/enrichment';
import { DETAIL_ROUTE_OPTIONS } from '@/lib/navigation/detailHeaderOptions';
import { recognizeText } from '@/modules/vision-ocr';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import { warmMapAppDetection } from '@/lib/openInMaps';
import { warmSocialAppDetection } from '@/lib/openInSocial';

try {
  initSentry();
} catch {
  // Sentry init must never block app boot.
}

const SHARED_HEADER_OPTIONS = {
  headerTransparent: true,
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerLargeStyle: { backgroundColor: 'transparent' },
  headerBlurEffect: 'systemMaterial',
  headerBackButtonDisplayMode: 'minimal',
} as const;

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [ctx, setCtx] = useState<{
    db: Database;
    ownerId: string;
    storageDirUri: string;
    processor: Processor;
    extractor: Extractor;
    enricher: Enricher;
  } | null>(null);
  const colorScheme = useColorScheme();
  const router = useRouter();
  // Sync filesystem check at first render — cheap, stable across remounts.
  // Reading it once means navigating into onboarding mid-session doesn't
  // pop the user back out when markOnboardingComplete fires inside the flow.
  const needsOnboarding = useMemo(() => !isOnboardingComplete(), []);

  useEffect(() => {
    (async () => {
      // Open the SQLite file inside the App Group container so the share extension
      // and the main app read/write the same database.
      const db = await openDatabase('trip-pocket.db', getAppGroupContainerUri());
      await runMigrations(db, migrations);
      provideDatabase(db);
      void attachInstallId();

      // Pipeline observability: read the firehose flag once at boot so the
      // first stage emission honours its persisted state, then trim the
      // pipeline_events table to the 1000-row LRU cap. Both calls are
      // best-effort — failure must not block app start.
      try {
        await initPipelineLog(db);
        await sweepPipelineEvents(undefined, db);
      } catch (err) {
        console.warn('[pipeline-log] init failed', err);
      }

      // OCR + URL-fetch pipeline. createProcessor + provideProcessor wires up
      // the singleton importImage talks to. runStartupRecovery is the
      // once-per-process retry promotion: 'failed' rows roll back to
      // 'pending' so they get one more 3-try budget this session.
      const fetchPostProxyUrl = Constants.expoConfig?.extra?.fetchPostProxyUrl as
        | string
        | undefined;
      const processor = createProcessor({
        db,
        ocr: recognizeText,
        fetchPost: (postUrl) => fetchPostFromProxy(postUrl, fetchPostProxyUrl ?? ''),
        downloadImage: async (imageUrl) => {
          // Persist cover images alongside screenshots inside the App Group
          // so they survive dev reinstalls and the file_path stays valid.
          const screenshotsDir =
            getAppGroupContainerUri()
              ? new Directory(getAppGroupContainerUri()!, 'screenshots')
              : new Directory(Paths.document, 'screenshots');
          if (!screenshotsDir.exists) screenshotsDir.create({ intermediates: true });
          const downloaded = await File.downloadFileAsync(imageUrl, screenshotsDir);
          return downloaded.uri;
        },
        // Carousel slides 2..N: we OCR them then drop the bytes. The cover
        // (slide 1) is still persisted via downloadImage above and used by the
        // tile / hero. Slides 2..N are visually accessible later through the
        // IG embed iframe in the source detail screen.
        disposeFile: async (path) => {
          try {
            new File(path).delete();
          } catch {
            // Best-effort. A stranded temp file isn't a data integrity issue.
          }
        },
      });
      provideProcessor(processor);
      await processor.runStartupRecovery();

      // Sweep rows whose image file is gone (typically: dev reinstall wiped
      // the old private-sandbox path before sources were colocated into the
      // App Group). Soft-delete keeps the schema invariant clean.
      await cleanupOrphanSources(db);

      const storage = getStorageDirectory();
      const ownerId = getOrCreateOwnerId();

      // AI extraction pipeline. Same lifecycle as OCR: provision the
      // singleton, run startup recovery, run sweep on every foreground.
      // The OCR success path chains here via getExtractor()?.enqueueExtraction.
      const proxyUrl = Constants.expoConfig?.extra?.extractionProxyUrl as string | undefined;
      const extractor = createExtractor({
        db,
        extract: (ocrText) =>
          extractFromProxy(
            ocrText,
            // Empty string at runtime is intentional and visible: extract()
            // hits the URL and gets a network error, which the adapter
            // classifies as retryable. The first extraction attempt fails
            // loudly, the dev fixes app.config.ts, no silent breakage.
            proxyUrl ?? '',
          ),
        ownerId,
        uuid: Crypto.randomUUID,
      });
      provideExtractor(extractor);
      await extractor.runStartupRecovery();

      // Place enrichment runner. On-demand: triggered when the user opens
      // a place card whose status is 'pending' or 'failed'. No sweep, no
      // startup recovery — the user re-opening the card is the retry signal.
      const enrichProxyUrl = Constants.expoConfig?.extra?.enrichmentProxyUrl as string | undefined;
      const enricher = createEnricher({
        db,
        ownerId,
        // Empty-string fallback mirrors the extractor: missing config fails
        // loudly on first call, no silent breakage.
        enrich: (payload) => enrichFromProxy(payload, enrichProxyUrl ?? ''),
      });
      provideEnricher(enricher);

      // Detect installed map apps once per process; lib/openInMaps caches
      // the result. Fire-and-forget — buildMapUrl falls back to Apple
      // Maps until detection completes, which is the safe default.
      void warmMapAppDetection();

      // Same pattern for IG / TikTok — openSourceUrl uses the cache to
      // decide between handing off to the native app and falling back to
      // SFSafariViewController.
      void warmSocialAppDetection();

      setCtx({ db, ownerId, storageDirUri: storage.uri, processor, extractor, enricher });
      setReady(true);
    })().catch((err) => {
      console.error('[RootLayout] init failed', err);
    });
  }, []);

  useEffect(() => {
    if (!ctx) return;
    // Foreground ingest is now a singleton helper (modules/capture/
    // runForegroundIngest) so pull-to-refresh in (places)/index.tsx can
    // share the same in-flight mutex. See spec §4.1.
    void runForegroundIngest(ctx.db);
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') void runForegroundIngest(ctx.db);
    });
    return () => sub.remove();
  }, [ctx]);

  // First-launch redirect. Fires once after the boot pipeline is ready so
  // we don't race the router. We `push` (rather than `replace`) so the
  // underlying (tabs) stays mounted beneath the modal — that way the
  // paywall exit can `dismissAll()` and reveal it instantly with no second
  // slide-in transition on top of the modal's fade-out.
  useEffect(() => {
    if (!ready) return;
    if (!needsOnboarding) return;
    router.push('/onboarding');
  }, [ready, needsOnboarding, router]);

  if (!ready) return null;
  return (
    <Sentry.ErrorBoundary fallback={ErrorFallback}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="onboarding"
            options={{
              headerShown: false,
              // Onboarding is a full-screen modal stack — block the swipe-
              // down dismissal so a fat-fingered gesture can't escape the
              // flow without completing it. The flow exits via either the
              // paywall "Start trial" CTA or its decline "x" affordance,
              // both of which call markOnboardingComplete().
              presentation: 'fullScreenModal',
              gestureEnabled: false,
              animation: 'fade',
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              headerShown: true,
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.5, 1.0],
              title: 'Settings',
              ...SHARED_HEADER_OPTIONS,
            }}
          />
          <Stack.Screen
            name="triage"
            options={{
              headerShown: false,
              presentation: 'fullScreenModal',
              animation: 'slide_from_bottom',
            }}
          />
          <Stack.Screen name="places/[id]" options={DETAIL_ROUTE_OPTIONS} />
          <Stack.Screen name="sources/[id]" />
          <Stack.Screen name="trips/[id]" options={DETAIL_ROUTE_OPTIONS} />
          <Stack.Screen
            name="trips/new"
            options={{
              headerShown: true,
              presentation: 'modal',
              title: 'New trip',
              ...SHARED_HEADER_OPTIONS,
            }}
          />
          <Stack.Screen
            name="trips/[id]/edit"
            options={{
              headerShown: true,
              presentation: 'modal',
              title: 'Edit trip',
              ...SHARED_HEADER_OPTIONS,
            }}
          />
          <Stack.Screen
            name="sources/[id]/ocr-debug"
            options={{
              headerShown: true,
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.5, 1.0],
              title: 'OCR debug',
            }}
          />
          <Stack.Screen
            name="diagnostics/pipeline-log"
            options={{
              headerShown: true,
              title: 'Pipeline log',
              ...SHARED_HEADER_OPTIONS,
            }}
          />
          <Stack.Screen
            name="sources/[id]/places-found"
            options={{
              headerShown: true,
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              sheetAllowedDetents: [0.5, 1.0],
              title: 'Places',
            }}
          />
        </Stack>
        <ErrorToast />
      </ThemeProvider>
    </Sentry.ErrorBoundary>
  );
}
