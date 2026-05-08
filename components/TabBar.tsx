import { Pressable, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/tw';
import { Icon } from '@/components/Icon';
import { CaptureFAB } from '@/components/CaptureFAB';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

const TAB_HEIGHT = 56;

// Custom three-zone tab bar — `tab | FAB | tab`. Replaces NativeTabs
// because UIKit's UITabBarController does not own a center FAB slot
// (see spec §11). BlurView provides the systemMaterial effect.
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const totalHeight = TAB_HEIGHT + insets.bottom;

  // Two visible tabs: Pocket (left) and Trips (right). Settings is no
  // longer a tab — it's reachable via the avatar in each tab's header.
  // The (tabs)/_layout only registers (places) and (trips), so we just
  // take whatever order the navigator gives us.
  const visibleRoutes = state.routes;

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: totalHeight,
      }}
      accessibilityRole="tablist"
    >
      <BlurView
        tint="systemMaterial"
        intensity={80}
        style={{
          position: 'absolute',
          inset: 0,
          borderTopWidth: 1,
          borderTopColor: 'rgba(15,23,42,0.06)',
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height: TAB_HEIGHT,
          paddingHorizontal: 12,
        }}
      >
        {visibleRoutes[0] && descriptors[visibleRoutes[0].key] ? (
          <TabItem
            route={visibleRoutes[0]}
            descriptor={descriptors[visibleRoutes[0].key]!}
            isFocused={state.index === state.routes.indexOf(visibleRoutes[0])}
            onPress={() => navigation.navigate(visibleRoutes[0]!.name)}
          />
        ) : null}

        <View
          style={{
            width: 64,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CaptureFAB />
        </View>

        {visibleRoutes[1] && descriptors[visibleRoutes[1].key] ? (
          <TabItem
            route={visibleRoutes[1]}
            descriptor={descriptors[visibleRoutes[1].key]!}
            isFocused={state.index === state.routes.indexOf(visibleRoutes[1])}
            onPress={() => navigation.navigate(visibleRoutes[1]!.name)}
          />
        ) : null}
      </View>
    </View>
  );
}

type TabItemProps = {
  route: BottomTabBarProps['state']['routes'][number];
  descriptor: BottomTabBarProps['descriptors'][string];
  isFocused: boolean;
  onPress: () => void;
};

function TabItem({ route, descriptor, isFocused, onPress }: TabItemProps) {
  const label =
    typeof descriptor?.options.tabBarLabel === 'string'
      ? descriptor.options.tabBarLabel
      : (descriptor?.options.title ?? route.name);

  // SF Symbol per route. Pocket = tray, Trips = map.
  const symbol = TAB_SYMBOLS[route.name] ?? 'square';

  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        height: TAB_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={label}
    >
      <Icon
        name={symbol}
        size={24}
        tintColor={isFocused ? '#0c4a6e' : '#94a3b8'}
      />
      <Text
        className="text-[10px]"
        style={{
          fontWeight: isFocused ? '600' : '500',
          color: isFocused ? '#0c4a6e' : '#94a3b8',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const TAB_SYMBOLS: Record<string, string> = {
  '(places)': 'tray.full',
  '(trips)': 'map',
};
