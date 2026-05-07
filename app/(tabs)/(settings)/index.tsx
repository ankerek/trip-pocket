import Constants from 'expo-constants';
import { ScrollView, Text, View } from '@/tw';

export default function Settings() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-white"
      contentContainerClassName="p-6"
    >
      <View>
        <Text className="text-lg font-semibold text-slate-900">Trip Pocket</Text>
        <Text className="mt-1 text-sm text-slate-500">
          Version {Constants.expoConfig?.version ?? 'dev'}
        </Text>
      </View>
    </ScrollView>
  );
}
