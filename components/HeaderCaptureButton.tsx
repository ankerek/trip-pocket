import { Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Icon } from '@/components/Icon';
import { useDatabase } from '@/components/useDatabase';
import { pickPhotosForImport } from '@/components/pickPhotos';
import { useThemeColors } from '@/tw/theme';
import { useEntitlement } from '@/lib/entitlement/provider';
import { openLapsePaywall } from '@/lib/paywall/openLapsePaywall';

export function HeaderCaptureButton() {
  const db = useDatabase();
  const colors = useThemeColors();
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useEntitlement();
  return (
    <Pressable
      onPress={() => {
        if (!db) return;
        if (process.env.EXPO_OS === 'ios') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
        if (status === 'inactive') {
          openLapsePaywall(router, pathname);
          return;
        }
        void pickPhotosForImport(db, { getEntitlementStatus: () => status }).then((outcome) => {
          if (outcome.entitlementRequired) openLapsePaywall(router, pathname);
        });
      }}
      accessibilityRole="button"
      accessibilityLabel="Add place"
      accessibilityHint="Add from Photos"
      hitSlop={8}
      style={{ paddingHorizontal: 12 }}
    >
      <Icon name="plus" size={22} tintColor={colors.text} />
    </Pressable>
  );
}
