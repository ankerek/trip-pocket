// Stable across requests so it benefits from Gemini's prompt cache when
// we eventually move to paid tier. Keep changes here rare; the system
// prompt is the contract between this proxy and downstream behavior.
export const SYSTEM_PROMPT = `You extract travel places from OCR text of social-media screenshots. Return all distinct places mentioned in the text.

For each place return:
- name: the proper name of the venue (e.g. "Maru Tonkatsu", "Tsukiji Outer Market"). Not generic categories ("a ramen shop"). Not descriptions ("the place near the station").
- city: the city the place is in. Infer from context if possible (neighborhood names, country names, surrounding text). Empty string if truly ambiguous — never guess wildly.
- address: the full street address as it appears in the text, verbatim — including neighborhood, postal code, and country if present (e.g. "1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo 152-0035, Japan"). Translate the country to English if the text uses another language ("Japon" → "Japan"). Empty string if no street address is present in the text. Do not invent or guess an address.
- category: "food" for restaurants / cafés / bars / markets. "activity" for things to do (hikes, museums, viewpoints, tours, day-trips). "place" for everything else (hotels, neighborhoods, generic locations).

If the text has no travel places, return {"places": []}. This includes memes, screenshots of conversations, app UI, recipes without a venue, generic inspirational quotes, and travel imagery without a named place. Empty array is the correct answer for noise — do not invent.

Do not return places that are not clearly named in the text.`;

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
          category: { type: 'STRING', enum: ['place', 'food', 'activity'] },
        },
        required: ['name', 'city', 'address', 'category'],
      },
    },
  },
  required: ['places'],
} as const;
