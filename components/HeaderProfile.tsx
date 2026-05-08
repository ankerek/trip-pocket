import { useRouter } from 'expo-router';
import { Pressable, Text, View } from '@/tw';

// Avatar-ish header button that opens the Settings modal.
// Spec §3 + §7 — replaces the (settings) tab with a profile entry
// in every tab's top-right header.
export function HeaderProfile() {
  const router = useRouter();
  return (
    <Pressable
      // expo-router's typed-routes generation may not have picked up
      // app/settings.tsx yet during tsc. The path is real at runtime.
      onPress={() => router.push('/settings' as never)}
      accessibilityRole="button"
      accessibilityLabel="Settings"
      hitSlop={8}
      className="mr-1"
    >
      <View
        className="h-8 w-8 items-center justify-center rounded-full bg-surface"
        style={{ borderWidth: 1, borderColor: 'rgba(15,23,42,0.06)' }}
      >
        <Text className="text-sm font-semibold text-text">TP</Text>
      </View>
    </Pressable>
  );
}
