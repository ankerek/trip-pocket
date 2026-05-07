import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function Trips() {
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-white">
      <View>
        <Text className="text-base text-slate-500">No trips yet — tap + to create one.</Text>
      </View>
    </SafeAreaView>
  );
}
