import Constants from 'expo-constants';
import { ScrollView, Text, View } from '@/tw';

// Settings is now a modal sheet (presentation: 'formSheet') registered
// in app/_layout.tsx. The (tabs)/(settings) group is removed in this
// redesign — see spec §11.
export default function Settings() {
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
    </ScrollView>
  );
}
