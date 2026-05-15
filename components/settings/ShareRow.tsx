import { Alert, Share } from 'react-native';
import { View } from '@/tw';
import { APP_STORE_URL } from '@/lib/links';
import { SectionHeader } from './SectionHeader';
import { SettingsRow } from './SettingsRow';

export function ShareRow() {
  const onShare = async () => {
    try {
      await Share.share({
        message: `Trip Pocket — your pocket for travel ideas. ${APP_STORE_URL}`,
        url: APP_STORE_URL,
      });
    } catch {
      Alert.alert('Couldn’t open share sheet', 'Please try again.');
    }
  };

  return (
    <View>
      <SectionHeader label="SHARE" />
      <SettingsRow
        title="Tell a friend about Trip Pocket"
        subtitle="Send a link via Messages, Mail, or anywhere else."
        onPress={() => void onShare()}
        accessibilityLabel="Share Trip Pocket"
      />
    </View>
  );
}
