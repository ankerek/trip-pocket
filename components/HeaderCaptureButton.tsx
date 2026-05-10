import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';
import { useDatabase } from '@/components/useDatabase';
import { showCaptureActionSheet } from '@/components/CaptureActionSheet';
import { useThemeColors } from '@/tw/theme';

export function HeaderCaptureButton() {
  const db = useDatabase();
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => {
        if (!db) return;
        if (process.env.EXPO_OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
        showCaptureActionSheet(db);
      }}
      accessibilityRole="button"
      accessibilityLabel="Add place"
      accessibilityHint="Add screenshots from Photos or take a new photo"
      hitSlop={8}
      style={{ paddingHorizontal: 12 }}
    >
      <Icon name="plus" size={22} tintColor={colors.text} />
    </Pressable>
  );
}
