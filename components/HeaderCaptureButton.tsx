import { useRouter, usePathname } from 'expo-router';
import { useDatabase } from '@/components/useDatabase';
import { pickPhotosForImport } from '@/components/pickPhotos';
import { HeaderActionButton } from '@/components/HeaderActionButton';
import { useEntitlement } from '@/lib/entitlement/provider';
import { openLapsePaywall } from '@/lib/paywall/openLapsePaywall';

export function HeaderCaptureButton() {
  const db = useDatabase();
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useEntitlement();
  return (
    <HeaderActionButton
      icon="plus"
      accessibilityLabel="Add place"
      accessibilityHint="Add from Photos"
      onPress={() => {
        if (!db) return;
        if (status === 'inactive') {
          openLapsePaywall(router, pathname);
          return;
        }
        void pickPhotosForImport(db, { getEntitlementStatus: () => status }).then((outcome) => {
          if (outcome.entitlementRequired) openLapsePaywall(router, pathname);
        });
      }}
    />
  );
}
