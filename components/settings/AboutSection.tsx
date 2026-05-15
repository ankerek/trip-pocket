import Constants from 'expo-constants';
import { Pressable, Text, View } from '@/tw';

type Props = {
  onVersionTap: () => void;
};

export function AboutSection({ onVersionTap }: Props) {
  const version = Constants.expoConfig?.version ?? 'dev';
  const build = Constants.expoConfig?.ios?.buildNumber;
  const versionLine = build ? `Version ${version} (${build})` : `Version ${version}`;

  return (
    <View className="mt-10 items-center">
      <Text className="text-text text-lg font-semibold">Trip Pocket</Text>
      <Text className="text-text-muted mt-1 text-sm">Your pocket for travel ideas.</Text>
      <Pressable
        onPress={onVersionTap}
        accessibilityRole="button"
        accessibilityLabel={versionLine}
        // Hit-target slightly bigger than the text so the 7-tap reveal is
        // findable but the row still looks like a passive label.
        hitSlop={8}
        className="mt-2"
      >
        <Text className="text-text-muted text-xs">{versionLine}</Text>
      </Pressable>
    </View>
  );
}
