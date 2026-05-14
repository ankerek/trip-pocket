import { useState } from 'react';
import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';
import { Alert, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { isFirehoseEnabled, setFirehose } from '@/modules/pipeline-log';
import { resetOnboarding } from '@/lib/onboarding/storage';

// Settings is now a modal sheet (presentation: 'formSheet') registered
// in app/_layout.tsx. The (tabs)/(settings) group is removed in this
// redesign — see spec §11.
export default function Settings() {
  const router = useRouter();
  // Setting this to true triggers a re-render that throws, which the
  // top-level Sentry.ErrorBoundary catches.
  const [throwOnRender, setThrowOnRender] = useState(false);
  // Firehose flag is module-level + sync-readable; the toggle keeps a local
  // mirror so the Switch reflects the change immediately. setFirehose itself
  // updates the in-memory cache synchronously before the SQLite write.
  const [firehoseOn, setFirehoseOn] = useState<boolean>(isFirehoseEnabled());
  if (throwOnRender) {
    throw new Error('Trip Pocket diagnostics: forced render error');
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="bg-bg flex-1"
      contentContainerClassName="p-6"
    >
      <View>
        <Text className="text-text text-lg font-semibold">Trip Pocket</Text>
        <Text className="text-text-muted mt-1 text-sm">
          Version {Constants.expoConfig?.version ?? 'dev'}
        </Text>
      </View>

      <View className="mt-8">
        <Text
          className="text-text-muted"
          style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.5 }}
        >
          DIAGNOSTICS
        </Text>
        <Text className="text-text-muted mt-1 text-xs">
          Verifies the crash-reporting pipeline. Safe to tap.
        </Text>

        <Pressable
          onPress={() => {
            Sentry.captureException(new Error('Trip Pocket diagnostics: test event'));
            Alert.alert('Sent', 'Test event dispatched to Sentry.');
          }}
          accessibilityRole="button"
          accessibilityLabel="Send test event to Sentry"
          className="mt-4 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6' }}>Send test event</Text>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            Non-destructive — just dispatches a captureException call.
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setThrowOnRender(true)}
          accessibilityRole="button"
          accessibilityLabel="Throw a render error to test the ErrorBoundary"
          className="mt-2 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6' }}>
            Throw render error
          </Text>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            Triggers the branded ErrorBoundary fallback.
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            Alert.alert(
              'Force native crash?',
              'This will close the app immediately. The crash will be reported next launch.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Crash',
                  style: 'destructive',
                  onPress: () => Sentry.nativeCrash(),
                },
              ],
            );
          }}
          accessibilityRole="button"
          accessibilityLabel="Force a native crash"
          className="mt-2 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(220, 38, 38, 0.08)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#dc2626' }}>
            Force native crash
          </Text>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            Closes the app. Crash arrives in Sentry on next launch.
          </Text>
        </Pressable>

        <Pressable
          // Typed-routes for app/diagnostics/* are only generated once the
          // dev server has scanned the route tree; cast keeps tsc happy in CI.
          onPress={() => router.push('/diagnostics/pipeline-log' as never)}
          accessibilityRole="button"
          accessibilityLabel="Open Pipeline log"
          className="mt-4 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6' }}>Pipeline log</Text>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            Per-source stage history for capture, OCR, extraction, enrichment.
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            Alert.alert(
              'Replay onboarding?',
              'Resets your onboarding answers and shows the welcome flow again. Trips and places stay intact.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Replay',
                  onPress: () => {
                    resetOnboarding();
                    // Replace the settings sheet with the onboarding
                    // modal — the root Stack's onboarding entry handles
                    // the fullScreenModal presentation.
                    router.replace('/onboarding');
                  },
                },
              ],
            );
          }}
          accessibilityRole="button"
          accessibilityLabel="Replay onboarding flow"
          className="mt-2 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6' }}>
            Replay onboarding
          </Text>
          <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
            Re-runs the welcome flow from the top. Useful for QA.
          </Text>
        </Pressable>

        {__DEV__ && (
          <View
            className="mt-2 flex-row items-center justify-between rounded-2xl px-4 py-3"
            style={{ backgroundColor: 'rgba(20, 184, 166, 0.05)' }}
          >
            <View className="flex-1 pr-3">
              <Text style={{ fontSize: 15, fontWeight: '600' }} className="text-text">
                Pipeline firehose
              </Text>
              <Text className="text-text-muted mt-1" style={{ fontSize: 12 }}>
                Verbose pipeline logs in Metro (dev builds only).
              </Text>
            </View>
            <Switch
              value={firehoseOn}
              onValueChange={(v) => {
                // setFirehose updates the in-memory cache synchronously, so
                // the next stage emission honours the new state immediately.
                // The SQLite write happens in the background — no need to
                // await before flipping the UI state.
                setFirehoseOn(v);
                void setFirehose(v);
              }}
              accessibilityLabel="Toggle pipeline firehose"
            />
          </View>
        )}
      </View>
    </ScrollView>
  );
}
