import { Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useThemeColors } from '@/tw/theme';

// Screen 4 — Social proof. Reviews are PLACEHOLDER copy until beta. Replace
// with real App Store / TestFlight quotes before launch.

type Testimonial = { name: string; tag: string; quote: string };

const TESTIMONIALS: Testimonial[] = [
  // TODO replace with real beta review
  {
    name: 'Maya',
    tag: 'Tokyo five times in two years',
    quote: 'I finally stopped re-Googling the same cafés. It\'s just there.',
  },
  // TODO replace with real beta review
  {
    name: 'Jordan',
    tag: 'Digital nomad, SEA loop',
    quote:
      'My camera roll used to be a graveyard. Now my trips actually start with my own ideas.',
  },
  // TODO replace with real beta review
  {
    name: 'Priya',
    tag: 'Plans every trip from IG',
    quote: 'It reads the post, finds the place, opens Maps. Feels like cheating.',
  },
];

export default function SocialProofScreen() {
  const router = useRouter();
  const colors = useThemeColors();

  return (
    <OnboardingScaffold
      step={3}
      headline="Travelers are already saving smarter."
      footer={
        <PrimaryButton
          label="Continue"
          onPress={() => router.push('/onboarding/tinder')}
        />
      }
    >
      <View>
        {TESTIMONIALS.map((t) => (
          <View
            key={t.name}
            className="mb-3 rounded-2xl border border-hairline bg-surface px-4 py-3"
          >
            <Text
              className="text-text"
              style={{ fontSize: 15, lineHeight: 22, fontWeight: '500' }}
            >
              “{t.quote}”
            </Text>
            <View className="mt-2 flex-row items-center">
              <View
                className="h-8 w-8 items-center justify-center rounded-full"
                style={{ backgroundColor: 'rgba(20, 184, 166, 0.10)' }}
              >
                <Text
                  style={{ color: colors.accent, fontSize: 13, fontWeight: '700' }}
                >
                  {t.name[0]}
                </Text>
              </View>
              <View className="ml-2">
                <Text className="text-text" style={{ fontSize: 13, fontWeight: '600' }}>
                  {t.name}
                </Text>
                <Text className="text-text-muted" style={{ fontSize: 12 }}>
                  {t.tag}
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>
    </OnboardingScaffold>
  );
}
