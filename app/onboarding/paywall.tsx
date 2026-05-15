import { useRouter } from 'expo-router';
import { PaywallBody } from '@/components/paywall/PaywallBody';
import { markOnboardingComplete } from '@/lib/onboarding/storage';
import { useOnboarding, type Destination } from '@/lib/onboarding/state';

// Screen 6 — first-run paywall (terminal screen of the onboarding stack).
// Lapse-mode paywall lives at app/paywall-lapse.tsx as its own root-level
// modal route; this file no longer handles `?mode=lapse`.

const PAYWALL_HEADLINE: Record<Destination, string> = {
  japan: 'Your Japan trip starts here.',
  sea: 'Your Southeast Asia trip starts here.',
  europe: 'Your Europe trip starts here.',
  'us-roadtrip': 'Your US road trip starts here.',
  'city-break': 'Your city break starts here.',
  'bucket-list': 'Your bucket list starts here.',
  general: 'Your next trip starts here.',
};
const FALLBACK_HEADLINE = 'Your next trip starts here.';

export default function PaywallScreen() {
  const router = useRouter();
  const { answers } = useOnboarding();
  const headline = answers.destination ? PAYWALL_HEADLINE[answers.destination] : FALLBACK_HEADLINE;

  function exitOnboarding() {
    // The paywall sits inside two nested Stacks:
    //   root Stack [ (tabs), onboarding (fullScreenModal) ]
    //     └── onboarding Stack [ index, destination, …, paywall ]
    // router.dismissAll() only targets the *closest* Stack, so on its
    // own it pops the inner Stack back to /onboarding (Welcome) and
    // leaves the modal mounted — the user lands on the start of
    // onboarding again. We follow it with router.dismiss() to pop the
    // modal off the root Stack so (tabs) becomes visible underneath.
    //
    // The second call is deferred to the next frame: after a
    // successful RC purchase the customer-info listener fires
    // setStatus('active') during the awaited purchasePackage(), and
    // calling dismiss() back-to-back races those React commits — the
    // modal got stranded on screen. requestAnimationFrame yields long
    // enough for the inner pop and the listener-driven re-render to
    // settle before we cross into the parent navigator.
    router.dismissAll();
    requestAnimationFrame(() => router.dismiss());
  }

  return (
    <PaywallBody
      headline={headline}
      onSuccess={() => {
        markOnboardingComplete();
        exitOnboarding();
      }}
      // Dev-only escape hatch. App Store builds must complete the paywall.
      onClose={
        __DEV__
          ? () => {
              markOnboardingComplete();
              exitOnboarding();
            }
          : undefined
      }
    />
  );
}
