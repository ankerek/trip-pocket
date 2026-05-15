import { Stack } from 'expo-router';

export default function PlacesStack() {
  return (
    <Stack
      screenOptions={{
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerLargeStyle: { backgroundColor: 'transparent' },
        headerLargeTitle: true,
        headerBlurEffect: 'systemMaterial',
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      {/* The Pocket index hides the native header and renders its own
          title row so the + add button sits on the same line as the big
          "Pocket" text (iOS large-title headers always place headerRight
          in the small bar above the title). Other screens in this stack
          keep the inherited large-title behavior. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
