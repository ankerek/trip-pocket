// Shared helpers for the worker integration tests. Builds the Env shape,
// IG/TikTok HTML fixtures, and route handlers that pattern-match Gemini
// calls (extract vs bulk-blurb) by inspecting the request body.

import type { Env } from '../../src/index';
import type { ExtractJobMessage } from '../../src/orchestrator-schema';
import { routeStage, TransientExtractError } from '../../src/orchestrator';
import type { WaitUntilCtx } from '../../src/video';
import type { RouteHandler } from './network-mock';
import { makeKv } from './network-mock';

export const HASH = 'a'.repeat(64);
export const HASH_TWO = 'b'.repeat(64);
export const HASH_THREE = 'c'.repeat(64);

/**
 * Construct the worker Env shape for integration tests. The
 * `EXTRACT_QUEUE` binding is a stub: send() dispatches each message
 * back through `routeStage` via the supplied awaitable `ctx`, so the
 * full fetch-post → extract → enrich pipeline runs to completion when
 * the test awaits `ctx.settle()`. Transient throws (Gemini 503-style)
 * are swallowed — they'd retry in production; in tests the after-state
 * in KV reflects the partial failure.
 *
 * Pass the awaitable ctx (from `makeAwaitableCtx`) so each enqueued
 * stage is scheduled via `ctx.waitUntil`, matching the production flow
 * where each stage is its own Worker invocation.
 */
export function makeEnv(
  opts: { apify?: boolean; kv?: ReturnType<typeof makeKv>; ctx?: WaitUntilCtx } = {},
): {
  env: Env;
  kv: ReturnType<typeof makeKv>;
} {
  const kv = opts.kv ?? makeKv();
  const env: Env = {
    GEMINI_API_KEY: 'k',
    GOOGLE_PLACES_API_KEY: 'p',
    CF_ACCOUNT_ID: 'a',
    AI_GATEWAY_NAME: 'g',
    CF_AIG_TOKEN: 't',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: kv as unknown as KVNamespace,
    EXTRACT_QUEUE: makeStubQueue(opts.ctx),
  };
  // The stub queue's send() routes back through routeStage(msg, env, ctx).
  // env was captured at queue-construction time and needs to see itself
  // (so the queue's send is reachable to the next stage). Patch envWithSelf
  // after env is constructed.
  (env.EXTRACT_QUEUE as ReturnType<typeof makeStubQueue>).bindEnv(env);
  if (opts.apify ?? true) {
    env.APIFY_TOKEN = 'apify-token';
    env.APIFY_ACTOR_ID = 'apify~instagram-post-scraper';
  }
  return { env, kv };
}

function makeStubQueue(ctx: WaitUntilCtx | undefined): Env['EXTRACT_QUEUE'] & {
  bindEnv(env: Env): void;
} {
  let env: Env | null = null;
  const effectiveCtx: WaitUntilCtx = ctx ?? { waitUntil: () => {} };
  const dispatch = async (body: ExtractJobMessage) => {
    if (!env) throw new Error('stub queue not bound to env');
    try {
      await routeStage(body, env, effectiveCtx);
    } catch (err) {
      // Mimic CF Queues: transient throws auto-retry (eventually DLQ).
      // For tests we just stop — the KV after-state shows the partial.
      if (!(err instanceof TransientExtractError)) throw err;
    }
  };
  const stub = {
    bindEnv(e: Env) {
      env = e;
    },
    async send(body: ExtractJobMessage) {
      // Schedule the dispatch via ctx.waitUntil so settled() drains the
      // whole pipeline in one drain pass — matching production where
      // each stage runs as its own invocation rather than blocking the
      // POST response.
      effectiveCtx.waitUntil(dispatch(body));
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages: Iterable<{ body: ExtractJobMessage }>) {
      for (const m of messages) {
        effectiveCtx.waitUntil(dispatch(m.body));
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  } satisfies Env['EXTRACT_QUEUE'] & { bindEnv(env: Env): void };
  return stub;
}

/** Gateway URL prefix the worker constructs for any Gemini call (extract + blurb). */
export const GEMINI_GATEWAY_PREFIX =
  'https://gateway.ai.cloudflare.com/v1/a/g/google-ai-studio/v1beta/models/';

/**
 * Encode an `efg`-shaped JSON payload so an og:image URL classifies as
 * `single` / `carousel` / `clips` via decodeEfgFromImageUrl.
 */
export function efgFor(mediaType: 'GraphImage' | 'CAROUSEL_ITEM' | 'CLIPS'): string {
  return Buffer.from(JSON.stringify({ media_type: mediaType })).toString('base64');
}

/** Minimal IG /p/ HTML with the requested og:* fields. */
export function igPostHtml(args: {
  coverUrl: string;
  caption: string;
  title?: string;
  videoUrl?: string;
  videoDuration?: number;
}): string {
  const parts = [
    '<!doctype html><html><head>',
    `<meta property="og:image" content="${args.coverUrl}" />`,
    `<meta property="og:description" content="${args.caption}" />`,
  ];
  if (args.title) parts.push(`<meta property="og:title" content="${args.title}" />`);
  if (args.videoUrl) {
    parts.push(`<meta property="og:video:secure_url" content="${args.videoUrl}" />`);
    if (typeof args.videoDuration === 'number') {
      parts.push(`<meta property="og:video:duration" content="${args.videoDuration}" />`);
    }
  }
  parts.push('</head><body></body></html>');
  return parts.join('');
}

/**
 * Build a TikTok HTML page with the __UNIVERSAL_DATA_FOR_REHYDRATION__
 * blob the worker's rehydration parser reads.
 */
export function tiktokVideoHtml(args: {
  caption: string;
  authorUniqueId: string;
  coverUrl: string;
  playAddr: string;
  duration: number;
}): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: {
          itemStruct: {
            desc: args.caption,
            author: { uniqueId: args.authorUniqueId },
            video: {
              cover: args.coverUrl,
              playAddr: args.playAddr,
              duration: args.duration,
            },
          },
        },
      },
    },
  };
  return wrapRehydrationHtml(payload);
}

/** TikTok photo-slideshow HTML — itemStruct.imagePost shape. */
export function tiktokPhotoHtml(args: {
  caption: string;
  authorUniqueId: string;
  imageUrls: string[];
}): string {
  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: {
          itemStruct: {
            desc: args.caption,
            author: { uniqueId: args.authorUniqueId },
            imagePost: {
              images: args.imageUrls.map((u) => ({ imageURL: { urlList: [u] } })),
            },
          },
        },
      },
    },
  };
  return wrapRehydrationHtml(payload);
}

function wrapRehydrationHtml(payload: unknown): string {
  return (
    '<!doctype html><html><head><title>tt</title></head><body>' +
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>` +
    '</body></html>'
  );
}

/** TikTok HTML with no rehydration blob — forces the oEmbed fallback. */
export function tiktokNoRehydrationHtml(): string {
  return '<!doctype html><html><head><title>blocked</title></head><body>no data here</body></html>';
}

/** TikTok oEmbed JSON response (returned from https://www.tiktok.com/oembed?url=...). */
export function tiktokOembedResponse(args: {
  title: string;
  thumbnailUrl: string;
  authorName: string;
}): Response {
  return new Response(
    JSON.stringify({
      title: args.title,
      thumbnail_url: args.thumbnailUrl,
      author_name: args.authorName,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// --- Gemini response shapes -------------------------------------------------

export type ExtractPlace = {
  name: string;
  city: string;
  address: string;
  category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';
  country_code: string;
};

/** Wrap a places array in the candidates[].content.parts[].text envelope Gemini emits. */
export function geminiExtractResponse(places: ExtractPlace[]): unknown {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ places }) }] } }],
  };
}

/** Build a Gemini bulk-blurb response. Map place_id → blurb text. */
export function geminiBlurbResponse(blurbs: Array<{ id: string; blurb: string }>): unknown {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ blurbs }) }] } }],
  };
}

/** Identify which Gemini call this is by inspecting the request body. */
export async function classifyGeminiCall(req: Request): Promise<'extract' | 'blurb' | 'unknown'> {
  const text = await req.clone().text();
  // Extract uses GEMINI_RESPONSE_SCHEMA which declares a `places` array;
  // bulk-blurb uses one with a `blurbs` array. The schema is serialized
  // verbatim in the request, so a substring match is enough.
  if (text.includes('"blurbs"')) return 'blurb';
  if (text.includes('"places"')) return 'extract';
  return 'unknown';
}

/**
 * Compose a Gemini gateway handler that dispatches by call-kind. Throws
 * on `unknown` so a test failure points at the offending payload rather
 * than a generic stub mismatch later.
 */
export function geminiDispatcher(args: {
  extract: (req: Request) => Response | Promise<Response>;
  blurb: (req: Request) => Response | Promise<Response>;
}): RouteHandler {
  return async (req) => {
    const kind = await classifyGeminiCall(req);
    if (kind === 'extract') return args.extract(req);
    if (kind === 'blurb') return args.blurb(req);
    throw new Error(`gemini-dispatcher: cannot classify call: ${await req.clone().text()}`);
  };
}

// --- Google Places response shapes -----------------------------------------

export function placesSearchResponse(placeId: string | null): Response {
  const body = placeId === null ? { places: [] } : { places: [{ id: placeId }] };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export type PlaceDetailsFixture = {
  id: string;
  displayName: string;
  formattedAddress: string;
  photoName: string;
  rating: number;
  priceLevel: 'PRICE_LEVEL_MODERATE' | 'PRICE_LEVEL_INEXPENSIVE' | 'PRICE_LEVEL_EXPENSIVE';
  latitude: number;
  longitude: number;
  city: string;
  countryCode: string;
};

export function placesDetailsResponse(d: PlaceDetailsFixture): Response {
  return new Response(
    JSON.stringify({
      id: d.id,
      displayName: { text: d.displayName },
      location: { latitude: d.latitude, longitude: d.longitude },
      formattedAddress: d.formattedAddress,
      photos: [{ name: d.photoName }],
      rating: d.rating,
      priceLevel: d.priceLevel,
      googleMapsUri: `https://maps.google.com/?cid=${d.id}`,
      types: ['restaurant'],
      addressComponents: [
        { types: ['locality'], longText: d.city },
        { types: ['country'], shortText: d.countryCode },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// --- Apify response shape --------------------------------------------------

export type ApifyFixture = {
  caption: string;
  displayUrl: string;
  childPosts?: Array<{ displayUrl: string }>;
  ownerUsername?: string;
  videoUrl?: string;
  videoDuration?: number;
  url?: string;
  shortCode?: string;
  type?: 'Image' | 'Sidecar' | 'Video';
};

export function apifyResponse(items: ApifyFixture[]): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// --- Cover-image bytes ------------------------------------------------------

/**
 * Tiny "valid-enough" JPEG (just the SOI marker + a few bytes). Real bytes
 * never reach Gemini in tests — runExtract just base64s whatever the cover
 * URL returned, so the content is opaque.
 */
export function fakeImageBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

export function imageResponse(): Response {
  return new Response(fakeImageBytes(), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}
