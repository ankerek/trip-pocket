import { useState } from 'react';
import { Pressable, Text, View } from '@/tw';
import { useRouter } from 'expo-router';
import { OnboardingScaffold } from '@/components/onboarding/OnboardingScaffold';
import { PrimaryButton } from '@/components/onboarding/PrimaryButton';
import { useOnboarding, type Category } from '@/lib/onboarding/state';
import { useThemeColors } from '@/tw/theme';
import * as Haptics from 'expo-haptics';

// Screen 7 — Preferences. 2-col grid of categories with emoji + label +
// helper line. Multi-select. Narrows the demo seed pool on Screen 10.

type Opt = { id: Category; emoji: string; label: string; desc: string };

const OPTIONS: Opt[] = [
  { id: 'food', emoji: '🍜', label: 'Food', desc: 'Cafés, restaurants, bakeries' },
  { id: 'culture', emoji: '🏛️', label: 'Culture', desc: 'Museums, temples, neighborhoods' },
  { id: 'nature', emoji: '🏞️', label: 'Nature', desc: 'Viewpoints, parks, hikes' },
  { id: 'stays', emoji: '🛏️', label: 'Stays', desc: 'Hotels, ryokans, BnBs' },
  { id: 'shopping', emoji: '🛍️', label: 'Shopping', desc: 'Markets, boutiques' },
  { id: 'nightlife', emoji: '🌃', label: 'Nightlife', desc: 'Bars, izakayas, clubs' },
];

export default function PreferencesScreen() {
  const router = useRouter();
  const { answers, set } = useOnboarding();
  const [picked, setPicked] = useState<Category[]>(answers.categories);

  function toggle(id: Category) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <OnboardingScaffold
      step={6}
      headline="What do you save most?"
      sub="Pick a few — we'll prep your starter trip around it."
      footer={
        <PrimaryButton
          label="Continue"
          disabled={picked.length === 0}
          onPress={() => {
            set('categories', picked);
            router.push('/onboarding/photos');
          }}
        />
      }
    >
      <View className="flex-row flex-wrap" style={{ gap: 10 }}>
        {OPTIONS.map((o) => (
          <CategoryCard
            key={o.id}
            opt={o}
            selected={picked.includes(o.id)}
            onPress={() => {
              void Haptics.selectionAsync();
              toggle(o.id);
            }}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}

function CategoryCard({
  opt,
  selected,
  onPress,
}: {
  opt: Opt;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={opt.label}
      style={{
        width: '48%',
        paddingVertical: 16,
        paddingHorizontal: 14,
        borderRadius: 16,
        backgroundColor: colors.surface,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.accent : colors.hairline,
      }}
    >
      <Text style={{ fontSize: 28 }}>{opt.emoji}</Text>
      <Text
        className="mt-2 text-text"
        style={{ fontSize: 16, fontWeight: '700', letterSpacing: -0.2 }}
      >
        {opt.label}
      </Text>
      <Text className="mt-1 text-text-muted" style={{ fontSize: 12, lineHeight: 17 }}>
        {opt.desc}
      </Text>
    </Pressable>
  );
}
