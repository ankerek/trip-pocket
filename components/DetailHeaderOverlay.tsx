import { type ReactNode } from 'react';
import { Pressable, View, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '@/components/Icon';

type DetailHeaderOverlayProps = {
  right?: ReactNode;
};

type DetailHeaderIconButtonProps = {
  accessibilityLabel: string;
  icon: string;
  onPress: () => void;
};

export function DetailHeaderOverlay({ right }: DetailHeaderOverlayProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        paddingTop: insets.top + 8,
        paddingHorizontal: 14,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <DetailHeaderIconButton
        icon="chevron.left"
        accessibilityLabel="Back"
        onPress={() => router.back()}
      />
      {right ? <View pointerEvents="box-none">{right}</View> : null}
    </View>
  );
}

export function DetailHeaderIconButton({
  accessibilityLabel,
  icon,
  onPress,
}: DetailHeaderIconButtonProps) {
  // Theme-aware translucent pill so the button reads on photos AND on the
  // bare `bg-bg` surface that shows during loading / error states. In light
  // mode that's a white pill with a dark glyph; in dark mode it's a slate
  // pill with a white glyph.
  const isDark = useColorScheme() === 'dark';
  const fill = isDark ? 'rgba(15,23,42,0.7)' : 'rgba(255,255,255,0.84)';
  const stroke = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)';
  const glyph = isDark ? '#f8fafc' : '#0f172a';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: fill,
        borderWidth: 1,
        borderColor: stroke,
        opacity: pressed ? 0.86 : 1,
        transform: [{ scale: pressed ? 1.08 : 1 }],
      })}
    >
      <Icon name={icon} size={24} tintColor={glyph} />
    </Pressable>
  );
}
