import type { Category, DemoPlacePick, Destination } from './state';

// Onboarding demo seed. Static — these never hit the extraction/enrichment
// pipeline. Image URLs are Unsplash CDN links (free use, no attribution
// required). Replace with bundled assets before App Store launch if you'd
// rather not rely on a third-party CDN at first-run.
//
// `category` is the app's real category union ('place' | 'food' | 'activity')
// so the demo grid renders with the same PlaceTile chip recipe.

type SeedPlace = DemoPlacePick & {
  // Which onboarding category buckets this place satisfies (used to filter
  // by Screen 7 preferences). A place can map to multiple buckets.
  buckets: Category[];
};

const JAPAN: SeedPlace[] = [
  {
    id: 'jp-maru-tonkatsu',
    name: 'Maru Tonkatsu',
    city: 'Shibuya',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1583032015879-e5022cb87c3b?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'jp-blue-bottle',
    name: 'Blue Bottle Coffee Kiyosumi',
    city: 'Kiyosumi',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'jp-fushimi-inari',
    name: 'Fushimi Inari Taisha',
    city: 'Kyoto',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1545569310-c3d35dbecf61?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'jp-shibuya-sky',
    name: 'Shibuya Sky',
    city: 'Shibuya',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=800&q=70',
    buckets: ['culture', 'nightlife'],
  },
  {
    id: 'jp-teamlab',
    name: 'teamLab Planets',
    city: 'Toyosu',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1554188248-986adbb73be4?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'jp-kichijoji-walk',
    name: 'Kichijoji walking loop',
    city: 'Kichijoji',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1480796927426-f609979314bd?w=800&q=70',
    buckets: ['nature', 'culture'],
  },
  {
    id: 'jp-ichiran',
    name: 'Ichiran Ramen',
    city: 'Shibuya',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'jp-ryokan',
    name: 'Hoshinoya Kyoto',
    city: 'Arashiyama',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1528360983277-13d401cdc186?w=800&q=70',
    buckets: ['stays'],
  },
];

const SEA: SeedPlace[] = [
  {
    id: 'sea-bahn-mi',
    name: 'Bánh Mì Phượng',
    city: 'Hội An',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1525755662778-989d0524087e?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'sea-angkor',
    name: 'Angkor Wat sunrise',
    city: 'Siem Reap',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'sea-ubud',
    name: 'Tegalalang rice terraces',
    city: 'Ubud',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1518002171953-a080ee817e1f?w=800&q=70',
    buckets: ['nature'],
  },
  {
    id: 'sea-chatuchak',
    name: 'Chatuchak weekend market',
    city: 'Bangkok',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1563492065599-3520f775eeed?w=800&q=70',
    buckets: ['shopping'],
  },
  {
    id: 'sea-halong',
    name: 'Hạ Long Bay overnight',
    city: 'Quảng Ninh',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=800&q=70',
    buckets: ['nature', 'stays'],
  },
  {
    id: 'sea-temple',
    name: 'Wat Pho',
    city: 'Bangkok',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1563492065599-3520f775eeed?w=800&q=70',
    buckets: ['culture'],
  },
];

const EUROPE: SeedPlace[] = [
  {
    id: 'eu-pasteis',
    name: 'Pastéis de Belém',
    city: 'Lisbon',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1555126634-323283e090fa?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'eu-sagrada',
    name: 'Sagrada Família',
    city: 'Barcelona',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1583422409516-2895a77efded?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'eu-cinque',
    name: 'Cinque Terre coastal walk',
    city: 'Liguria',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=800&q=70',
    buckets: ['nature'],
  },
  {
    id: 'eu-louvre',
    name: 'The Louvre',
    city: 'Paris',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'eu-camden',
    name: 'Camden Market',
    city: 'London',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1513026705753-bc3fffca8bf4?w=800&q=70',
    buckets: ['shopping'],
  },
  {
    id: 'eu-bar',
    name: 'A Brasileira',
    city: 'Lisbon',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1452960962994-acf4fd70b632?w=800&q=70',
    buckets: ['nightlife', 'food'],
  },
];

const US_ROADTRIP: SeedPlace[] = [
  {
    id: 'us-zion',
    name: 'Zion Narrows',
    city: 'Utah',
    category: 'activity',
    imageUrl: 'https://images.unsplash.com/photo-1502786129293-79981df4e689?w=800&q=70',
    buckets: ['nature'],
  },
  {
    id: 'us-in-n-out',
    name: 'In-N-Out Burger',
    city: 'California',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=70',
    buckets: ['food'],
  },
  {
    id: 'us-route66',
    name: 'Route 66 — Cadillac Ranch',
    city: 'Amarillo, TX',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=800&q=70',
    buckets: ['culture'],
  },
  {
    id: 'us-yosemite',
    name: 'Yosemite Valley',
    city: 'California',
    category: 'place',
    imageUrl: 'https://images.unsplash.com/photo-1444035832717-d23f267e1be8?w=800&q=70',
    buckets: ['nature'],
  },
  {
    id: 'us-nashville-bbq',
    name: 'Martin\'s Bar-B-Que Joint',
    city: 'Nashville',
    category: 'food',
    imageUrl: 'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=800&q=70',
    buckets: ['food', 'nightlife'],
  },
];

// Cross-region "best of" decks. Picking by reference (find/byId) so the
// `noUncheckedIndexedAccess` TS rule doesn't downgrade each entry to
// `SeedPlace | undefined`.
function byId(pool: SeedPlace[], id: string): SeedPlace {
  const found = pool.find((p) => p.id === id);
  if (!found) throw new Error(`demoPlaces seed missing id: ${id}`);
  return found;
}

const CITY_BREAK: SeedPlace[] = [
  byId(JAPAN, 'jp-maru-tonkatsu'),
  byId(JAPAN, 'jp-blue-bottle'),
  byId(EUROPE, 'eu-pasteis'),
  byId(EUROPE, 'eu-louvre'),
  byId(SEA, 'sea-chatuchak'),
  byId(US_ROADTRIP, 'us-route66'),
];

const BUCKET: SeedPlace[] = [
  byId(JAPAN, 'jp-fushimi-inari'),
  byId(EUROPE, 'eu-sagrada'),
  byId(SEA, 'sea-angkor'),
  byId(US_ROADTRIP, 'us-yosemite'),
  byId(SEA, 'sea-ubud'),
  byId(JAPAN, 'jp-teamlab'),
];

const SEEDS: Record<Destination, SeedPlace[]> = {
  japan: JAPAN,
  sea: SEA,
  europe: EUROPE,
  'us-roadtrip': US_ROADTRIP,
  'city-break': CITY_BREAK,
  'bucket-list': BUCKET,
  general: BUCKET,
};

/** Pick up to `count` curated places for the user's destination, filtered
 *  by their category preferences. Falls back to the destination's full
 *  seed when no category preferences are given or no place matches. */
export function pickDemoSeed(
  destination: Destination,
  categories: readonly Category[],
  count = 5,
): DemoPlacePick[] {
  const pool = SEEDS[destination] ?? BUCKET;
  const filtered =
    categories.length === 0
      ? pool
      : pool.filter((p) => p.buckets.some((b) => categories.includes(b)));
  const chosen = (filtered.length > 0 ? filtered : pool).slice(0, count);
  return chosen.map(({ buckets: _b, ...rest }) => rest);
}
