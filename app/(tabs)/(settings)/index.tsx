import { useState } from 'react';
import { ScrollView, View } from '@/tw';
import { useTapCounter } from '@/lib/useTapCounter';
import { SubscriptionSection } from '@/components/settings/SubscriptionSection';
import { ShareRow } from '@/components/settings/ShareRow';
import { SupportSection } from '@/components/settings/SupportSection';
import { LegalSection } from '@/components/settings/LegalSection';
import { AboutSection } from '@/components/settings/AboutSection';
import { DeveloperSection } from '@/components/settings/DeveloperSection';

const DEV_UNLOCK_TAPS = 7;
const DEV_UNLOCK_WINDOW_MS = 3000;

// Settings lives as a bottom-tab destination so users always have a stable
// home for account/legal/support. The Developer section is hidden by default
// and revealed by tapping the version line 7× within DEV_UNLOCK_WINDOW_MS;
// the unlock lives in component state so a fresh visit always starts hidden.
export default function Settings() {
  const [developerVisible, setDeveloperVisible] = useState(false);
  // Re-render trigger for the diagnostics-only "throw on render" affordance —
  // flipping this synchronously throws, which the top-level Sentry
  // ErrorBoundary catches.
  const [throwOnRender, setThrowOnRender] = useState(false);

  const onVersionTap = useTapCounter(DEV_UNLOCK_TAPS, DEV_UNLOCK_WINDOW_MS, () => {
    setDeveloperVisible((v) => !v);
  });

  if (throwOnRender) {
    throw new Error('Trip Pocket diagnostics: forced render error');
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="bg-bg flex-1"
      contentContainerClassName="px-6 pb-12"
    >
      <SubscriptionSection />
      <ShareRow />
      <SupportSection />
      <LegalSection />
      <AboutSection onVersionTap={onVersionTap} />
      {developerVisible ? (
        <DeveloperSection onForceRenderError={() => setThrowOnRender(true)} />
      ) : (
        <View />
      )}
    </ScrollView>
  );
}
