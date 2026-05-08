import { Stack } from 'expo-router';
import { HeaderProfile } from '@/components/HeaderProfile';

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
        headerLeft: () => <HeaderProfile />,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Pocket' }} />
    </Stack>
  );
}
