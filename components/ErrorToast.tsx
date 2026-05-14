import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, Text, View } from '@/tw';
import { useThemeColors } from '@/tw/theme';
import { _subscribe, dismissToast, type Toast } from '@/lib/toast/toast';

const ENTER_DURATION_MS = 200;
const EXIT_DURATION_MS = 180;

// Root-mounted, single-slot toast renderer. Subscribes to the imperative
// emitter in `lib/toast/toast.ts`. Bottom-anchored above the safe-area inset
// so it clears the NativeTab bar.
export function ErrorToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const translate = useRef(new Animated.Value(120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = _subscribe((next) => setToast(next));
    return () => {
      unsubscribe();
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, []);

  useEffect(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    if (!toast) {
      Animated.parallel([
        Animated.timing(translate, {
          toValue: 120,
          duration: EXIT_DURATION_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: EXIT_DURATION_MS,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(translate, {
        toValue: 0,
        duration: ENTER_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: ENTER_DURATION_MS,
        useNativeDriver: true,
      }),
    ]).start();
    dismissTimer.current = setTimeout(() => dismissToast(), toast.durationMs);
  }, [toast, translate, opacity]);

  if (!toast) return null;

  const isError = toast.kind === 'error';
  const bgColor = isError ? colors.dangerBg : colors.infoBg;
  const textColor = isError ? colors.dangerText : colors.infoText;

  const onPressMessage = () => {
    dismissToast();
  };

  const onPressAction = () => {
    toast.action?.onPress();
    dismissToast();
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: insets.bottom + 12,
        paddingHorizontal: 12,
        opacity,
        transform: [{ translateY: translate }],
      }}
    >
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        testID="error-toast"
        className="flex-row items-center gap-3 rounded-2xl px-4 py-3"
        style={{
          backgroundColor: bgColor,
          shadowColor: '#000',
          shadowOpacity: 0.18,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 6,
        }}
      >
        <Pressable
          onPress={onPressMessage}
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel={toast.message}
        >
          <Text
            className="text-[14px] font-semibold"
            style={{ color: textColor }}
            numberOfLines={3}
          >
            {toast.message}
          </Text>
        </Pressable>
        {toast.action ? (
          <Pressable
            onPress={onPressAction}
            accessibilityRole="button"
            accessibilityLabel={toast.action.label}
            className="px-2 py-1"
          >
            <Text className="text-[14px] font-bold" style={{ color: textColor }}>
              {toast.action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}
