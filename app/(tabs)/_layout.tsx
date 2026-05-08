import { Tabs } from 'expo-router';
import { TabBar } from '@/components/TabBar';

// Custom JS tab bar — see spec §11. Replaces expo-router/unstable-native-tabs
// because we need a center capture-FAB slot that UIKit's UITabBarController
// does not own. The (settings) tab is gone; settings is a modal sheet
// reachable via the HeaderProfile avatar in each tab's header.
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <TabBar {...props} />}
    >
      <Tabs.Screen name="(places)" options={{ title: 'Pocket' }} />
      <Tabs.Screen name="(trips)" options={{ title: 'Trips' }} />
    </Tabs>
  );
}
