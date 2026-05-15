import { useRouter } from 'expo-router';
import { PaywallBody } from '@/components/paywall/PaywallBody';

// Lapse-mode paywall — surfaced when a user with an inactive entitlement taps
// the persistent banner, the header "+" capture button, a paused row, or the
// iOS Share Extension's "Open Trip Pocket to resume" CTA. Presented as a
// gesture-dismissible modal from app/_layout.tsx so the user can return to
// read-only browsing without subscribing.
export default function PaywallLapseScreen() {
  const router = useRouter();

  // Close handlers don't touch onboarding state — this is a returning user.
  const close = () => router.back();

  return (
    <PaywallBody
      headline="Welcome back to Trip Pocket"
      onSuccess={close}
      onClose={close}
      closeAccessibilityLabel="Close subscription paywall"
    />
  );
}
