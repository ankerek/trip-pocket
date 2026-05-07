import Constants from 'expo-constants';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Settings() {
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="p-6">
        <Text className="text-lg font-semibold text-slate-900">Trip Pocket</Text>
        <Text className="mt-1 text-sm text-slate-500">
          Version {Constants.expoConfig?.version ?? 'dev'}
        </Text>
      </View>
    </SafeAreaView>
  );
}
