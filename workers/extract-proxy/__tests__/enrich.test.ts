import { handleEnrich } from '../src/enrich';
import type { Env } from '../src/index';

function rateLimit(allowed = true) {
  return { limit: jest.fn(async () => ({ success: allowed })) };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'gemini-key',
    GOOGLE_PLACES_API_KEY: 'places-key',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'default',
    CF_AIG_TOKEN: 'aig-token',
    RATE_LIMIT: rateLimit(true) as unknown as Env['RATE_LIMIT'],
    ...overrides,
  };
}

function postJson(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('https://proxy.example.com/enrich', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

const validBody = {
  extracted_place_id: 'ep-1',
  name: 'Kosoan',
  city: 'Tokyo',
  address: '1 Chome-24-23 Jiyugaoka',
  ocr_caption: 'Found this cozy tea house in Jiyugaoka — matcha and warabimochi.',
};

// Mock fetch: returns scripted responses in order based on URL substring.
type FetchScript = Array<{
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response;
}>;

function scriptedFetch(script: FetchScript) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const step of script) {
      if (step.match(url, init)) return step.response();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const isSearchText = (url: string) => url.includes('places:searchText');
const isPlaceDetails = (url: string) =>
  url.includes('/v1/places/') && !url.includes('/photos/') && !url.includes('searchText');
const isGemini = (url: string) => url.includes('gateway.ai.cloudflare.com');

function placesSearchOk(placeId = 'ChIJ-test') {
  return new Response(JSON.stringify({ places: [{ id: placeId }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function placesSearchEmpty() {
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function placesDetailsOk(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: 'ChIJ-test',
      displayName: { text: 'Kosoan' },
      location: { latitude: 35.6076, longitude: 139.668 },
      formattedAddress: '1 Chome-24-23 Jiyugaoka, Tokyo',
      photos: [{ name: 'places/ChIJ-test/photos/AeJbb3-abc' }],
      rating: 4.5,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      types: ['cafe'],
      googleMapsUri: 'https://maps.google.com/?cid=123',
      addressComponents: [
        { types: ['locality', 'political'], longText: 'Tokyo', shortText: 'Tokyo' },
        { types: ['country', 'political'], longText: 'Japan', shortText: 'JP' },
      ],
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function geminiOk(text = 'Cozy 1950s tea house in Jiyugaoka, known for matcha.') {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('handleEnrich', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- request validation ---

  it('returns 405 for non-POST methods', async () => {
    const req = new Request('https://proxy.example.com/enrich', { method: 'GET' });
    const res = await handleEnrich(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it('returns 400 when content-type is not JSON', async () => {
    const req = new Request('https://proxy.example.com/enrich', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hi',
    });
    const res = await handleEnrich(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await handleEnrich(postJson({ name: 'X' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when ocr_caption is empty', async () => {
    const res = await handleEnrich(postJson({ ...validBody, ocr_caption: '' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit denies', async () => {
    const env = makeEnv({ RATE_LIMIT: rateLimit(false) as unknown as Env['RATE_LIMIT'] });
    const res = await handleEnrich(postJson(validBody), env);
    expect(res.status).toBe(429);
  });

  it('returns 500 when GOOGLE_PLACES_API_KEY is missing', async () => {
    const res = await handleEnrich(postJson(validBody), makeEnv({ GOOGLE_PLACES_API_KEY: '' }));
    expect(res.status).toBe(500);
  });

  // --- happy path ---

  it('returns enriched response with all fields populated', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('enriched');
    expect(body.external_place_id).toBe('ChIJ-test');
    expect(body.latitude).toBe(35.6076);
    expect(body.longitude).toBe(139.668);
    expect(body.formatted_address).toBe('1 Chome-24-23 Jiyugaoka, Tokyo');
    expect(body.photo_name).toBe('places/ChIJ-test/photos/AeJbb3-abc');
    expect(body.description).toContain('tea house');
    expect(body.rating).toBe(4.5);
    expect(body.price_level).toBe(2);
    expect(body.external_url).toBe('https://maps.google.com/?cid=123');
    expect(body.model).toBe('gemini-2.5-flash-lite');
    expect(body.city).toBe('Tokyo');
    expect(body.country_code).toBe('JP');
  });

  it('returns city=null when addressComponents lacks a locality entry', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      {
        match: isPlaceDetails,
        response: () =>
          placesDetailsOk({
            addressComponents: [{ types: ['country', 'political'], longText: 'Japan', shortText: 'JP' }],
          }),
      },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.city).toBeNull();
    expect(body.country_code).toBe('JP');
  });

  it('returns country_code=null when addressComponents lacks a country entry', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      {
        match: isPlaceDetails,
        response: () =>
          placesDetailsOk({
            addressComponents: [{ types: ['locality', 'political'], longText: 'Tokyo', shortText: 'Tokyo' }],
          }),
      },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.city).toBe('Tokyo');
    expect(body.country_code).toBeNull();
  });

  it('returns null city + country_code when addressComponents is missing entirely', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      {
        match: isPlaceDetails,
        response: () => placesDetailsOk({ addressComponents: undefined }),
      },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.city).toBeNull();
    expect(body.country_code).toBeNull();
  });

  it('uppercases country shortText defensively (CLDR convention is uppercase but cheap to enforce)', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      {
        match: isPlaceDetails,
        response: () =>
          placesDetailsOk({
            addressComponents: [
              { types: ['locality', 'political'], longText: 'Tokyo', shortText: 'Tokyo' },
              { types: ['country', 'political'], longText: 'Japan', shortText: 'jp' },
            ],
          }),
      },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.country_code).toBe('JP');
  });

  it('requests addressComponents in the Places field mask', async () => {
    const fetchSpy = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk() },
    ]);
    globalThis.fetch = fetchSpy;

    await handleEnrich(postJson(validBody), makeEnv());
    const detailsCall = (fetchSpy as unknown as jest.Mock).mock.calls.find((c) =>
      isPlaceDetails(String(c[0])),
    );
    const init = detailsCall![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Goog-FieldMask')).toContain('addressComponents');
  });

  it('passes textQuery as "name, address" to Places searchText', async () => {
    const fetchSpy = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk() },
    ]);
    globalThis.fetch = fetchSpy;

    await handleEnrich(postJson(validBody), makeEnv());
    const searchCall = (fetchSpy as unknown as jest.Mock).mock.calls.find((c) =>
      isSearchText(String(c[0])),
    );
    const init = searchCall![1] as RequestInit;
    const reqBody = JSON.parse(init.body as string);
    expect(reqBody.textQuery).toBe('Kosoan, 1 Chome-24-23 Jiyugaoka');
  });

  it('falls back to city when no address', async () => {
    const fetchSpy = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk() },
    ]);
    globalThis.fetch = fetchSpy;

    await handleEnrich(postJson({ ...validBody, address: null }), makeEnv());
    const searchCall = (fetchSpy as unknown as jest.Mock).mock.calls.find((c) =>
      isSearchText(String(c[0])),
    );
    const reqBody = JSON.parse((searchCall![1] as RequestInit).body as string);
    expect(reqBody.textQuery).toBe('Kosoan, Tokyo');
  });

  it('sends X-Goog-Api-Key header to Places (not via query string)', async () => {
    const fetchSpy = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk() },
    ]);
    globalThis.fetch = fetchSpy;

    await handleEnrich(postJson(validBody), makeEnv());
    const searchCall = (fetchSpy as unknown as jest.Mock).mock.calls.find((c) =>
      isSearchText(String(c[0])),
    );
    const init = searchCall![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Goog-Api-Key')).toBe('places-key');
    // The Places key must NOT appear in the URL.
    expect(String(searchCall![0])).not.toContain('places-key');
  });

  // --- not found ---

  it('returns status:not-found when searchText returns no places', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchEmpty() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('not-found');
  });

  // --- error handling ---

  it('returns 502 when Places searchText returns 500', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => new Response('boom', { status: 500 }) },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(502);
  });

  it('returns 429 when Places searchText returns 429', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => new Response('rate limited', { status: 429 }) },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('returns enriched with description=null when Gemini fails', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => new Response('boom', { status: 500 }) },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('enriched');
    expect(body.description).toBeNull();
    expect(body.photo_name).toBe('places/ChIJ-test/photos/AeJbb3-abc');
  });

  // --- field handling ---

  it('handles missing optional Place fields gracefully', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      {
        match: isPlaceDetails,
        response: () =>
          new Response(JSON.stringify({ id: 'ChIJ-test' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
      { match: isGemini, response: () => geminiOk() },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.external_place_id).toBe('ChIJ-test');
    expect(body.latitude).toBeNull();
    expect(body.longitude).toBeNull();
    expect(body.photo_name).toBeNull();
    expect(body.rating).toBeNull();
    expect(body.price_level).toBeNull();
  });

  it('truncates blurb output longer than 240 chars', async () => {
    const long = 'A '.repeat(300); // 600 chars
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => placesSearchOk() },
      { match: isPlaceDetails, response: () => placesDetailsOk() },
      { match: isGemini, response: () => geminiOk(long) },
    ]);

    const res = await handleEnrich(postJson(validBody), makeEnv());
    const body = (await res.json()) as { description: string };
    expect(body.description.length).toBeLessThanOrEqual(240);
    expect(body.description.endsWith('…')).toBe(true);
  });

  // --- privacy ---

  it('does not echo OCR caption in any error response body', async () => {
    globalThis.fetch = scriptedFetch([
      { match: isSearchText, response: () => new Response('boom', { status: 500 }) },
    ]);

    const caption = 'PRIVATE OCR CAPTION 12345';
    const res = await handleEnrich(postJson({ ...validBody, ocr_caption: caption }), makeEnv());
    const text = await res.text();
    expect(text).not.toContain(caption);
  });
});
