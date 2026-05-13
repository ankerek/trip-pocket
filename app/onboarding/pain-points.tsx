import { useState } from 'react';
import { View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { OptionRow } from '@/components/onboarding/OptionRow';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';

// Screen 3 — Pain points. Multi-select. Used to make the user feel
// understood; no downstream logic depends on the picks. Selections are
// component-local — the v2 OnboardingAnswers shape no longer carries
// painPoints (spec: 2026-05-13-onboarding-redesign-design.md).
const OPTIONS: { id: string; label: string }[] = [
  { id: 'camera-roll', label: 'Camera roll full of screenshots I never look at again' },
  { id: 'forgot-which', label: "I can't remember which café I screenshotted" },
  { id: 'notion-doc', label: "It's in a Notion doc somewhere… I think" },
  { id: 'ig-saves', label: 'Saved on Instagram, buried under 500 other saves' },
  { id: 'google-airport', label: 'I end up Googling the same place twice at the airport' },
  { id: 'wrong-city', label: 'I lose track of what\'s in which city' },
  { id: 'recs', label: "My friends ask me for recs and I can't find them" },
];

export default function PainPointsScreen() {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <OnboardingScaffold
      step={2}
      headline="Where do your travel ideas go to die?"
      sub="Pick everything that's happened to you."
      footer={
        <PrimaryButton
          label="Continue"
          onPress={() => router.push('/onboarding/solution')}
        />
      }
    >
      <View>
        {OPTIONS.map((opt) => (
          <OptionRow
            key={opt.id}
            label={opt.label}
            variant="multi"
            selected={picked.includes(opt.id)}
            onPress={() => toggle(opt.id)}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}
