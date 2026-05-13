import { Stack } from 'expo-router';
import { OnboardingProvider } from '@/lib/onboarding/state';

// All onboarding answers live in a single context above the stack so each
// screen can read prior selections and persist its own. The flow itself is
// a linear push stack — back/forward via expo-router push/back. On entry
// the provider hydrates from `onboarding-answers.json` so a user who quit
// mid-flow returns to their previous answers (UX nicety, not required for
// the gate).
export default function OnboardingLayout() {
  return (
    <OnboardingProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
    </OnboardingProvider>
  );
}
