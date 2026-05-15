import { useState } from 'react';
import * as Sentry from '@sentry/react-native';
import { Alert, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { Text, View } from '@/tw';
import { isFirehoseEnabled, setFirehose } from '@/modules/pipeline-log';
import { resetOnboarding } from '@/lib/onboarding/storage';
import { SectionHeader } from './SectionHeader';
import { SettingsRow } from './SettingsRow';

type Props = {
  onForceRenderError: () => void;
};

export function DeveloperSection({ onForceRenderError }: Props) {
  const router = useRouter();
  // Mirror the firehose flag so the Switch reflects the change immediately —
  // setFirehose updates the in-memory cache synchronously before its SQLite
  // write, but the Switch needs local React state to re-render.
  const [firehoseOn, setFirehoseOn] = useState<boolean>(isFirehoseEnabled());

  return (
    <View>
      <SectionHeader label="DEVELOPER" hint="Internal diagnostics. Hidden from regular users." />

      <SettingsRow
        title="Send test event"
        subtitle="Non-destructive — just dispatches a captureException call."
        onPress={() => {
          Sentry.captureException(new Error('Trip Pocket diagnostics: test event'));
          Alert.alert('Sent', 'Test event dispatched to Sentry.');
        }}
        accessibilityLabel="Send test event to Sentry"
      />

      <SettingsRow
        title="Throw render error"
        subtitle="Triggers the branded ErrorBoundary fallback."
        onPress={onForceRenderError}
        accessibilityLabel="Throw a render error to test the ErrorBoundary"
      />

      <SettingsRow
        title="Force native crash"
        subtitle="Closes the app. Crash arrives in Sentry on next launch."
        tone="danger"
        onPress={() => {
          Alert.alert(
            'Force native crash?',
            'This will close the app immediately. The crash will be reported next launch.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Crash', style: 'destructive', onPress: () => Sentry.nativeCrash() },
            ],
          );
        }}
        accessibilityLabel="Force a native crash"
      />

      <SettingsRow
        title="Pipeline log"
        subtitle="Per-source stage history for capture, OCR, extraction, enrichment."
        // Typed-routes for app/diagnostics/* are only generated once the
        // dev server has scanned the route tree; cast keeps tsc happy in CI.
        onPress={() => router.push('/diagnostics/pipeline-log' as never)}
        accessibilityLabel="Open Pipeline log"
      />

      <SettingsRow
        title="Replay onboarding"
        subtitle="Re-runs the welcome flow from the top. Useful for QA."
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
                  router.replace('/onboarding');
                },
              },
            ],
          );
        }}
        accessibilityLabel="Replay onboarding flow"
      />

      {__DEV__ ? (
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
              setFirehoseOn(v);
              void setFirehose(v);
            }}
            accessibilityLabel="Toggle pipeline firehose"
          />
        </View>
      ) : null}
    </View>
  );
}
