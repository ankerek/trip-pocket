import { Alert, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { View } from '@/tw';
import { FAQ_URL, SUPPORT_EMAIL } from '@/lib/links';
import { SectionHeader } from './SectionHeader';
import { SettingsRow } from './SettingsRow';

function buildMailto(): string {
  const version = Constants.expoConfig?.version ?? 'dev';
  const build = Constants.expoConfig?.ios?.buildNumber ?? '—';
  const os = `${Platform.OS} ${Platform.Version}`;
  const subject = encodeURIComponent('Trip Pocket support');
  // Two blank lines below the user's text so the diagnostic footer reads as
  // its own block — easier on whoever triages the email.
  const body = encodeURIComponent(
    `\n\n---\nApp: Trip Pocket ${version} (build ${build})\nOS: ${os}\n`,
  );
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

export function SupportSection() {
  const onContact = async () => {
    try {
      await Linking.openURL(buildMailto());
    } catch {
      Alert.alert('No email account', `Email us at ${SUPPORT_EMAIL} and we’ll get back to you.`);
    }
  };

  const onFaq = () => {
    void WebBrowser.openBrowserAsync(FAQ_URL);
  };

  return (
    <View>
      <SectionHeader label="SUPPORT" />
      <SettingsRow
        title="Contact support"
        subtitle={`Email ${SUPPORT_EMAIL} — we read every message.`}
        onPress={() => void onContact()}
        accessibilityLabel="Contact support by email"
      />
      <SettingsRow
        title="FAQ"
        subtitle="Answers to common questions."
        onPress={onFaq}
        accessibilityLabel="Open frequently asked questions"
      />
    </View>
  );
}
