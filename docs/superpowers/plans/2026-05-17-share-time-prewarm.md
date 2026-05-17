# Share-time pre-warm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the full extraction pipeline at share time (from the iOS share extension) instead of on app foreground, so the user opens the app to a ready result. Replace the two-call `/fetch-post` + `/extract` worker surface with a single `/extract` orchestrator that runs the full pipeline server-side, caches the final deduped result in Workers KV keyed by `content_hash`, and exposes it as `GET /extract/:contentHash`. The app polls instead of re-running stages.

**Architecture:** Three layers.

1. **Worker (`workers/extract-proxy`)** — refactor existing `handleExtract` and `handleFetchPost` into pure helpers `runExtract()` and `runFetchPost()`. Add a new HTTP route `POST /extract` that takes `{contentHash, kind, url}`; checks KV for a cached result; if absent, writes `pending` to KV, returns immediately, and schedules the full pipeline (fetch → choose strategy → Gemini extract → dedupe) via `ctx.waitUntil` with `partial` and `done` writes to KV along the way. Add `GET /extract/:contentHash` for the app to poll. Remove the old public `/extract` (legacy shape) and `/fetch-post` routes.
2. **iOS share extension (`native/ShareExtension`)** — after the existing pending-import write, fire a background `URLSession` POST to the new `/extract`. Read RC user id from App Group `UserDefaults` (synced from the main app on launch). Register an `AppDelegate` `handleEventsForBackgroundURLSession` hook on the host so iOS can complete the upload after the extension dies.
3. **Client (`modules/capture`, `modules/extraction`, `modules/processing`)** — replace the old url-fetch + ocr + extract pipeline with a single `pollExtract(contentHash)` that hits `GET /extract/:contentHash`. On `done`, run the existing cross-source dedup (`findSoleMatchByNormalizedKey`) and flip `sources.extraction_status='done'` in one transaction. **UI rule:** render places only when `sources.extraction_status='done'` **AND** `places.enrichment_status IN ('done','not-found')` — this is the fix for the "places appear then disappear" symptom, which is caused by enrichment-time `google_place_id` dedup (see `docs/superpowers/specs/2026-05-15-place-dedup-by-google-id-design.md`), not extraction-time changes. Old client modules (`modules/processing`, OCR sweep, url-fetch sweep) get deleted; the worker owns those stages now.

**Tech Stack:** Cloudflare Workers (TypeScript, Wrangler 4), Workers KV, Gemini via AI Gateway, Apify (existing), iOS Share Extension (Swift, background `URLSession`), Expo (React Native), Expo SQLite, RevenueCat. Worker tests use Jest with Workers polyfills (`caches.default`, `fetch` mocks); client tests use Jest with an in-memory SQLite.

**Out of scope for v1 (deferred):**

- Screenshot (image-share) pre-warm. v1 keeps screenshots on the existing app-side flow. v2 adds a `/upload` route + R2 bucket + image-share enqueue in the share extension.
- Cloudflare Queues / Durable Objects. v1 uses `ctx.waitUntil` for the async pipeline — sufficient for IG/TikTok extractions which finish well under 5 minutes.
- Schema migrations on existing `sources` rows. Already-extracted rows stay where they are; the new path only applies to newly-imported sources. No backfill.

**Pre-flight before starting:**

1. Baseline tests green:
   ```bash
   npm test --silent
   npm test --silent --prefix workers/extract-proxy
   ```
2. Typecheck green: `npx tsc --noEmit`.
3. Have the existing extraction internals open in your editor for reference: `workers/extract-proxy/src/index.ts` (handleExtract), `workers/extract-proxy/src/fetch-post.ts` (handleFetchPost), `modules/extraction/extraction.ts`, `modules/processing/processing.ts`, `modules/capture/runForegroundIngest.ts`.
4. Create the KV namespace (Task 3 instructions; you'll need the `id` from the CLI output).

---

## Task 1: Refactor `handleExtract` → expose `runExtract` pure helper

**Goal:** Split the HTTP wrapper from the Gemini-call logic so the new orchestrator can call the extraction logic directly without going through `Request`/`Response`. Behavior unchanged; existing tests must still pass.

**Files:**

- Modify: `workers/extract-proxy/src/index.ts` (split `handleExtract`)
- Test: `workers/extract-proxy/__tests__/handler.test.ts` (no changes; should still pass)

- [ ] **Step 1.1: Extract `runExtract` from `handleExtract`**

Replace the contents of `workers/extract-proxy/src/index.ts` between `handleExtract`'s "parsed" check and the final `jsonResponse` with a call to a new pure helper. The new helper:

```ts
// Pure (no Request, no Response) wrapper around the Gemini call. Same env
// requirements as handleExtract. Throws RunExtractError on misconfig or
// upstream failure; otherwise returns the parsed places + model.
export class RunExtractError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'RunExtractError';
  }
}

export async function runExtract(
  body: RequestBody,
  env: Env,
  ctx: WaitUntilCtx = NOOP_CTX,
): Promise<ExtractionResponse & { model: string }> {
  if (!env.GEMINI_API_KEY) throw new RunExtractError('server-misconfigured', 500);
  if (!env.CF_ACCOUNT_ID) throw new RunExtractError('server-misconfigured', 500);
  if (!env.AI_GATEWAY_NAME) throw new RunExtractError('server-misconfigured', 500);
  if (!env.CF_AIG_TOKEN) throw new RunExtractError('server-misconfigured', 500);

  let parts: Array<Record<string, unknown>>;
  let systemPrompt = SYSTEM_PROMPT;
  if (body.mode === 'video') {
    try {
      const { part } = await buildVideoPart(
        { url: body.video.url, durationSec: body.video.durationSec },
        env,
        ctx,
      );
      parts = [part];
      if (body.caption && body.caption.trim().length > 0) {
        parts.push({
          text: `User-supplied caption:\n${body.caption.slice(0, TEXT_INPUT_CAP)}`,
        });
      }
      systemPrompt = SYSTEM_PROMPT + VIDEO_PROMPT_SUFFIX;
    } catch (err) {
      if (err instanceof VideoError) {
        console.error('extract-proxy/video: ' + err.code);
        throw new RunExtractError(err.code, err.status);
      }
      throw err;
    }
  } else {
    parts = buildGeminiParts(body);
  }

  const gatewayUrl =
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}` +
    `/google-ai-studio/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  let geminiResp: Response;
  try {
    geminiResp = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (err) {
    console.error('extract-proxy: gemini-network-error', String(err));
    throw new RunExtractError('upstream-network-error', 502);
  }

  if (geminiResp.status === 429) {
    throw new RunExtractError('upstream-rate-limited', 429);
  }
  if (!geminiResp.ok) {
    console.error('extract-proxy: gemini-upstream-error', geminiResp.status);
    throw new RunExtractError('upstream-error', 502);
  }

  let geminiBody: unknown;
  try {
    geminiBody = await geminiResp.json();
  } catch {
    console.error('extract-proxy: gemini-non-json-body');
    throw new RunExtractError('upstream-non-json', 502);
  }

  const candidateText = extractCandidateText(geminiBody);
  if (candidateText === null) {
    console.error('extract-proxy: gemini-shape-unexpected');
    throw new RunExtractError('upstream-bad-shape', 502);
  }

  let inner: unknown;
  try {
    inner = JSON.parse(candidateText);
  } catch {
    console.error('extract-proxy: gemini-inner-parse-failed');
    throw new RunExtractError('upstream-malformed-inner-json', 502);
  }

  const validated = extractionResponseSchema.safeParse(inner);
  if (!validated.success) {
    console.error('extract-proxy: gemini-schema-violation');
    throw new RunExtractError('upstream-schema-violation', 502);
  }

  return { places: validated.data.places, model: GEMINI_MODEL };
}
```

- [ ] **Step 1.2: Rewrite `handleExtract` as a thin HTTP wrapper around `runExtract`**

```ts
export async function handleExtract(
  request: Request,
  env: Env,
  ctx: WaitUntilCtx = NOOP_CTX,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse('content-type-must-be-json', 400);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse('invalid-json', 400);
  }

  const parsed = requestBodySchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid-request-body', 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  try {
    const result = await runExtract(parsed.data, env, ctx);
    return jsonResponse(result, { status: 200 });
  } catch (err) {
    if (err instanceof RunExtractError) {
      const extra =
        err.status === 429 ? { 'retry-after': '60' } : ({} as Record<string, string>);
      return errorResponse(err.code, err.status, extra);
    }
    throw err;
  }
}
```

- [ ] **Step 1.3: Run worker tests**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all existing tests pass. If any test fails, check it's not a regression from the refactor (the changes are mechanical — control flow, status codes, and the response shape are all preserved).

- [ ] **Step 1.4: Commit**

```bash
git add workers/extract-proxy/src/index.ts
git commit -m "refactor(worker): expose runExtract as a pure helper"
```

---

## Task 2: Refactor `handleFetchPost` → expose `runFetchPost` pure helper

**Goal:** Same shape as Task 1: split the HTTP wrapper from the IG/TikTok fetch logic so the new orchestrator can call it directly.

**Files:**

- Modify: `workers/extract-proxy/src/fetch-post.ts`
- Test: `workers/extract-proxy/__tests__/fetch-post.test.ts` (no changes; should still pass)

- [ ] **Step 2.1: Extract `runFetchPost` from `handleFetchPost`**

Add this function above `handleFetchPost` in `fetch-post.ts`:

```ts
export class RunFetchPostError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'RunFetchPostError';
  }
}

/**
 * Pure (no Request, no Response) wrapper around the fetcher chain. Given a
 * raw URL string, runs the IG/TikTok dispatch and returns the populated
 * FetchPostResponse. Throws RunFetchPostError on any error. Caching policy
 * (s-maxage 1d/7d) is the caller's concern — runFetchPost doesn't set
 * Cache-Control headers since there is no Response.
 */
export async function runFetchPost(
  rawUrl: string,
  env: Env,
): Promise<FetchPostResponse> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new RunFetchPostError('unsupported-url', 400);
  }
  const platform = detectPlatform(target);
  if (!platform) throw new RunFetchPostError('unsupported-url', 400);

  try {
    const chain = await runFetcherChain(FETCHERS, target, platform, { env });
    const result = chain.result as FetchPostResponse;
    result._debug = {
      ...(chain.dispatch as Omit<FetchPostDebug, 'cacheHit'>),
      cacheHit: false,
    };
    return result;
  } catch (err) {
    if (err instanceof UpstreamError) {
      throw new RunFetchPostError(err.code, err.status === 429 ? 502 : err.status);
    }
    if (err instanceof AllFetchersFailedError) {
      for (let i = err.attempts.length - 1; i >= 0; i--) {
        const a = err.attempts[i];
        if (a.outcome.kind === 'failed' && a.outcome.error instanceof UpstreamError) {
          const u = a.outcome.error;
          throw new RunFetchPostError(u.code, u.status === 429 ? 502 : u.status);
        }
      }
      throw new RunFetchPostError('fetch-failed', 502);
    }
    console.error('extract-proxy/fetch-post: unexpected', String(err));
    throw new RunFetchPostError('fetch-failed', 502);
  }
}
```

- [ ] **Step 2.2: Rewrite `handleFetchPost` to wrap `runFetchPost`**

Replace the body of `handleFetchPost` (everything after the `parsed` zod check passes) with:

```ts
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  let result: FetchPostResponse;
  try {
    result = await runFetchPost(parsed.data.url, env);
  } catch (err) {
    if (err instanceof RunFetchPostError) {
      return errorResponse(err.code, err.status);
    }
    throw err;
  }
  // Spec: 7d cache when Apify fired, 1d for og-only. runFetchPost doesn't
  // expose cacheKind, so reconstruct from the debug echo's route.
  const cacheKind: 'og' | 'apify' = result._debug?.route?.includes('apify')
    ? 'apify'
    : 'og';
  const sMaxAge = cacheKind === 'apify' ? 604800 : 86400;
  return jsonResponse(result, {
    headers: { 'cache-control': `public, s-maxage=${sMaxAge}` },
  });
```

- [ ] **Step 2.3: Run worker tests**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all existing tests pass.

- [ ] **Step 2.4: Commit**

```bash
git add workers/extract-proxy/src/fetch-post.ts
git commit -m "refactor(worker): expose runFetchPost as a pure helper"
```

---

## Task 3: Create the KV namespace and wire it in `wrangler.toml`

**Goal:** Stand up the `EXTRACT_STATE` KV namespace that backs the new orchestrator's cache.

**Files:**

- Modify: `workers/extract-proxy/wrangler.toml`
- Modify: `workers/extract-proxy/src/index.ts` (Env type)

- [ ] **Step 3.1: Create the namespace via Wrangler CLI**

```bash
cd workers/extract-proxy
npx wrangler kv namespace create EXTRACT_STATE
```

Wrangler prints `id = "..."`. Copy the id. Run it again with `--preview` for the local dev id:

```bash
npx wrangler kv namespace create EXTRACT_STATE --preview
```

- [ ] **Step 3.2: Add the binding to `wrangler.toml`**

Append to `workers/extract-proxy/wrangler.toml` (above `[observability]`):

```toml
# Per-content_hash extraction state. Writes: pending → partial → done (or
# error). TTL via expirationTtl on each put; see EXTRACT_STATE_TTL_SECONDS
# in src/extract-state.ts.
[[kv_namespaces]]
binding = "EXTRACT_STATE"
id = "<paste prod id here>"
preview_id = "<paste preview id here>"
```

- [ ] **Step 3.3: Extend `Env` in `src/index.ts`**

```ts
export interface Env {
  GEMINI_API_KEY: string;
  GOOGLE_PLACES_API_KEY: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;
  CF_AIG_TOKEN: string;
  RATE_LIMIT: RateLimitBinding;
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  RC_REST_API_KEY: string;
  EXTRACT_STATE: KVNamespace;
}
```

(`KVNamespace` is provided by `@cloudflare/workers-types` — already a dev dependency.)

- [ ] **Step 3.4: Typecheck**

```bash
npx tsc --noEmit --project workers/extract-proxy/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3.5: Commit**

```bash
git add workers/extract-proxy/wrangler.toml workers/extract-proxy/src/index.ts
git commit -m "feat(worker): bind EXTRACT_STATE KV namespace"
```

---

## Task 4: Define the new `/extract` request/response schema

**Goal:** Add Zod schemas for the new HTTP shape `POST /extract` (orchestrator request) and `GET /extract/:contentHash` (poll response). Keep the existing `requestBodySchema` (legacy text/vision/video shapes) — `runExtract` still consumes it internally.

**Files:**

- Create: `workers/extract-proxy/src/orchestrator-schema.ts`
- Test: `workers/extract-proxy/__tests__/orchestrator-schema.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `workers/extract-proxy/__tests__/orchestrator-schema.test.ts`:

```ts
import {
  orchestratorRequestSchema,
  orchestratorStateSchema,
} from '../src/orchestrator-schema';

describe('orchestratorRequestSchema', () => {
  it('accepts kind=url with a valid url and 64-hex contentHash', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'a'.repeat(64),
      kind: 'url',
      url: 'https://www.instagram.com/reel/abc/',
    });
    expect(r.success).toBe(true);
  });

  it('rejects when contentHash is not 64-hex', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'short',
      kind: 'url',
      url: 'https://www.instagram.com/reel/abc/',
    });
    expect(r.success).toBe(false);
  });

  it('rejects when kind=url but url missing', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'a'.repeat(64),
      kind: 'url',
    });
    expect(r.success).toBe(false);
  });
});

describe('orchestratorStateSchema', () => {
  it('parses a done state with places', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'done',
      caption: 'hi',
      coverUrl: 'https://cdn.example/a.jpg',
      places: [
        { name: 'Tartine', city: 'SF', address: '', category: 'food', country_code: 'US' },
      ],
      model: 'gemini-2.5-flash-lite',
    });
    expect(r.success).toBe(true);
  });

  it('parses a pending state with no places', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'pending',
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run the test to see it fail**

```bash
npm test --silent --prefix workers/extract-proxy -- orchestrator-schema
```

Expected: FAIL — `Cannot find module '../src/orchestrator-schema'`.

- [ ] **Step 4.3: Write `orchestrator-schema.ts`**

```ts
import { z } from 'zod';
import { placeSchema } from './schema';

const HEX_64 = /^[0-9a-f]{64}$/;

const urlKindSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  kind: z.literal('url'),
  url: z.string().url(),
  suggestedTripId: z.string().optional(),
});

export const orchestratorRequestSchema = urlKindSchema;
export type OrchestratorRequest = z.infer<typeof orchestratorRequestSchema>;

// Shape stored in EXTRACT_STATE KV and returned by both POST and GET. The
// status field is the state machine; later states carry more fields.
//   pending  → only the hash is known; nothing else yet
//   partial  → fetch-post finished; caption + coverUrl available
//   done     → extraction finished; places + model present
//   error    → terminal failure; code carries the reason
export const orchestratorStateSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  status: z.enum(['pending', 'partial', 'done', 'error']),
  caption: z.string().optional(),
  coverUrl: z.string().url().optional(),
  videoPresent: z.boolean().optional(),
  places: z.array(placeSchema).optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;
```

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
npm test --silent --prefix workers/extract-proxy -- orchestrator-schema
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add workers/extract-proxy/src/orchestrator-schema.ts workers/extract-proxy/__tests__/orchestrator-schema.test.ts
git commit -m "feat(worker): add orchestrator request/state schemas"
```

---

## Task 5: Per-post dedup helper

**Goal:** A small pure function that takes a list of `ExtractedPlace` and returns a deduplicated list. Uses the same key as `modules/extraction/extraction.ts:208-216`: case-insensitive name + trimmed city + trimmed address. Server-side per-post dedup means the client always inserts what the worker returns, without having to dedup itself.

**Files:**

- Create: `workers/extract-proxy/src/dedupe.ts`
- Test: `workers/extract-proxy/__tests__/dedupe.test.ts`

- [ ] **Step 5.1: Write the failing test**

```ts
import { dedupePlaces } from '../src/dedupe';

describe('dedupePlaces', () => {
  const base = { address: '', country_code: 'US', category: 'food' as const };

  it('drops case-insensitive name+city duplicates', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'San Francisco' },
      { ...base, name: 'tartine', city: 'San Francisco' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Tartine');
  });

  it('keeps places that differ in city', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'San Francisco' },
      { ...base, name: 'Tartine', city: 'Berlin' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps places that differ in address', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'SF', address: '600 Guerrero' },
      { ...base, name: 'Tartine', city: 'SF', address: '375 Valencia' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('preserves order (first occurrence wins)', () => {
    const out = dedupePlaces([
      { ...base, name: 'A', city: 'X' },
      { ...base, name: 'B', city: 'Y' },
      { ...base, name: 'A', city: 'X' },
    ]);
    expect(out.map((p) => p.name)).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 5.2: Run the test to see it fail**

```bash
npm test --silent --prefix workers/extract-proxy -- dedupe
```

Expected: FAIL — `Cannot find module '../src/dedupe'`.

- [ ] **Step 5.3: Write `dedupe.ts`**

```ts
import type { ExtractedPlace } from './schema';

export function dedupePlaces(places: ExtractedPlace[]): ExtractedPlace[] {
  const seen = new Set<string>();
  const out: ExtractedPlace[] = [];
  for (const p of places) {
    const key =
      p.name.toLowerCase() +
      '::' +
      p.city.trim().toLowerCase() +
      '::' +
      p.address.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
```

- [ ] **Step 5.4: Run tests**

```bash
npm test --silent --prefix workers/extract-proxy -- dedupe
```

Expected: PASS (4/4).

- [ ] **Step 5.5: Commit**

```bash
git add workers/extract-proxy/src/dedupe.ts workers/extract-proxy/__tests__/dedupe.test.ts
git commit -m "feat(worker): add per-post dedupe helper"
```

---

## Task 6: Implement the orchestrator (state machine in `ctx.waitUntil`)

**Goal:** A pure async function `orchestrate(req, env, ctx)` that runs the full pipeline (fetch-post → choose mode → extract → dedupe) and writes `EXTRACT_STATE` KV at each transition (`pending` → `partial` → `done` or `error`). Wrapped in `ctx.waitUntil` by the HTTP handler in Task 7 so it survives the response.

**Files:**

- Create: `workers/extract-proxy/src/orchestrator.ts`
- Test: `workers/extract-proxy/__tests__/orchestrator.test.ts`

- [ ] **Step 6.1: Write the failing test**

```ts
import { orchestrate, EXTRACT_STATE_TTL_SECONDS } from '../src/orchestrator';
import type { OrchestratorRequest, OrchestratorState } from '../src/orchestrator-schema';
import type { FetchPostResponse } from '../src/fetch-post';
import type { Env } from '../src/index';

const HASH = 'a'.repeat(64);

function makeKv() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      if (opts?.expirationTtl != null) ttls.set(key, opts.expirationTtl);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function captureState(kv: ReturnType<typeof makeKv>): OrchestratorState | null {
  const raw = kv.store.get(`state:${HASH}`);
  return raw ? (JSON.parse(raw) as OrchestratorState) : null;
}

// Minimal env stub. runFetchPost and runExtract are injected via opts so the
// test never goes near Gemini / Apify / RC.
function makeEnv(): Env {
  return {
    GEMINI_API_KEY: 'k',
    GOOGLE_PLACES_API_KEY: 'k',
    CF_ACCOUNT_ID: 'a',
    AI_GATEWAY_NAME: 'g',
    CF_AIG_TOKEN: 't',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: makeKv() as unknown as KVNamespace,
  };
}

const noopCtx = { waitUntil: () => {} };

describe('orchestrate', () => {
  it('writes pending then partial then done for a video URL', async () => {
    const env = makeEnv();
    const kv = env.EXTRACT_STATE as unknown as ReturnType<typeof makeKv>;
    const req: OrchestratorRequest = {
      contentHash: HASH,
      kind: 'url',
      url: 'https://www.instagram.com/reel/abc/',
    };
    const states: string[] = [];
    await orchestrate(req, env, noopCtx, {
      runFetchPost: async () => {
        states.push(captureState(kv)!.status);
        return {
          platform: 'instagram',
          permalink: req.url!,
          caption: 'A great place',
          imageUrls: ['https://cdn.example/cover.jpg'],
          author: '@x',
          videoUrl: 'https://cdn.example/v.mp4',
          videoDuration: 12,
        } as FetchPostResponse;
      },
      runExtract: async () => {
        states.push(captureState(kv)!.status);
        return {
          places: [
            {
              name: 'Tartine',
              city: 'SF',
              address: '',
              category: 'food',
              country_code: 'US',
            },
            {
              name: 'tartine',
              city: 'SF',
              address: '',
              category: 'food',
              country_code: 'US',
            },
          ],
          model: 'gemini-test',
        };
      },
    });

    expect(states).toEqual(['pending', 'partial']);
    const final = captureState(kv)!;
    expect(final.status).toBe('done');
    expect(final.places).toHaveLength(1); // dedupe collapsed the duplicate
    expect(final.caption).toBe('A great place');
    expect(final.coverUrl).toBe('https://cdn.example/cover.jpg');
    expect(final.model).toBe('gemini-test');
  });

  it('writes error state when runFetchPost throws', async () => {
    const env = makeEnv();
    const kv = env.EXTRACT_STATE as unknown as ReturnType<typeof makeKv>;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/x/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          throw new Error('boom');
        },
        runExtract: async () => {
          throw new Error('should not be called');
        },
      },
    );
    const final = captureState(kv)!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('fetch-failed');
  });

  it('chooses video mode when fetch returns videoUrl', async () => {
    const env = makeEnv();
    let extractCallMode: string | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/y/' },
      env,
      noopCtx,
      {
        runFetchPost: async () =>
          ({
            platform: 'instagram',
            permalink: '',
            caption: 'cap',
            imageUrls: [],
            author: null,
            videoUrl: 'https://cdn/v.mp4',
            videoDuration: 12,
          }) as FetchPostResponse,
        runExtract: async (body) => {
          extractCallMode = body.mode;
          return { places: [], model: 'm' };
        },
      },
    );
    expect(extractCallMode).toBe('video');
  });

  it('chooses vision mode when no video but cover present', async () => {
    const env = makeEnv();
    let extractCallMode: string | null = null;
    // runExtract receives `imageBase64` from the cover fetch; stub the
    // image fetcher so we don't hit the network.
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () =>
          ({
            platform: 'instagram',
            permalink: '',
            caption: 'cap',
            imageUrls: ['https://cdn/c.jpg'],
            author: null,
          }) as FetchPostResponse,
        runExtract: async (body) => {
          extractCallMode = body.mode;
          return { places: [], model: 'm' };
        },
        fetchImageBase64: async () => 'b64data',
      },
    );
    expect(extractCallMode).toBe('vision');
  });

  it('chooses text mode when no video and no cover but caption present', async () => {
    const env = makeEnv();
    let extractCallMode: string | null = null;
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/p/z/' },
      env,
      noopCtx,
      {
        runFetchPost: async () =>
          ({
            platform: 'instagram',
            permalink: '',
            caption: 'a long caption naming places',
            imageUrls: [],
            author: null,
          }) as FetchPostResponse,
        runExtract: async (body) => {
          extractCallMode = body.mode;
          return { places: [], model: 'm' };
        },
      },
    );
    expect(extractCallMode).toBe('text');
  });

  it('re-runs when an existing pending state is older than STALE_PENDING_MS', async () => {
    const env = makeEnv();
    const kv = env.EXTRACT_STATE as unknown as ReturnType<typeof makeKv>;
    // Seed a stale-pending state.
    await (env.EXTRACT_STATE as KVNamespace).put(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }),
    );
    const calls = { fetch: 0, extract: 0 };
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/a/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          calls.fetch++;
          return {
            platform: 'instagram',
            permalink: '',
            caption: 'cap',
            imageUrls: [],
            author: null,
          } as FetchPostResponse;
        },
        runExtract: async () => {
          calls.extract++;
          return { places: [], model: 'm' };
        },
      },
    );
    expect(calls.fetch).toBe(1); // stale pending → re-orchestrate
  });

  it('returns cached done state without calling runFetchPost or runExtract', async () => {
    const env = makeEnv();
    const kv = env.EXTRACT_STATE as unknown as ReturnType<typeof makeKv>;
    // Seed a done state in KV.
    await (env.EXTRACT_STATE as KVNamespace).put(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      }),
    );
    const calls = { fetch: 0, extract: 0 };
    await orchestrate(
      { contentHash: HASH, kind: 'url', url: 'https://www.instagram.com/reel/a/' },
      env,
      noopCtx,
      {
        runFetchPost: async () => {
          calls.fetch++;
          throw new Error('nope');
        },
        runExtract: async () => {
          calls.extract++;
          throw new Error('nope');
        },
      },
    );
    expect(calls).toEqual({ fetch: 0, extract: 0 });
    expect(captureState(kv)!.model).toBe('cached');
  });
});

describe('EXTRACT_STATE_TTL_SECONDS', () => {
  it('is 72 hours', () => {
    expect(EXTRACT_STATE_TTL_SECONDS).toBe(72 * 60 * 60);
  });
});
```

- [ ] **Step 6.2: Run the test to see it fail**

```bash
npm test --silent --prefix workers/extract-proxy -- orchestrator.test
```

Expected: FAIL — module not found.

- [ ] **Step 6.3: Write `orchestrator.ts`**

```ts
import type { Env } from './index';
import type { OrchestratorRequest, OrchestratorState } from './orchestrator-schema';
import type { WaitUntilCtx } from './video';
import type { RequestBody, ExtractedPlace } from './schema';
import { runFetchPost as defaultRunFetchPost } from './fetch-post';
import { runExtract as defaultRunExtract } from './index';
import type { FetchPostResponse } from './fetch-post';
import { dedupePlaces } from './dedupe';

export const EXTRACT_STATE_TTL_SECONDS = 72 * 60 * 60;
const KV_KEY = (hash: string) => `state:${hash}`;

export type OrchestrateDeps = {
  runFetchPost?: (url: string, env: Env) => Promise<FetchPostResponse>;
  runExtract?: (
    body: RequestBody,
    env: Env,
    ctx: WaitUntilCtx,
  ) => Promise<{ places: ExtractedPlace[]; model: string }>;
  /** Test seam — fetches the cover URL and returns base64 image data. */
  fetchImageBase64?: (url: string) => Promise<string>;
};

export async function readState(
  hash: string,
  env: Env,
): Promise<OrchestratorState | null> {
  const raw = await env.EXTRACT_STATE.get(KV_KEY(hash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestratorState;
  } catch {
    return null;
  }
}

async function writeState(
  state: OrchestratorState,
  env: Env,
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await env.EXTRACT_STATE.put(KV_KEY(state.contentHash), JSON.stringify(state), {
    expirationTtl: EXTRACT_STATE_TTL_SECONDS,
  });
}

/**
 * Stale-pending threshold. If a KV state is `pending` (or `partial`) with a
 * startedAt older than this, the worker that wrote it is presumed dead
 * (isolate killed mid-run) and we re-orchestrate. Set generously above the
 * 95th-percentile real pipeline wall-clock for video extractions.
 */
export const STALE_PENDING_MS = 5 * 60 * 1000;

export async function orchestrate(
  req: OrchestratorRequest,
  env: Env,
  ctx: WaitUntilCtx,
  deps: OrchestrateDeps = {},
): Promise<void> {
  // Idempotency: if a usable state already exists, do nothing. Callers (the
  // HTTP layer) read state independently before calling orchestrate, but a
  // double-trigger race ends here.
  //
  // Exception: a `pending` (or `partial`) state older than STALE_PENDING_MS
  // means the worker that wrote it died before reaching `done`. Re-run.
  // `done` and `error` are terminal and never re-run from here (clients
  // delete the KV key manually to force a retry on `error`).
  const existing = await readState(req.contentHash, env);
  if (existing && (existing.status === 'done' || existing.status === 'error')) return;
  if (existing && (existing.status === 'pending' || existing.status === 'partial')) {
    const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : 0;
    const age = Date.now() - startedAt;
    if (Number.isFinite(age) && age < STALE_PENDING_MS) return;
    console.warn(
      'orchestrate: re-running stale state',
      'hash=' + req.contentHash,
      'status=' + existing.status,
      'ageMs=' + age,
    );
  }

  const startedAt = new Date().toISOString();
  await writeState(
    { contentHash: req.contentHash, status: 'pending', startedAt },
    env,
  );

  const runFetchPost = deps.runFetchPost ?? defaultRunFetchPost;
  const runExtract = deps.runExtract ?? defaultRunExtract;
  const fetchImageBase64 = deps.fetchImageBase64 ?? defaultFetchImageBase64;

  let fetched: FetchPostResponse;
  try {
    fetched = await runFetchPost(req.url, env);
  } catch (err) {
    console.error('orchestrate: fetch failed', String(err));
    await writeState(
      { contentHash: req.contentHash, status: 'error', error: 'fetch-failed', startedAt },
      env,
    );
    return;
  }

  await writeState(
    {
      contentHash: req.contentHash,
      status: 'partial',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      startedAt,
    },
    env,
  );

  let extractBody: RequestBody;
  if (fetched.videoUrl) {
    extractBody = {
      mode: 'video',
      video: { url: fetched.videoUrl, durationSec: fetched.videoDuration ?? undefined },
      caption: fetched.caption,
    };
  } else if (fetched.imageUrls.length > 0) {
    let imageBase64: string;
    try {
      imageBase64 = await fetchImageBase64(fetched.imageUrls[0]!);
    } catch (err) {
      console.error('orchestrate: cover fetch failed', String(err));
      // Soft-degrade: drop to text mode using the caption.
      extractBody = { mode: 'text', text: fetched.caption || '(no caption)' };
      const result = await runExtractGuarded(extractBody, env, ctx, runExtract, req, fetched);
      if (!result) return;
      return;
    }
    extractBody = { mode: 'vision', imageBase64, caption: fetched.caption };
  } else if (fetched.caption.trim().length > 0) {
    extractBody = { mode: 'text', text: fetched.caption };
  } else {
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: 'no-extractable-content',
        startedAt,
      },
      env,
    );
    return;
  }

  await runExtractGuarded(extractBody, env, ctx, runExtract, req, fetched);
}

async function runExtractGuarded(
  extractBody: RequestBody,
  env: Env,
  ctx: WaitUntilCtx,
  runExtract: NonNullable<OrchestrateDeps['runExtract']>,
  req: OrchestratorRequest,
  fetched: FetchPostResponse,
): Promise<boolean> {
  let result: { places: ExtractedPlace[]; model: string };
  try {
    result = await runExtract(extractBody, env, ctx);
  } catch (err) {
    console.error('orchestrate: extract failed', String(err));
    await writeState(
      {
        contentHash: req.contentHash,
        status: 'error',
        error: 'extract-failed',
        caption: fetched.caption,
        coverUrl: fetched.imageUrls[0],
        videoPresent: !!fetched.videoUrl,
      },
      env,
    );
    return false;
  }

  const places = dedupePlaces(result.places);
  await writeState(
    {
      contentHash: req.contentHash,
      status: 'done',
      caption: fetched.caption,
      coverUrl: fetched.imageUrls[0],
      videoPresent: !!fetched.videoUrl,
      places,
      model: result.model,
    },
    env,
  );
  return true;
}

async function defaultFetchImageBase64(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`image-fetch-${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  // Same chunked base64 strategy as video.ts.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
  return btoa(bin);
}
```

- [ ] **Step 6.4: Run the test to verify it passes**

```bash
npm test --silent --prefix workers/extract-proxy -- orchestrator.test
```

Expected: PASS (6/6).

- [ ] **Step 6.5: Commit**

```bash
git add workers/extract-proxy/src/orchestrator.ts workers/extract-proxy/__tests__/orchestrator.test.ts
git commit -m "feat(worker): add orchestrator state machine + KV cache"
```

---

## Task 7: Wire up the new `POST /extract` + `GET /extract/:contentHash` HTTP routes

**Goal:** New shape on `POST /extract` (orchestrator request); the legacy shape is no longer accepted on this path. New `GET /extract/:contentHash` reads KV.

**Files:**

- Modify: `workers/extract-proxy/src/index.ts` (replace `handleExtract` HTTP wiring and `route()`)
- Test: `workers/extract-proxy/__tests__/handler-orchestrator.test.ts`

- [ ] **Step 7.1: Write the new HTTP handlers**

In `src/index.ts`, replace the old `handleExtract` HTTP-shape with the new orchestrator handler. **Keep `runExtract` exported (Task 1) — the orchestrator calls it.** Delete the legacy `handleExtract` function entirely (its contents moved to `runExtract` in Task 1; we no longer need the HTTP wrapper that consumed the legacy shape).

Add these handlers near the bottom of `src/index.ts`:

```ts
import { orchestratorRequestSchema } from './orchestrator-schema';
import { orchestrate, readState } from './orchestrator';

export async function handleExtractPost(
  request: Request,
  env: Env,
  ctx: WaitUntilCtx,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse('content-type-must-be-json', 400);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse('invalid-json', 400);
  }
  const parsed = orchestratorRequestSchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid-request-body', 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success: rateOk } = await env.RATE_LIMIT.limit({ key: ip });
  if (!rateOk) return errorResponse('rate-limited', 429, { 'retry-after': '60' });

  const cached = await readState(parsed.data.contentHash, env);
  if (cached) {
    return jsonResponse(cached, { status: 200 });
  }

  // Schedule the pipeline after the response. ctx.waitUntil keeps the worker
  // isolate alive (paid plan: ~5 min wall clock — enough for video extraction).
  ctx.waitUntil(orchestrate(parsed.data, env, ctx));

  return jsonResponse(
    {
      contentHash: parsed.data.contentHash,
      status: 'pending',
      startedAt: new Date().toISOString(),
    },
    { status: 202 },
  );
}

export async function handleExtractGet(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'GET') return errorResponse('method-not-allowed', 405);

  const gate = await requireEntitlement(request, env);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const m = url.pathname.match(/^\/extract\/([0-9a-f]{64})$/);
  if (!m) return errorResponse('invalid-content-hash', 400);
  const hash = m[1]!;

  const state = await readState(hash, env);
  if (!state) {
    return jsonResponse({ contentHash: hash, status: 'missing' }, { status: 404 });
  }
  return jsonResponse(state, { status: 200 });
}
```

- [ ] **Step 7.2: Update `route()` to wire the new routes and drop legacy ones**

Replace the `route()` function:

```ts
async function route(request: Request, env: Env, ctx: WaitUntilCtx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/extract' && request.method === 'POST') return handleExtractPost(request, env, ctx);
  if (path.startsWith('/extract/') && request.method === 'GET') return handleExtractGet(request, env);
  if (path === '/enrich') return handleEnrich(request, env);
  if (path.startsWith('/photo/')) return handlePhoto(request, env);
  return errorResponse('not-found', 404);
}
```

Note `/fetch-post` is gone — the orchestrator calls `runFetchPost` directly.

- [ ] **Step 7.3: Write integration tests for the new HTTP layer**

Create `workers/extract-proxy/__tests__/handler-orchestrator.test.ts`:

```ts
import { handleExtractPost, handleExtractGet } from '../src/index';
import type { Env } from '../src/index';

const HASH = 'a'.repeat(64);
const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
  };
}

function makeEnv(kv = makeKv()): Env {
  return {
    GEMINI_API_KEY: 'k',
    GOOGLE_PLACES_API_KEY: 'k',
    CF_ACCOUNT_ID: 'a',
    AI_GATEWAY_NAME: 'g',
    CF_AIG_TOKEN: 't',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: kv as unknown as KVNamespace,
  };
}

function setupCachesAndRcStub() {
  const store = new Map<string, Response>();
  // @ts-expect-error test polyfill
  globalThis.caches = {
    default: {
      async match(k: Request) {
        const r = store.get(k.url);
        return r ? r.clone() : undefined;
      },
      async put(k: Request, v: Response) {
        store.set(k.url, v.clone());
      },
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.revenuecat.com/v1/subscribers/')) {
      return new Response(
        JSON.stringify({
          subscriber: {
            entitlements: {
              pro: { expires_date: new Date(Date.now() + 60_000).toISOString() },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error('unexpected fetch in test: ' + url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function postExtract(body: unknown): Request {
  return new Request('https://proxy.example.com/extract', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
      'X-RC-User-Id': VALID_ID,
    },
    body: JSON.stringify(body),
  });
}

function getExtract(hash: string): Request {
  return new Request(`https://proxy.example.com/extract/${hash}`, {
    method: 'GET',
    headers: { 'X-RC-User-Id': VALID_ID },
  });
}

describe('handleExtractPost', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setupCachesAndRcStub();
  });
  afterEach(() => restore());

  it('returns 202 pending and schedules orchestrate on cache miss', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('pending');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns cached state immediately on hit (no waitUntil)', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      }),
    );
    const env = makeEnv(kv);
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({
        contentHash: HASH,
        kind: 'url',
        url: 'https://www.instagram.com/reel/a/',
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; model: string };
    expect(body.status).toBe('done');
    expect(body.model).toBe('cached');
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid contentHash shape', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const res = await handleExtractPost(
      postExtract({ contentHash: 'short', kind: 'url', url: 'https://x.test/' }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when X-RC-User-Id header is absent', async () => {
    const env = makeEnv();
    const ctx = { waitUntil: jest.fn() };
    const req = new Request('https://proxy.example.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: HASH, kind: 'url', url: 'https://x.test/' }),
    });
    const res = await handleExtractPost(req, env, ctx);
    expect(res.status).toBe(401);
  });
});

describe('handleExtractGet', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setupCachesAndRcStub();
  });
  afterEach(() => restore());

  it('returns 404 missing when KV has nothing', async () => {
    const env = makeEnv();
    const res = await handleExtractGet(getExtract(HASH), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('missing');
  });

  it('returns the cached state when KV has a row', async () => {
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'done',
        places: [],
        model: 'cached',
      }),
    );
    const env = makeEnv(kv);
    const res = await handleExtractGet(getExtract(HASH), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('done');
  });

  it('returns 400 for malformed hash in path', async () => {
    const env = makeEnv();
    const req = new Request('https://proxy.example.com/extract/short', {
      method: 'GET',
      headers: { 'X-RC-User-Id': VALID_ID },
    });
    const res = await handleExtractGet(req, env);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7.4: Run all worker tests**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all tests pass. **Note:** the old `handler.test.ts` tests will now fail because they call `handleExtract` (deleted) with the legacy shape. Delete `__tests__/handler.test.ts` and `__tests__/handler-vision.test.ts` (their behavior is now covered by Task 1 — `runExtract` unit tests in Task 8 — and by `handler-orchestrator.test.ts`).

```bash
git rm workers/extract-proxy/__tests__/handler.test.ts workers/extract-proxy/__tests__/handler-vision.test.ts
```

The deletes are intentional: those tests target a route that no longer exists. The Gemini-call logic they exercise lives in `runExtract` and is covered by new unit tests in Task 8.

- [ ] **Step 7.5: Commit**

```bash
git add workers/extract-proxy/src/index.ts workers/extract-proxy/__tests__/handler-orchestrator.test.ts
git commit -m "feat(worker): replace legacy /extract with orchestrator + GET poll"
```

---

## Task 8: Unit tests for `runExtract` (replaces deleted handler tests)

**Goal:** The Gemini-call behavior previously covered by `handler.test.ts` and `handler-vision.test.ts` moves into a unit test on `runExtract` (no HTTP layer).

**Files:**

- Create: `workers/extract-proxy/__tests__/run-extract.test.ts`

- [ ] **Step 8.1: Port the Gemini behavior tests to call `runExtract` directly**

```ts
import { runExtract, RunExtractError } from '../src/index';
import type { Env } from '../src/index';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: 'gem',
    GOOGLE_PLACES_API_KEY: 'pl',
    CF_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'gw',
    CF_AIG_TOKEN: 'aig',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: {} as KVNamespace,
    ...overrides,
  };
}

function geminiOk(places: Array<{ name: string; city: string; category: string }>): Response {
  const padded = places.map((p) => ({ address: '', country_code: '', ...p }));
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ places: padded }) }] } },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('runExtract', () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('returns places + model on success', async () => {
    globalThis.fetch = (async () =>
      geminiOk([{ name: 'A', city: 'B', category: 'food' }])) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places).toHaveLength(1);
    expect(result.model).toBe('gemini-2.5-flash-lite');
  });

  it('throws server-misconfigured when GEMINI_API_KEY missing', async () => {
    await expect(
      runExtract({ mode: 'text', text: 'hi' }, makeEnv({ GEMINI_API_KEY: '' })),
    ).rejects.toMatchObject({
      name: 'RunExtractError',
      code: 'server-misconfigured',
      status: 500,
    });
  });

  it('throws upstream-error on Gemini 5xx', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toBeInstanceOf(
      RunExtractError,
    );
  });

  it('throws upstream-malformed-inner-json when Gemini returns broken JSON', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{ "places": [' }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    await expect(runExtract({ mode: 'text', text: 'hi' }, makeEnv())).rejects.toMatchObject({
      code: 'upstream-malformed-inner-json',
    });
  });

  it('coerces lowercase country_code', async () => {
    globalThis.fetch = (async () =>
      geminiOk([{ name: 'A', city: 'B', category: 'food' }]).then(() =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        places: [
                          {
                            name: 'A',
                            city: 'B',
                            address: '',
                            category: 'food',
                            country_code: 'jp',
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const result = await runExtract({ mode: 'text', text: 'hi' }, makeEnv());
    expect(result.places[0]?.country_code).toBe('JP');
  });
});
```

- [ ] **Step 8.2: Run tests**

```bash
npm test --silent --prefix workers/extract-proxy -- run-extract
```

Expected: PASS (5/5).

- [ ] **Step 8.3: Run the full worker suite**

```bash
npm test --silent --prefix workers/extract-proxy
```

Expected: all tests pass; no skipped tests except known existing ones.

- [ ] **Step 8.4: Commit**

```bash
git add workers/extract-proxy/__tests__/run-extract.test.ts
git commit -m "test(worker): unit tests for runExtract"
```

---

## Task 9: Deploy the worker and smoke-test

**Goal:** Push the new worker code, hit `POST /extract` and `GET /extract/:hash` from curl, and confirm the state machine ticks through.

- [ ] **Step 9.1: Deploy**

```bash
npx wrangler deploy --cwd workers/extract-proxy
```

Expected: deploy succeeds with the new `extract_state` binding listed.

- [ ] **Step 9.2: Smoke-test POST /extract (URL kind)**

Pick a real Instagram Reel URL to test. Replace `$RC_USER_ID` with your dev RC anonymous id (visible in app launch logs).

```bash
HASH=$(echo -n "https://www.instagram.com/reel/<id>/" | shasum -a 256 | awk '{print $1}')
curl -s -X POST https://trip-pocket-extract-proxy.ankerek.workers.dev/extract \
  -H "content-type: application/json" \
  -H "X-RC-User-Id: $RC_USER_ID" \
  -d "{\"contentHash\":\"$HASH\",\"kind\":\"url\",\"url\":\"https://www.instagram.com/reel/<id>/\"}"
```

Expected: `{"status":"pending", ...}` (status 202).

- [ ] **Step 9.3: Poll GET /extract/:hash**

```bash
for i in 1 2 3 4 5 6; do
  echo "poll $i:"
  curl -s https://trip-pocket-extract-proxy.ankerek.workers.dev/extract/$HASH \
    -H "X-RC-User-Id: $RC_USER_ID"
  echo
  sleep 5
done
```

Expected: pending → partial (caption, coverUrl) → done (places array).

- [ ] **Step 9.4: No commit (deploy-only step)**

---

## Task 10: App writes RC user id into App Group `UserDefaults`

**Goal:** The share extension can't import RevenueCat in-process (extension bundles must stay tiny). The main app, after RC SDK init, writes the resolved `appUserID` to App Group `UserDefaults` so the extension can read it.

**Files:**

- Modify: `lib/entitlement/init.ts` (or wherever the main app calls `Purchases.configure` / `Purchases.logIn`)
- Modify: `app/_layout.tsx` (call into the new write helper after RC is initialized)
- Modify: `native/ShareExtension/EntitlementReader.swift` (consume from App Group)
- Modify: `modules/ShareUserId/...` (new native module — see Step 10.1 for the choice)

- [ ] **Step 10.1: Add a tiny native module that writes to App Group `UserDefaults`**

There is no built-in JS way to write to App Group `UserDefaults` from React Native. Add a one-call expo module.

Create `modules/share-user-id/index.ts`:

```ts
import { requireOptionalNativeModule } from 'expo';

type Mod = {
  setUserId(id: string): void;
};

const native = requireOptionalNativeModule<Mod>('ShareUserId');

export function setShareUserId(id: string): void {
  native?.setUserId(id);
}
```

Create `modules/share-user-id/ios/ShareUserIdModule.swift`:

```swift
import ExpoModulesCore

public class ShareUserIdModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShareUserId")

    Function("setUserId") { (id: String) -> Void in
      let suite = "group.com.trippocket.shared"
      guard let d = UserDefaults(suiteName: suite) else { return }
      d.set(id, forKey: "rcUserId")
    }
  }
}
```

Create `modules/share-user-id/expo-module.config.json`:

```json
{
  "platforms": ["ios"],
  "ios": {
    "modules": ["ShareUserIdModule"]
  }
}
```

- [ ] **Step 10.2: Call the writer after RC SDK is configured**

Locate the existing `Purchases.configure(...)` call (search for `configure` in `lib/entitlement/`). After the configure call, and again after any `Purchases.logIn` that changes the id, write to the App Group:

```ts
import { setShareUserId } from '@/modules/share-user-id';
// ...
const info = await Purchases.getCustomerInfo();
setShareUserId(info.originalAppUserId);
```

- [ ] **Step 10.3: Read from the App Group on the extension side**

Modify `native/ShareExtension/EntitlementReader.swift` (or add a new sibling file `ShareUserIdReader.swift`):

```swift
import Foundation

enum ShareUserIdReader {
  static func read() -> String? {
    let suite = "group.com.trippocket.shared"
    return UserDefaults(suiteName: suite)?.string(forKey: "rcUserId")
  }
}
```

- [ ] **Step 10.4: Run the iOS prebuild + build to verify the module compiles**

```bash
npx expo prebuild --platform ios --clean
cd ios && pod install && cd ..
```

Run a quick Xcode-side build (`xcodebuild` or via Expo Run):

```bash
npx expo run:ios
```

Expected: build succeeds. App launches; check Xcode console for any RC log lines.

- [ ] **Step 10.5: Manually verify the App Group key**

Add a temporary `console.log` after `setShareUserId(info.originalAppUserId)` to confirm the value being written. Launch the app, share an Instagram URL — Task 11's enqueue will fail without this key, which is the integration test for it.

Remove the temporary console.log before committing.

- [ ] **Step 10.6: Commit**

```bash
git add modules/share-user-id native/ShareExtension/EntitlementReader.swift lib/entitlement
git commit -m "feat(ios): sync RC user id to App Group UserDefaults"
```

---

## Task 11: Share extension — fire `POST /extract` via background `URLSession` for URL shares

**Goal:** After the existing pending-import write completes, kick off a background HTTP POST to the new `/extract` endpoint. URL kind only in v1.

**Files:**

- Modify: `native/ShareExtension/ShareViewController.swift`
- Create: `native/ShareExtension/PrewarmRequest.swift` (new helper)

- [ ] **Step 11.1: Implement the request builder**

Create `native/ShareExtension/PrewarmRequest.swift`:

```swift
import Foundation
import CommonCrypto

enum PrewarmRequest {
  /// Production worker base. Mirror app.config.ts `extractionProxyUrl` without the path suffix.
  static let workerBase = "https://trip-pocket-extract-proxy.ankerek.workers.dev"

  /// Identifier for the background URLSession. Distinct from any other session
  /// the host app might use.
  static let sessionIdentifier = "com.trippocket.share.prewarm"

  static func sha256Hex(_ s: String) -> String {
    let data = Data(s.utf8)
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash) }
    return hash.map { String(format: "%02x", $0) }.joined()
  }

  static func makeRequest(url: String, rcUserId: String) -> (URLRequest, Data)? {
    let hash = sha256Hex(url)
    let body: [String: Any] = [
      "contentHash": hash,
      "kind": "url",
      "url": url,
    ]
    guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return nil }
    guard let endpoint = URL(string: "\(workerBase)/extract") else { return nil }
    var req = URLRequest(url: endpoint)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.setValue(rcUserId, forHTTPHeaderField: "X-RC-User-Id")
    // Background URLSession ignores httpBody on uploadTask; we attach the payload
    // via uploadTask(with:fromFile:) — the caller writes payload to a temp file.
    return (req, payload)
  }

  /// Writes the JSON body to a file inside the App Group container so the
  /// background URLSession can read from it even after the share extension
  /// has terminated. The extension's own temp dir (`FileManager.default
  /// .temporaryDirectory`) may be purged by iOS once the extension exits;
  /// the App Group container persists for the lifetime of the host app.
  static func writeBodyToAppGroupFile(_ data: Data) -> URL? {
    let suite = "group.com.trippocket.shared"
    guard let containerURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: suite,
    ) else { return nil }
    let dir = containerURL.appendingPathComponent("prewarm-bodies", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let fileURL = dir.appendingPathComponent(UUID().uuidString + ".json")
    do {
      try data.write(to: fileURL)
      return fileURL
    } catch {
      return nil
    }
  }
}
```

- [ ] **Step 11.2: Fire the request after the pending-import write**

In `ShareViewController.swift`, after the existing call that writes the `pending_imports` row for a URL share, add the prewarm call. The exact insertion point is right after the row is persisted and before `extensionContext?.completeRequest(...)`:

```swift
// Pre-warm the extraction pipeline so the app opens to a ready result.
// URL kind only in v1; image kind still uses app-side extraction.
if let rcUserId = ShareUserIdReader.read(),
   let (req, body) = PrewarmRequest.makeRequest(url: postUrl, rcUserId: rcUserId),
   let bodyFile = PrewarmRequest.writeBodyToAppGroupFile(body) {
  let cfg = URLSessionConfiguration.background(withIdentifier: PrewarmRequest.sessionIdentifier)
  cfg.sharedContainerIdentifier = "group.com.trippocket.shared"
  let session = URLSession(configuration: cfg)
  let task = session.uploadTask(with: req, fromFile: bodyFile)
  task.resume()
  // Do NOT await — the OS owns the upload now. Extension may dismiss/die
  // before completion; iOS will finish the upload in the host app.
}
```

If `rcUserId` is nil (first launch before the main app ran), the prewarm is skipped — the app on next launch falls back to the on-foreground orchestrator POST (Task 14).

- [ ] **Step 11.3: Smoke-test on a device**

```bash
npx expo run:ios --device
```

In the test device:
1. Open the main app once (writes the RC user id to App Group).
2. Force-quit the main app.
3. Open Instagram, share a Reel to Trip Pocket.
4. Dismiss the share sheet immediately (don't open the app yet).
5. From your terminal:

```bash
# tail the worker
npx wrangler tail --cwd workers/extract-proxy
```

Expected: within a few seconds, the worker logs show a `POST /extract` arriving with the hash + URL. KV gets written.

6. Compute the hash and `GET /extract/:hash`:

```bash
HASH=$(echo -n "https://www.instagram.com/reel/<id>/" | shasum -a 256 | awk '{print $1}')
curl -s https://trip-pocket-extract-proxy.ankerek.workers.dev/extract/$HASH \
  -H "X-RC-User-Id: $RC_USER_ID" | jq .
```

Expected: `status: 'done'` with places, before you've opened the app.

- [ ] **Step 11.4: Commit**

```bash
git add native/ShareExtension/PrewarmRequest.swift native/ShareExtension/ShareViewController.swift
git commit -m "feat(ios): share extension pre-warms /extract via background URLSession"
```

---

## Task 12: AppDelegate `handleEventsForBackgroundURLSession` hook

**Goal:** iOS hands the background `URLSession` completion to the host app after the extension dies. Without this hook, iOS logs a complaint and the session leaks. We don't need the response — we only need to be a polite citizen.

**Files:**

- Modify: `ios/TripPocket/AppDelegate.swift` (Expo generates this; if not present, the file is `ios/TripPocket/AppDelegate.mm` — check both)

- [ ] **Step 12.1: Add a tiny `PrewarmSessionHolder` to keep the session alive**

iOS hands the background session events back to the host app by `identifier`. You must (a) recreate a session with that identifier AND a delegate, (b) keep the session retained until iOS finishes delivering events, then (c) call the stored completion handler when `didFinishEventsForBackgroundURLSession` fires. Dropping any of those three steps causes iOS to stop delivering background events to the host app.

Create `ios/TripPocket/PrewarmSessionHolder.swift`:

```swift
import Foundation

/// Strong-held URLSession + completion handler for the share-extension
/// prewarm session. Lifetime: from `handleEventsForBackgroundURLSession`
/// until iOS calls `didFinishEventsForBackgroundURLSession`. We don't care
/// about per-task callbacks — the share extension's HTTP body is fire-and-
/// forget — but iOS requires a delegate to deliver `didFinishEvents`.
final class PrewarmSessionHolder: NSObject, URLSessionDelegate {
  static let shared = PrewarmSessionHolder()

  private var session: URLSession?
  private var completionHandler: (() -> Void)?

  func attach(identifier: String, completion: @escaping () -> Void) {
    self.completionHandler = completion
    let cfg = URLSessionConfiguration.background(withIdentifier: identifier)
    cfg.sharedContainerIdentifier = "group.com.trippocket.shared"
    self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
  }

  // iOS calls this when all pending background tasks have finished delivering
  // events for this session. Invoke the stored handler so the OS knows we're
  // done; without it, background event delivery to this app may be throttled.
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async { [weak self] in
      let handler = self?.completionHandler
      self?.completionHandler = nil
      self?.session = nil
      handler?()
    }
  }
}
```

- [ ] **Step 12.2: Wire `AppDelegate` to the holder**

Add to `AppDelegate.swift`:

```swift
func application(
  _ application: UIApplication,
  handleEventsForBackgroundURLSession identifier: String,
  completionHandler: @escaping () -> Void
) {
  // Only the share-extension prewarm session is expected. If another
  // identifier ever appears, the same holder handles it (harmless: one
  // session per identifier; the holder retains the most recent).
  PrewarmSessionHolder.shared.attach(identifier: identifier, completion: completionHandler)
}
```

If the AppDelegate is `.mm` (ObjC++), the equivalent — note `PrewarmSessionHolder` is Swift, so you'll need the auto-generated `-Swift.h` import:

```objc
#import "TripPocket-Swift.h"

- (void)application:(UIApplication *)application
    handleEventsForBackgroundURLSession:(NSString *)identifier
                      completionHandler:(void (^)(void))completionHandler {
  [[PrewarmSessionHolder shared] attachWithIdentifier:identifier completion:completionHandler];
}
```

- [ ] **Step 12.3: Rebuild and verify no console warnings**

```bash
npx expo run:ios --device
```

Trigger another share, then re-launch the app. Xcode console should not show any "background URL session ... has no handler registered" warning, and a breakpoint in `urlSessionDidFinishEvents` should fire once the upload has completed.

- [ ] **Step 12.4: Commit**

```bash
git add ios/TripPocket/AppDelegate.swift
git commit -m "feat(ios): register background URLSession completion handler"
```

(If your AppDelegate is in a different path — verify with `ls ios/*/AppDelegate.*` — adjust the `git add` accordingly.)

---

## Task 13: Client lib `lib/extract/pollExtract.ts`

**Goal:** A small typed client for the new endpoint pair. The capture pipeline talks to this lib; the lib owns the worker URL + RC header + polling backoff.

**Files:**

- Create: `lib/extract/pollExtract.ts`
- Test: `lib/extract/__tests__/pollExtract.test.ts`

- [ ] **Step 13.1: Write the failing test**

```ts
import { pollExtract, type ExtractState } from '../pollExtract';

const HASH = 'a'.repeat(64);
const VALID_ID = '$RCAnonymousID:0123456789abcdef0123456789abcdef';

function makeFetch(responses: Response[]) {
  let i = 0;
  return jest.fn(async () => responses[Math.min(i++, responses.length - 1)]!) as unknown as typeof fetch;
}

function rjson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pollExtract', () => {
  it('returns done on the first poll if cache is hot', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'done', places: [], model: 'm' }, 200),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 3,
      delayMs: 1,
    });
    expect(result.status).toBe('done');
  });

  it('polls until done', async () => {
    globalThis.fetch = makeFetch([
      rjson({ contentHash: HASH, status: 'pending' }, 200),
      rjson({ contentHash: HASH, status: 'partial', caption: 'x' }, 200),
      rjson({ contentHash: HASH, status: 'done', places: [], model: 'm' }, 200),
    ]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 5,
      delayMs: 1,
    });
    expect(result.status).toBe('done');
  });

  it('returns missing on 404', async () => {
    globalThis.fetch = makeFetch([rjson({ contentHash: HASH, status: 'missing' }, 404)]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 1,
      delayMs: 1,
    });
    expect(result.status).toBe('missing');
  });

  it('returns timeout state when max attempts exhausted', async () => {
    globalThis.fetch = makeFetch([rjson({ contentHash: HASH, status: 'pending' }, 200)]);
    const result = await pollExtract({
      contentHash: HASH,
      rcUserId: VALID_ID,
      workerBase: 'https://w.test',
      maxAttempts: 2,
      delayMs: 1,
    });
    expect(result.status).toBe('timeout');
  });
});
```

- [ ] **Step 13.2: Run the test to see it fail**

```bash
npx jest --silent lib/extract/__tests__/pollExtract.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 13.3: Implement `pollExtract`**

```ts
export type ExtractedPlace = {
  name: string;
  city: string;
  address: string;
  category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';
  country_code: string;
};

export type ExtractState =
  | { status: 'pending'; contentHash: string }
  | { status: 'partial'; contentHash: string; caption?: string; coverUrl?: string; videoPresent?: boolean }
  | {
      status: 'done';
      contentHash: string;
      caption?: string;
      coverUrl?: string;
      videoPresent?: boolean;
      places: ExtractedPlace[];
      model: string;
    }
  | { status: 'error'; contentHash: string; error: string }
  | { status: 'missing'; contentHash: string }
  | { status: 'timeout'; contentHash: string };

export type PollExtractOptions = {
  contentHash: string;
  rcUserId: string;
  workerBase: string;
  maxAttempts: number;
  delayMs: number;
  /** When true and state is `missing`, send a POST to start the pipeline. */
  triggerOnMissing?: boolean;
  /** URL for the POST trigger; required if triggerOnMissing is true. */
  url?: string;
};

export async function pollExtract(opts: PollExtractOptions): Promise<ExtractState> {
  const url = `${opts.workerBase}/extract/${opts.contentHash}`;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-RC-User-Id': opts.rcUserId },
    });
    if (resp.status === 404) {
      if (opts.triggerOnMissing && opts.url) {
        await fetch(`${opts.workerBase}/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-RC-User-Id': opts.rcUserId },
          body: JSON.stringify({
            contentHash: opts.contentHash,
            kind: 'url',
            url: opts.url,
          }),
        });
        await sleep(opts.delayMs);
        continue;
      }
      return { status: 'missing', contentHash: opts.contentHash };
    }
    const body = (await resp.json()) as ExtractState;
    if (body.status === 'done' || body.status === 'error') return body;
    if (attempt < opts.maxAttempts - 1) await sleep(opts.delayMs);
  }
  return { status: 'timeout', contentHash: opts.contentHash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 13.4: Run tests**

```bash
npx jest --silent lib/extract/__tests__/pollExtract.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 13.5: Commit**

```bash
git add lib/extract/pollExtract.ts lib/extract/__tests__/pollExtract.test.ts
git commit -m "feat(client): pollExtract client for new /extract endpoint"
```

---

## Task 14: Wire the new `/extract` poll into `runForegroundIngest`

**Goal:** Replace the existing per-source sequence (url_fetch sweep → ocr sweep → extraction sweep) with a single `pollExtract`-based path for URL sources. Image sources stay on the existing path in v1.

**Files:**

- Modify: `modules/capture/runForegroundIngest.ts`
- Modify: `modules/capture/ingest.ts` (compute and pass `contentHash` per pending row)
- Modify: `modules/storage/sources.ts` (add helper to apply a `done` state in one transaction)

- [ ] **Step 14.1: Define the URL canonicalization spec and implement it in both languages**

The hash MUST be byte-for-byte identical between the share extension (Swift) and the app (TypeScript). Define the canonicalization once, lock it down with fixtures, implement it twice.

**Canonicalization algorithm** (apply in order):

1. Parse the URL.
2. Lowercase the scheme and host.
3. Strip `www.` from the host (`www.instagram.com` → `instagram.com`).
4. Strip the fragment (`#anchor`).
5. From the query string, drop any param whose key matches (case-insensitive): `igsh`, `igshid`, `fbclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `si`, `_t`.
6. Sort remaining query params alphabetically by key (case-sensitive on value).
7. Strip trailing `/` from the path (but not when the path is just `/`).
8. Re-serialize as `scheme://host/path[?sortedQuery]`.

Create `__fixtures__/canonical-urls.json` at repo root:

```json
[
  ["https://www.instagram.com/reel/ABC/?igsh=xyz", "https://instagram.com/reel/ABC?"],
  ["https://www.instagram.com/reel/ABC/", "https://instagram.com/reel/ABC?"],
  ["https://www.instagram.com/p/DEF/?utm_source=x&hl=en", "https://instagram.com/p/DEF?hl=en"],
  ["https://m.tiktok.com/@u/video/123?si=abc#top", "https://tiktok.com/@u/video/123?"],
  ["https://vm.tiktok.com/ZAbc/", "https://tiktok.com/zabc?"]
]
```

(Note: trailing `?` is fine — it's how an empty query renders. Pick one convention and stick to it; the test fixture is the source of truth.)

Create `lib/url/canonicalize.ts`:

```ts
const STRIP_KEYS = new Set([
  'igsh', 'igshid', 'fbclid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'si', '_t',
]);

export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  const scheme = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  // vm.tiktok.com / vt.tiktok.com short links: normalize to tiktok.com
  // (they share the same content_hash space).
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') host = 'tiktok.com';

  const kept: [string, string][] = [];
  u.searchParams.forEach((value, key) => {
    if (!STRIP_KEYS.has(key.toLowerCase())) kept.push([key, value]);
  });
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let path = u.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const query = kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${scheme}//${host}${path}?${query}`;
}

export async function contentHashForUrl(raw: string): Promise<string> {
  const canonical = canonicalizeUrl(raw);
  const data = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

Create `native/ShareExtension/Canonicalize.swift`:

```swift
import Foundation
import CommonCrypto

enum Canonicalize {
  private static let stripKeys: Set<String> = [
    "igsh", "igshid", "fbclid",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "si", "_t",
  ]

  static func canonicalize(_ raw: String) -> String? {
    guard var comps = URLComponents(string: raw) else { return nil }
    comps.scheme = comps.scheme?.lowercased()
    if var host = comps.host?.lowercased() {
      if host.hasPrefix("www.") { host.removeFirst("www.".count) }
      if host.hasPrefix("m.")   { host.removeFirst("m.".count)   }
      if host == "vm.tiktok.com" || host == "vt.tiktok.com" { host = "tiktok.com" }
      comps.host = host
    }
    comps.fragment = nil
    let kept = (comps.queryItems ?? [])
      .filter { !Self.stripKeys.contains($0.name.lowercased()) }
      .sorted { $0.name < $1.name }
    comps.queryItems = kept.isEmpty ? [] : kept

    var path = (comps.path).lowercased()
    if path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    comps.path = path

    // URLComponents drops the trailing "?" when queryItems is empty. Force it
    // so the output matches the TS implementation byte-for-byte.
    guard let scheme = comps.scheme, let host = comps.host else { return nil }
    let query = kept.map { item -> String in
      let v = (item.value ?? "")
        .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
      return "\(item.name)=\(v)"
    }.joined(separator: "&")
    return "\(scheme)://\(host)\(path)?\(query)"
  }

  static func contentHash(_ raw: String) -> String? {
    guard let canonical = canonicalize(raw), let data = canonical.data(using: .utf8) else {
      return nil
    }
    var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash) }
    return hash.map { String(format: "%02x", $0) }.joined()
  }
}
```

Write **identical** fixture tests for both:

`lib/url/__tests__/canonicalize.test.ts`:
```ts
import fixtures from '../../../__fixtures__/canonical-urls.json';
import { canonicalizeUrl } from '../canonicalize';

describe('canonicalizeUrl (fixture parity with Swift)', () => {
  for (const [input, expected] of fixtures as [string, string][]) {
    it(`${input} → ${expected}`, () => {
      expect(canonicalizeUrl(input)).toBe(expected);
    });
  }
});
```

`native/ShareExtensionTests/CanonicalizeTests.swift` (add to the share-extension test target; if no test target exists, add an ad-hoc XCTest in `ios/` and gate it on `#if DEBUG`):
```swift
import XCTest

final class CanonicalizeTests: XCTestCase {
  func testFixtures() throws {
    // Fixtures path is relative to repo root; the Xcode scheme exposes
    // SRCROOT via process info — fall back to a hard-coded path if needed.
    let path = ProcessInfo.processInfo.environment["SRCROOT"]
      ?? FileManager.default.currentDirectoryPath
    let url = URL(fileURLWithPath: path)
      .appendingPathComponent("__fixtures__/canonical-urls.json")
    let data = try Data(contentsOf: url)
    let fixtures = try JSONSerialization.jsonObject(with: data) as! [[String]]
    for pair in fixtures {
      let input = pair[0]
      let expected = pair[1]
      XCTAssertEqual(Canonicalize.canonicalize(input), expected,
                     "Mismatch for \(input)")
    }
  }
}
```

Replace `PrewarmRequest.swift`'s `sha256Hex(url)` (from Step 11.1) with `Canonicalize.contentHash(url)`. Replace `importUrl.ts`'s existing `content_hash` computation with `await contentHashForUrl(url)`.

- [ ] **Step 14.1.1: Run the fixture tests on both sides**

```bash
npx jest --silent lib/url/__tests__/canonicalize.test.ts
xcodebuild test -workspace ios/TripPocket.xcworkspace -scheme TripPocket -only-testing:ShareExtensionTests/CanonicalizeTests
```

Both must pass. If even one fixture diverges, the share-extension prewarm and the app's poll will look up different hashes and the user will see a re-extraction on every share.

- [ ] **Step 14.2: Add a single-transaction "apply done state" helper**

In `modules/storage/sources.ts`, add:

```ts
export type ApplyExtractDoneInput = {
  sourceId: string;
  caption: string | null;
  coverPath: string | null;
  placesToInsert: ExtractedPlaceInput[];
  model: string;
  ownerId: string;
  now: string;
};

export async function applyExtractDone(
  db: Database,
  input: ApplyExtractDoneInput,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Place insert/merge logic is identical to the existing extractor — call
    // the existing `resolvePlaceId` for each candidate, then linkPlaceSource.
    // To avoid a circular dep, the existing logic in `modules/extraction/extraction.ts`
    // has been refactored into a reusable function `applyExtractedPlaces`.
    await applyExtractedPlaces(db, input);
    await db.runAsync(
      `UPDATE sources
          SET extraction_status = 'done',
              caption = COALESCE(?, caption),
              file_path = COALESCE(?, file_path),
              ocr_status = 'done',
              updated_at = ?
        WHERE id = ?`,
      input.caption,
      input.coverPath,
      input.now,
      input.sourceId,
    );
  });
  notifyChange('sources');
  notifyChange('places');
  notifyChange('place_sources');
}
```

`applyExtractedPlaces` is extracted from `modules/extraction/extraction.ts:218-240` — the section that does `resolvePlaceId` + `linkPlaceSource` for each candidate. Pull it out into `modules/storage/places.ts` so both old and new code paths use it.

- [ ] **Step 14.3: Add a `pollExtractAndApply` step in `runForegroundIngest.ts`**

```ts
import { pollExtract } from '@/lib/extract/pollExtract';
import { applyExtractDone } from '@/modules/storage/sources';
import Constants from 'expo-constants';
import * as RNPurchases from 'react-native-purchases';

/** Poll budget per source. 30 × 2 s = 60 s, which comfortably covers a
 *  worst-case video extraction (Apify + Gemini Files API + dedup). The wait
 *  is non-blocking on the UI thread; the user's triage card just shows the
 *  partial state (caption + cover) until `done` arrives. */
const POLL_MAX_ATTEMPTS = 30;
const POLL_DELAY_MS = 2_000;
/** Cap concurrent polls so a 20-source backlog (rare but possible after a
 *  prolonged offline period) doesn't open 20 sockets. */
const POLL_CONCURRENCY = 3;

async function pollExtractForUrlSources(db: Database, ownerId: string): Promise<void> {
  // Pull every URL source that is still pending extraction. The new path
  // collapses the old url_fetch / ocr / extract sweeps for kind='url' into
  // one server poll per source.
  const rows = await db.getAllAsync<{ id: string; content_hash: string; url: string }>(
    `SELECT id, content_hash, url FROM sources
      WHERE kind = 'url'
        AND extraction_status = 'pending'
        AND content_hash IS NOT NULL
        AND url IS NOT NULL`,
  );
  if (rows.length === 0) return;

  const info = await RNPurchases.default.getCustomerInfo();
  const rcUserId = info.originalAppUserId;
  const workerBase = (Constants.expoConfig?.extra?.workerBase as string) ?? '';

  // Small concurrency-limited pool. Each `workOne` polls one source end-to-
  // end. The pool keeps POLL_CONCURRENCY workers in flight.
  let cursor = 0;
  async function workOne(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const row = rows[i]!;
      await pollAndApplyOne(row, rcUserId, workerBase, db, ownerId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(POLL_CONCURRENCY, rows.length) }, () => workOne()),
  );
}

async function pollAndApplyOne(
  row: { id: string; content_hash: string; url: string },
  rcUserId: string,
  workerBase: string,
  db: Database,
  ownerId: string,
): Promise<void> {
  const result = await pollExtract({
    contentHash: row.content_hash,
    rcUserId,
    workerBase,
    maxAttempts: POLL_MAX_ATTEMPTS,
    delayMs: POLL_DELAY_MS,
    triggerOnMissing: true,
    url: row.url,
  });
  if (result.status !== 'done') return;
  // Download the cover image to a permanent local path so the source detail
  // UI doesn't need to re-fetch from IG's expiring CDN.
  let coverPath: string | null = null;
  if (result.coverUrl) {
    try {
      coverPath = await downloadCoverImage(result.coverUrl);
    } catch (err) {
      console.warn('[poll-extract] cover download failed', row.id, err);
    }
  }
  await applyExtractDone(db, {
    sourceId: row.id,
    caption: result.caption ?? null,
    coverPath,
    placesToInsert: result.places,
    model: result.model,
    ownerId,
    now: new Date().toISOString(),
  });
}
```

- [ ] **Step 14.3.1: Cold-launch bootstrap for legacy in-flight rows**

After this code lands, any pre-existing source row with `extraction_status='pending'` AND `kind='url'` AND a NULL `content_hash` (rows that were created by older app builds and never made it through the old pipeline) becomes orphaned — the new orchestrator never sees them.

In `runForegroundIngest.ts`, before `pollExtractForUrlSources`, add a one-time bootstrap that backfills `content_hash` on pre-existing rows so they enter the new path:

```ts
async function bootstrapLegacyContentHashes(db: Database): Promise<void> {
  const rows = await db.getAllAsync<{ id: string; url: string }>(
    `SELECT id, url FROM sources
      WHERE kind = 'url'
        AND extraction_status = 'pending'
        AND content_hash IS NULL
        AND url IS NOT NULL`,
  );
  for (const row of rows) {
    try {
      const hash = await contentHashForUrl(row.url);
      await db.runAsync(
        `UPDATE sources SET content_hash = ?, updated_at = ? WHERE id = ?`,
        hash,
        new Date().toISOString(),
        row.id,
      );
    } catch (err) {
      console.warn('[bootstrap] failed to hash url', row.id, err);
    }
  }
}
```

Call it once, before `pollExtractForUrlSources`. It runs on every foreground but is a no-op after the first successful pass (no rows with NULL `content_hash` left).

Then in the existing `runForegroundIngest`, after `ingestPendingImports` drains the inbox:

```ts
// Replaces the old url_fetch / ocr / extract sweeps for kind='url' sources.
await pollExtractForUrlSources(db, ownerId);
// Image sources still use the legacy ocr + extract path in v1.
await processor.runOcrSweep();
await extractor.runExtractionSweep();
```

`downloadCoverImage` is the existing `ImageDownloader` from `modules/processing/processing.ts` — extract it into `modules/capture/downloadCoverImage.ts` if it isn't already a standalone helper, so both paths share it.

- [ ] **Step 14.4: Add `workerBase` to `expo-constants` extras**

In `app.config.ts`, add to the `extra` block:

```ts
extra: {
  // ... existing entries
  workerBase: 'https://trip-pocket-extract-proxy.ankerek.workers.dev',
}
```

(The existing `extractionProxyUrl`, `enrichmentProxyUrl`, `fetchPostProxyUrl` stay — `/enrich` is still hit by enrichment, and the latter two will be removed in Task 17.)

- [ ] **Step 14.5: Smoke-test on a device**

Run the app, share a Reel from Instagram, dismiss the share sheet, wait ~5 seconds, then open Trip Pocket. The source row should appear with places already populated, **without** the staged "fetching → ocr → extracting" delay you see today.

- [ ] **Step 14.6: Commit**

```bash
git add modules/capture/runForegroundIngest.ts modules/capture/ingest.ts modules/storage/sources.ts modules/storage/places.ts app.config.ts modules/capture/downloadCoverImage.ts
git commit -m "feat(capture): poll new /extract endpoint for URL sources"
```

---

## Task 15: UI rule — render places only when extraction AND enrichment are both done

**Goal:** Stop showing places while a source is mid-pipeline so the user never sees a place that later disappears. The disappearance you've been observing happens at **enrichment time** (Google Places dedup by `google_place_id` merges two extracted candidates into one), not at extraction time — so the gate needs both signals: `sources.extraction_status='done'` AND `places.enrichment_status IN ('done','not-found')`.

Trade-off: places appear ~500 ms–2 s later (parallelized Google Places calls) but never merge under the user. Worth it; this is the symptom you want to fix.

**Files:**

- Audit and modify: any place-listing UI that selects from the `places` table without joining on `sources.extraction_status`.

- [ ] **Step 15.1: Identify the queries that surface places**

```bash
grep -rn "FROM places" --include='*.ts' --include='*.tsx' .
```

Locate every query that returns place rows for UI rendering (triage screen, trip detail, etc.).

- [ ] **Step 15.2: Restrict each query to places where extraction is done AND enrichment has settled**

For each query, add the dual guard:

```sql
SELECT p.*
  FROM places p
  WHERE p.enrichment_status IN ('done', 'not-found')
    AND p.id IN (
      SELECT ps.place_id FROM place_sources ps
        JOIN sources s ON s.id = ps.source_id
       WHERE s.extraction_status = 'done'
    )
    AND <existing filters>;
```

A place flips to `enrichment_status='done'` once `/enrich` resolves its `google_place_id` (canonical key for dedup) OR to `'not-found'` once enrichment exhausts retries — both are terminal, so it's safe to render. The intermediate states (`'pending'`, `'paused'`) hide the place from the UI.

This is a small mechanical change per call site — the WHERE template is identical.

- [ ] **Step 15.3: Run the app and confirm the partial state never leaks**

Share a Reel; open the app immediately. The source card should appear (with caption + cover, from the `partial` state) but no places. ~5–20 s later (depending on cache hit / cold extraction), once polling lands `done` AND enrichment finishes for each place, the places appear all-at-once in their final deduped form. They should NEVER appear and then disappear.

- [ ] **Step 15.4: Commit**

```bash
git add <touched files>
git commit -m "fix(ui): hide places until extraction_status='done'"
```

---

## Task 16: Remove dead client code — old url_fetch + ocr + extract for URL sources

**Goal:** Now that the worker owns those stages for URL sources, the client paths are dead weight. Image sources stay on the old path in v1 — the OCR + extraction modules don't disappear entirely.

**Files:**

- Modify: `modules/processing/processing.ts` (drop URL handling; keep image OCR)
- Modify: `modules/extraction/extraction.ts` (drop URL-source dispatch; keep image strategies)
- Modify: `modules/capture/fetchPostFromProxy.ts` (no callers — delete the file)
- Delete: `modules/extraction/strategies/*` related to URL strategies (videoPlusCaption, captionPlusVision) — they're now server-side.

- [ ] **Step 16.1: Drop URL handling from the processor**

In `modules/processing/processing.ts`:

- Remove the `kind === 'url'` branches in `processOne`, `processUrlFetch`.
- Remove `enqueueUrlFetch`, `runUrlFetchSweep`, `resumeUrlFetchEntitlementPaused`, `processUrlFetch`.
- Remove `fetchPost`, `downloadImage`, `disposeFile` from `CreateProcessorOptions`.

The processor now only handles `kind='image'` OCR.

- [ ] **Step 16.2: Drop URL strategies from the extractor**

In `modules/extraction/extraction.ts`:

- Remove `videoPlusCaption` and `captionPlusVision` from the `extraction_strategy` enum the extractor knows about. Keep `ocrTextLLM` (for image-OCR text) and `vision` (for image source vision). The visual strategies that ran against IG cover images are gone.
- The proxy client `modules/extraction/proxy.ts` no longer needs the `mode: 'video'` and OG-fetch paths for URL sources. Trim it down to text+vision (image-source path only).

- [ ] **Step 16.3: Delete `modules/capture/fetchPostFromProxy.ts`**

```bash
git rm modules/capture/fetchPostFromProxy.ts
```

Verify no remaining imports:

```bash
grep -rn "fetchPostFromProxy" --include='*.ts' --include='*.tsx' .
```

- [ ] **Step 16.4: Strip `fetchPostProxyUrl` and `extractionProxyUrl` from `app.config.ts`**

`extractionProxyUrl` is still used by the image-source path — keep it. `fetchPostProxyUrl` was only used by `fetchPostFromProxy.ts` — remove it.

- [ ] **Step 16.5: Run all tests**

```bash
npm test --silent
npm test --silent --prefix workers/extract-proxy
```

Expected: all tests pass. Existing image-source tests should be unaffected; URL-source tests that targeted the removed code paths need to be updated/removed.

- [ ] **Step 16.6: Commit**

```bash
git add -A
git commit -m "refactor(client): worker owns url_fetch + extract for URL sources"
```

---

## Task 17: Verification + final smoke

- [ ] **Step 17.1: Cold-flow test**

1. Force-quit the app.
2. Share an IG Reel.
3. Wait 5–8 seconds (TestFlight-side delay; worker pipeline running).
4. Open the app.

Expected: triage shows the new source already in `done` with places visible. No "extracting…" delay.

- [ ] **Step 17.2: Offline-at-share-time test**

1. Force-quit the app, turn off wifi+cellular.
2. Share an IG Reel.
3. Re-enable network.
4. Open the app.

Expected: the share-time background `URLSession` eventually fires (iOS retries on its own), and the foreground poll picks up the result. If it doesn't fire in time, `pollExtract` with `triggerOnMissing: true` will POST a fresh trigger.

- [ ] **Step 17.3: Cache-hit test**

Share the same Reel twice from two different IG accounts (or just twice from the same one). The second share should `GET /extract/:hash` and find `done` immediately — no second Apify run, no second Gemini call.

Verify via `npx wrangler tail` — only one extraction round-trip should show.

- [ ] **Step 17.4: Final commit / push**

If everything is green:

```bash
git push origin <branch>
```

---

## Notes for the executing agent

- **Cache key is `content_hash`.** Don't introduce a second id namespace. The hash is computed from the **canonicalized** URL on both the share extension and the app side; if you change the canonicalization, change both at once.
- **Do not delete `runFetchPost` or the IG/TikTok fetcher code.** It's no longer a public route, but the orchestrator imports it directly.
- **`ctx.waitUntil` requires the Workers Paid plan** for >30s wall-clock. Trip Pocket is already on Paid (Apify + AI Gateway usage); no plan upgrade needed. Free-tier would cap at 30s and break video extractions.
- **Idempotency.** `orchestrate` checks KV at the top and bails if a state already exists. Two POSTs for the same hash within the TTL window produce one pipeline run; the second is a cheap KV read.
- **Error states are terminal.** A KV `error` state stays until TTL expires (72h). To force a retry sooner, delete the KV key manually via `wrangler kv:key delete --binding EXTRACT_STATE state:<hash>` or shorten the TTL in `orchestrator.ts`. The app's `pollExtract` does not auto-retry on `error` — that's a deliberate signal to the user (and to you in TestFlight).
- **v2 follow-up — screenshot pre-warm.** Add `/upload` (R2-backed) and extend the share extension to enqueue image-share kind. Tracked separately; not in this plan.
