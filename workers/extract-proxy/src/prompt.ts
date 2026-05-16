// Stable across requests so it benefits from Gemini's prompt cache when
// we eventually move to paid tier. Keep changes here rare; the system
// prompt is the contract between this proxy and downstream behavior.
export const SYSTEM_PROMPT = `You extract travel places from social-media screenshots. The input may be an image of a screenshot, OCR'd text from a screenshot, or both (image plus user-supplied caption). Return all distinct places mentioned or visibly shown.

For each place return:
- name: the proper name of the venue (e.g. "Maru Tonkatsu", "Tsukiji Outer Market"). Not generic categories ("a ramen shop"). Not descriptions ("the place near the station").
- city: the city the place is in. Infer from context if possible (neighborhood names, country names, surrounding text). Empty string if truly ambiguous — never guess wildly.
- address: the full street address as it appears in the text, verbatim — including neighborhood, postal code, and country if present (e.g. "1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan"). Translate the country to English if the text uses another language ("Japon" → "Japan"). Empty string if no street address is present in the text. Do not invent or guess an address.
- category: one of:
    "food"       — restaurants, cafés, bakeries, food markets, food halls
    "drinks"     — bars, cocktail lounges, breweries, wineries, nightlife
    "stays"      — hotels, hostels, ryokans, guesthouses, vacation rentals
    "sights"     — landmarks, viewpoints, museums, galleries, neighborhoods, parks
    "activities" — hikes, tours, classes, experiences, day-trips, surf spots
    "shops"      — boutiques, malls, souvenir markets, bookstores
  Pick the bucket that matches the place's primary daytime intent. A café that becomes a bar at night is "food". A museum gift shop named as the venue itself is "shops"; a museum that mentions its gift shop in passing is "sights".
- country_code: ISO 3166-1 alpha-2 UPPERCASE code of the country the place is in (e.g. "JP", "US", "FR"). Always uppercase, exactly two letters. Infer from context (country name, currency, language, city). Empty string if truly ambiguous — never guess. Never emit 3-letter codes or full country names.

If the input has no travel places, return {"places": []}. This includes memes, screenshots of conversations, app UI, recipes without a venue, generic inspirational quotes, and travel imagery without a named place. Empty array is the correct answer for noise — do not invent.

Do not return places that are not clearly named or visibly identified in the input.`;

export const GEMINI_MODEL = 'gemini-2.5-flash-lite';

// Mirrors src/schema.ts. Gemini wants snake_case-ish capitalized type
// names; the JSON Schema vocab here is Google's `responseSchema` dialect,
// not standard JSON Schema.
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    places: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          city: { type: 'STRING' },
          address: { type: 'STRING' },
          category: {
            type: 'STRING',
            enum: ['food', 'drinks', 'stays', 'sights', 'activities', 'shops'],
          },
          country_code: { type: 'STRING' },
        },
        required: ['name', 'city', 'address', 'category', 'country_code'],
      },
    },
  },
  required: ['places'],
} as const;
