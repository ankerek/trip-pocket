import { useEffect } from 'react';
import { View as RNView, type ViewStyle, type StyleProp } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useThemeColors } from '@/tw/theme';

// Cross-fade between two opacities (~0.4 ↔ ~0.85) on a single shared value.
// One driver per mount; cheap on the JS thread. Worklets run on the UI thread.
function usePulse() {
  const v = useSharedValue(0.4);
  useEffect(() => {
    v.value = withRepeat(
      withTiming(0.85, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(v);
  }, [v]);
  return useAnimatedStyle(() => ({ opacity: v.value }));
}

type CommonProps = {
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/** Fills its parent (or whatever `style` defines). Used as a hero / cover
 * placeholder where the surrounding box already has fixed dimensions. */
export function SkeletonBlock({ testID, style }: CommonProps) {
  const colors = useThemeColors();
  const animStyle = usePulse();
  return (
    <Animated.View
      testID={testID ?? 'skeleton-block'}
      style={[
        { width: '100%', height: '100%', backgroundColor: colors.surface },
        style,
        animStyle,
      ]}
    />
  );
}

/** Single text-line bar at a given width. Default height 12px. */
export function SkeletonLine({
  testID,
  widthPercent = 100,
  height = 12,
  style,
}: CommonProps & { widthPercent?: number; height?: number }) {
  const colors = useThemeColors();
  const animStyle = usePulse();
  return (
    <Animated.View
      testID={testID ?? 'skeleton-line'}
      style={[
        {
          width: `${widthPercent}%`,
          height,
          borderRadius: 4,
          backgroundColor: colors.surface,
        },
        style,
        animStyle,
      ]}
    />
  );
}

/** Stack of `count` text-line bars at descending widths. Used for paragraph
 * placeholders (description, etc.). Bars share one pulse for visual unity. */
export function SkeletonLines({
  count,
  testID,
}: CommonProps & { count: number }) {
  const widths = [100, 92, 60, 84, 70];
  return (
    <RNView testID={testID ?? 'skeleton-lines'} style={{ gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonLine
          key={i}
          widthPercent={widths[i] ?? 80}
          testID={`skeleton-lines-${i}`}
        />
      ))}
    </RNView>
  );
}

/** Mirror of PlaceSelectRow geometry: 44×44 leading square + two stacked
 * text bars. Used by the Triage card while OCR/extraction is in flight. */
export function SkeletonRow({ testID }: CommonProps) {
  const colors = useThemeColors();
  const pulse = usePulse();
  const surface = { backgroundColor: colors.surface };
  return (
    <RNView
      testID={testID ?? 'skeleton-row'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.hairline,
      }}
    >
      <Animated.View style={[{ width: 44, height: 44, borderRadius: 10 }, surface, pulse]} />
      <RNView style={{ flex: 1, gap: 6 }}>
        <Animated.View
          style={[{ width: '60%', height: 13, borderRadius: 4 }, surface, pulse]}
        />
        <Animated.View
          style={[{ width: '38%', height: 11, borderRadius: 4 }, surface, pulse]}
        />
      </RNView>
    </RNView>
  );
}
