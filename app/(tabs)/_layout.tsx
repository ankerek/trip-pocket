import { NativeTabs } from 'expo-router/unstable-native-tabs';

// Native UITabBar via expo-router/unstable-native-tabs (the React Navigation
// native bottom tab navigator under the hood). On iOS 26 this gives us the
// system Liquid Glass tab bar for free, and `role="search"` renders the
// search trigger as the separate trailing search capsule like iOS Photos.
export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(places)">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'tray', selected: 'tray.full' }}
        />
        <NativeTabs.Trigger.Label>Pocket</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(trips)">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'map', selected: 'map.fill' }}
        />
        <NativeTabs.Trigger.Label>Trip</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="(search)" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
