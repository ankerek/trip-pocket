import { Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton, SecondaryButton } from '@/components/onboarding/PrimaryButton';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';
import { useOnboarding } from '@/lib/onboarding/state';
import { ensurePhotosAccess } from '@/lib/permissions/photos';

// Screen 8 — Photos permission primer. The only permission Trip Pocket
// requests at first launch; Info.plist declares photos only (no
// notifications, no location, no camera). We never call into the system
// dialog directly without showing this primer first.

type Bullet = { icon: string; text: string };

const BULLETS: Bullet[] = [
  { icon: 'lock.shield', text: 'On-device OCR. Your photos never go to a server.' },
  { icon: 'tray.and.arrow.down', text: 'Pick which screenshots come in. You stay in control.' },
  { icon: 'bolt.fill', text: 'Skip if you\'d rather start fresh with the share sheet.' },
];

export default function PhotosScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { set } = useOnboarding();

  async function handleAllow() {
    await ensurePhotosAccess(); // result is intentionally ignored — Photos
    // is a soft permission for Trip Pocket; the share sheet still works
    // regardless. We mark the primer "shown" either way so the user isn't
    // re-asked.
    set('photosPrimed', true);
    router.push('/onboarding/processing');
  }

  function handleSkip() {
    set('photosPrimed', true);
    router.push('/onboarding/processing');
  }

  return (
    <OnboardingScaffold
      step={7}
      headline="Pull in the screenshots you've already taken."
      sub="Trip Pocket needs Photos access to scan your existing travel screenshots — nothing leaves your device."
      footer={
        <View>
          <PrimaryButton label="Allow Photos access" onPress={handleAllow} />
          <View style={{ height: 4 }} />
          <SecondaryButton label="Not now" onPress={handleSkip} />
        </View>
      }
    >
      <View className="mt-2">
        {BULLETS.map((b) => (
          <View key={b.icon} className="mb-3 flex-row items-start">
            <View
              className="mr-3 h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)' }}
            >
              <Icon name={b.icon} size={20} tintColor={colors.accent} />
            </View>
            <View className="flex-1" style={{ paddingTop: 8 }}>
              <Text
                className="text-text"
                style={{ fontSize: 15, lineHeight: 22, fontWeight: '500' }}
              >
                {b.text}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </OnboardingScaffold>
  );
}
