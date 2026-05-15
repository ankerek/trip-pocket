import * as WebBrowser from 'expo-web-browser';
import { View } from '@/tw';
import { PRIVACY_URL, TERMS_URL } from '@/lib/links';
import { SectionHeader } from './SectionHeader';
import { SettingsRow } from './SettingsRow';

export function LegalSection() {
  return (
    <View>
      <SectionHeader label="LEGAL" />
      <SettingsRow
        title="Terms of Service"
        onPress={() => void WebBrowser.openBrowserAsync(TERMS_URL)}
        accessibilityLabel="Open Terms of Service"
      />
      <SettingsRow
        title="Privacy Policy"
        onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}
        accessibilityLabel="Open Privacy Policy"
      />
    </View>
  );
}
