import { Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { Icon } from '@/components/Icon';
import { useThemeColors } from '@/tw/theme';

// Screen 6 — Personalised solution. Mirrors pain points 1:1 to specific
// app capabilities. Pain lines are quiet text; solution lines bold +
// accent icon. This is the "we heard you, here's exactly how we fix it"
// beat.

type Row = { icon: string; pain: string; solution: string };

const ROWS: Row[] = [
  {
    icon: 'square.and.arrow.down',
    pain: 'Screenshots vanish into your camera roll',
    solution: 'One share to Trip Pocket, sorted into the right trip.',
  },
  {
    icon: 'text.viewfinder',
    pain: 'Blurry IG post, no idea where it is',
    solution: 'AI reads the screenshot — place, city, category, done.',
  },
  {
    icon: 'photo.stack',
    pain: 'Was it that café in Shibuya or Kichijoji?',
    solution: 'Real venue photos and addresses, fetched on demand.',
  },
  {
    icon: 'map.fill',
    pain: 'You re-Google every place at the airport',
    solution: 'One tap opens Google or Apple Maps.',
  },
];

export default function SolutionScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  return (
    <OnboardingScaffold
      step={5}
      headline="Welcome to a smarter way to save travel ideas."
      sub="Here's how Trip Pocket turns this around."
      footer={
        <PrimaryButton
          label="Continue"
          onPress={() => router.push('/onboarding/preferences')}
        />
      }
    >
      <View>
        {ROWS.map((r) => (
          <View
            key={r.icon}
            className="mb-3 flex-row items-start rounded-2xl border border-hairline bg-surface p-4"
          >
            <View
              className="mr-3 h-10 w-10 items-center justify-center rounded-full"
              style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)' }}
            >
              <Icon name={r.icon} size={22} tintColor={colors.accent} />
            </View>
            <View className="flex-1">
              <Text
                className="text-text-muted"
                style={{ fontSize: 13, lineHeight: 18, textDecorationLine: 'line-through' }}
              >
                {r.pain}
              </Text>
              <Text
                className="mt-1 text-text"
                style={{ fontSize: 15, fontWeight: '600', lineHeight: 22, letterSpacing: -0.2 }}
              >
                {r.solution}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </OnboardingScaffold>
  );
}
