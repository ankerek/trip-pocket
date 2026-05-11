import { useState } from 'react';
import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';
import { Alert } from 'react-native';
import { Pressable, ScrollView, Text, View } from '@/tw';

// Settings is now a modal sheet (presentation: 'formSheet') registered
// in app/_layout.tsx. The (tabs)/(settings) group is removed in this
// redesign — see spec §11.
export default function Settings() {
  // Setting this to true triggers a re-render that throws, which the
  // top-level Sentry.ErrorBoundary catches.
  const [throwOnRender, setThrowOnRender] = useState(false);
  if (throwOnRender) {
    throw new Error('Trip Pocket diagnostics: forced render error');
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-bg"
      contentContainerClassName="p-6"
    >
      <View>
        <Text className="text-lg font-semibold text-text">Trip Pocket</Text>
        <Text className="mt-1 text-sm text-text-muted">
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
        <Text className="mt-1 text-xs text-text-muted">
          Verifies the crash-reporting pipeline. Safe to tap.
        </Text>

        <Pressable
          onPress={() => {
            Sentry.captureException(
              new Error('Trip Pocket diagnostics: test event'),
            );
            Alert.alert('Sent', 'Test event dispatched to Sentry.');
          }}
          accessibilityRole="button"
          accessibilityLabel="Send test event to Sentry"
          className="mt-4 rounded-2xl px-4 py-3"
          style={{ backgroundColor: 'rgba(20, 184, 166, 0.1)' }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#14b8a6' }}>
            Send test event
          </Text>
          <Text className="mt-1 text-text-muted" style={{ fontSize: 12 }}>
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
          <Text className="mt-1 text-text-muted" style={{ fontSize: 12 }}>
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
          <Text className="mt-1 text-text-muted" style={{ fontSize: 12 }}>
            Closes the app. Crash arrives in Sentry on next launch.
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
