// Static fixtures driving the onboarding demo (Screen 5). The demo never
// hits the real extraction / enrichment pipeline — these are hand-curated
// real-world places shown for illustration only. Spec:
// docs/superpowers/specs/2026-05-13-onboarding-redesign-design.md.

export type DemoPlaceFixture = {
  name: string;
  city: string;
  category: 'food' | 'place' | 'activity';
  /** Unsplash CDN URL. Replace with a bundled asset if you'd rather not
   *  rely on a third-party CDN at first-launch. */
  photoUrl: string;
};

export type DemoScreenshotFixture = {
  /** Faux IG handle that authored the post. */
  handle: string;
  heroImageUrl: string;
  /** Big uppercase title overlaid on the hero. */
  titleOverlay: string;
  /** Numbered caption lines mimicking a "top N" IG carousel caption. */
  captionLines: string[];
  /** The three places the AI will "extract" from this screenshot. */
  reveals: DemoPlaceFixture[];
};

export type DemoShareFixture = {
  handle: string;
  heroImageUrl: string;
  caption: string;
  /** Trip name the user "saves to" by tapping the highlighted pill. */
  tripPickerLabel: string;
  reveal: DemoPlaceFixture;
};

export const DEMO_SCREENSHOT: DemoScreenshotFixture = {
  handle: '@tokyo.eats',
  heroImageUrl: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=900&q=75',
  titleOverlay: 'TOP 3 RAMEN IN SHIBUYA',
  captionLines: ['1. Maru Tonkatsu — Shibuya', '2. Ichiran — Shibuya', '3. Afuri Ramen — Shibuya'],
  reveals: [
    {
      name: 'Maru Tonkatsu',
      city: 'Shibuya',
      category: 'food',
      photoUrl: 'https://images.unsplash.com/photo-1583032015879-e5022cb87c3b?w=400&q=70',
    },
    {
      name: 'Ichiran',
      city: 'Shibuya',
      category: 'food',
      photoUrl: 'https://images.unsplash.com/photo-1591814468924-caf88d1232e1?w=400&q=70',
    },
    {
      name: 'Afuri Ramen',
      city: 'Shibuya',
      category: 'food',
      photoUrl: 'https://images.unsplash.com/photo-1557872943-16a5ac26437e?w=400&q=70',
    },
  ],
};

export const DEMO_SHARE: DemoShareFixture = {
  handle: '@kyoto.found',
  heroImageUrl: 'https://images.unsplash.com/photo-1493997181344-712f2f19d87a?w=900&q=75',
  caption: 'Vermilion morning before the crowds. Kyoto, 6:30am.',
  tripPickerLabel: 'Japan',
  reveal: {
    name: 'Fushimi Inari Taisha',
    city: 'Kyoto',
    category: 'place',
    photoUrl: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=400&q=70',
  },
};
