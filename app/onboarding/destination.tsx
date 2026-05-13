import { useState } from 'react';
import { View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { OptionRow } from '@/components/onboarding/OptionRow';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useOnboarding, type Destination } from '@/lib/onboarding/state';

// Screen 2 — Goal question (destination). Single-select. The answer
// pre-fills the demo seed (Screen 10) and the value-delivery headline
// (Screen 11).

const OPTIONS: { id: Destination; label: string; icon: string }[] = [
  { id: 'japan', label: 'Japan', icon: 'mountain.2.fill' },
  { id: 'sea', label: 'Southeast Asia', icon: 'globe.asia.australia.fill' },
  { id: 'europe', label: 'Europe', icon: 'globe.europe.africa.fill' },
  { id: 'us-roadtrip', label: 'A US road trip', icon: 'road.lanes' },
  { id: 'city-break', label: 'A city break', icon: 'building.2.fill' },
  { id: 'bucket-list', label: 'Bucket-list ideas, broadly', icon: 'sparkles' },
  { id: 'general', label: 'I just love saving travel finds', icon: 'tray.full.fill' },
];

export default function DestinationScreen() {
  const router = useRouter();
  const { answers, set } = useOnboarding();
  const [picked, setPicked] = useState<Destination | null>(answers.destination);

  return (
    <OnboardingScaffold
      step={1}
      headline="What trip are you collecting ideas for?"
      sub="One quick question, so the rest fits you."
      footer={
        <PrimaryButton
          label="Continue"
          disabled={!picked}
          onPress={() => {
            if (!picked) return;
            set('destination', picked);
            router.push('/onboarding/pain-points');
          }}
        />
      }
    >
      <View>
        {OPTIONS.map((opt) => (
          <OptionRow
            key={opt.id}
            label={opt.label}
            icon={opt.icon}
            selected={picked === opt.id}
            onPress={() => setPicked(opt.id)}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}
