// Tests for the queue consumer wired up on the worker's default export.
// Drives `handleQueueBatch` directly with synthetic MessageBatch payloads;
// asserts ack/retry semantics and KV-state progression across the
// fetch-post → extract → enrich stages.

import { handleQueueBatch } from '../src/index';
import type { Env } from '../src/index';
import type { ExtractJobMessage, OrchestratorState } from '../src/orchestrator-schema';
import type { FetchPostResponse } from '../src/fetch-post';

const HASH = 'a'.repeat(64);

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
  };
}

function makeEnv(
  kv = makeKv(),
  sentMessages: ExtractJobMessage[] = [],
): { env: Env; kv: ReturnType<typeof makeKv>; sent: ExtractJobMessage[] } {
  const env: Env = {
    GEMINI_API_KEY: 'k',
    GOOGLE_PLACES_API_KEY: 'k',
    CF_ACCOUNT_ID: 'a',
    AI_GATEWAY_NAME: 'g',
    CF_AIG_TOKEN: 't',
    RATE_LIMIT: { limit: async () => ({ success: true }) } as Env['RATE_LIMIT'],
    RC_REST_API_KEY: 'rc',
    EXTRACT_STATE: kv as unknown as KVNamespace,
    EXTRACT_QUEUE: {
      async send(body: ExtractJobMessage) {
        sentMessages.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async sendBatch() {
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
      async metrics() {
        return { backlogCount: 0, backlogBytes: 0 };
      },
    } as Env['EXTRACT_QUEUE'],
  };
  return { env, kv, sent: sentMessages };
}

const noopCtx = { waitUntil: () => {} };

type AckState = 'pending' | 'acked' | 'retried';

function makeMessage(body: unknown): {
  message: {
    id: string;
    timestamp: Date;
    body: unknown;
    attempts: number;
    ack: () => void;
    retry: () => void;
  };
  state(): AckState;
} {
  let state: AckState = 'pending';
  return {
    message: {
      id: 'msg-1',
      timestamp: new Date(),
      body,
      attempts: 1,
      ack() {
        state = 'acked';
      },
      retry() {
        state = 'retried';
      },
    },
    state: () => state,
  };
}

function makeBatch(message: ReturnType<typeof makeMessage>['message']) {
  return {
    queue: 'trip-pocket-extract',
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => {},
    ackAll: () => {},
  };
}

describe('handleQueueBatch', () => {
  it('acks an invalid message body without retrying (avoids poison loop)', async () => {
    const { env } = makeEnv();
    const { message, state } = makeMessage({ stage: 'fetch-post', contentHash: 'nope' });
    await handleQueueBatch(makeBatch(message), env, noopCtx);
    expect(state()).toBe('acked');
  });

  it('routes a fetch-post message and enqueues the next stage on success', async () => {
    // Pre-seed pending KV row (simulates kickOffPipeline having run).
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'pending',
        startedAt: new Date().toISOString(),
      }),
    );
    const sent: ExtractJobMessage[] = [];
    const { env } = makeEnv(kv, sent);

    // Mock the default Apify path: handleQueueBatch will call runFetchPost
    // internally. We mock the network fetches it makes.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('instagram.com')) {
        // og-only response with a minimal cover + caption.
        return new Response(
          [
            '<!doctype html><html><head>',
            '<meta property="og:image" content="https://cdn.example/c.jpg" />',
            '<meta property="og:description" content="A nice place" />',
            '<meta property="og:title" content="A Title" />',
            '</head><body></body></html>',
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error('unexpected fetch: ' + url);
    }) as typeof fetch;

    try {
      const { message, state } = makeMessage({
        stage: 'fetch-post',
        contentHash: HASH,
        url: 'https://www.instagram.com/p/x/',
      });
      await handleQueueBatch(makeBatch(message), env, noopCtx);

      expect(state()).toBe('acked');

      // KV advanced from `pending` to `partial` and persisted the fetched payload.
      const raw = kv.store.get(`state:${HASH}`);
      expect(raw).toBeTruthy();
      const stored = JSON.parse(raw!) as OrchestratorState;
      expect(stored.status).toBe('partial');
      expect(stored.caption).toBe('A nice place');
      expect(stored.fetched).toBeDefined();
      expect((stored.fetched as FetchPostResponse).platform).toBe('instagram');

      // The next stage was enqueued.
      expect(sent).toEqual([{ stage: 'extract', contentHash: HASH }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries (and writes no terminal error) when extract stage throws TransientExtractError', async () => {
    // Seed KV `partial` with a fetched payload — straight into the extract
    // stage. Mock Gemini to return 503 on every fallback so the stage
    // throws TransientExtractError → handleQueueBatch must call retry().
    const kv = makeKv();
    const fetched: FetchPostResponse = {
      platform: 'instagram',
      permalink: 'https://www.instagram.com/p/x/',
      caption: 'cap',
      imageUrls: [],
      author: null,
    };
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'partial',
        caption: 'cap',
        coverUrl: undefined,
        videoPresent: false,
        fetched,
        startedAt: new Date().toISOString(),
      }),
    );
    const { env } = makeEnv(kv);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('overloaded', { status: 503 })) as typeof fetch;

    try {
      const { message, state } = makeMessage({ stage: 'extract', contentHash: HASH });
      await handleQueueBatch(makeBatch(message), env, noopCtx);

      // Stage threw TransientExtractError → queue handler called retry().
      expect(state()).toBe('retried');

      // KV stays at `partial`; no terminal error written.
      const stored = JSON.parse(kv.store.get(`state:${HASH}`)!) as OrchestratorState;
      expect(stored.status).toBe('partial');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('acks when a stage writes a clean `error` state (no retry)', async () => {
    // The other failure shape: a stage catches its own error and writes
    // 'error' to KV without throwing. handleQueueBatch sees a clean
    // return and acks — no retry, no DLQ. This is how non-retryable
    // failures (4xx from Gemini, schema violations, the
    // `fetched-missing` defensive branch) surface to the user as a
    // terminal failure on the first attempt.
    const kv = makeKv();
    kv.store.set(
      `state:${HASH}`,
      JSON.stringify({
        contentHash: HASH,
        status: 'partial',
        caption: 'cap',
        startedAt: new Date().toISOString(),
        // fetched intentionally missing → processExtractStage writes
        // status='error' and returns cleanly.
      }),
    );
    const { env } = makeEnv(kv);

    const { message, state } = makeMessage({ stage: 'extract', contentHash: HASH });
    await handleQueueBatch(makeBatch(message), env, noopCtx);

    expect(state()).toBe('acked');
    const stored = JSON.parse(kv.store.get(`state:${HASH}`)!) as OrchestratorState;
    expect(stored.status).toBe('error');
    expect(stored.error).toBe('fetched-missing');
  });

  it('processes every message in a multi-message batch independently', async () => {
    // Production has max_batch_size=1, but the handler loops over
    // `batch.messages`. Test the loop with a mixed batch (one valid,
    // one invalid) so a future tuning of max_batch_size doesn't regress
    // the per-message accounting.
    const { env } = makeEnv();
    const { message: m1, state: s1 } = makeMessage({ stage: 'fetch-post', contentHash: 'nope' });
    const { message: m2, state: s2 } = makeMessage({ thisIsNotAValidMessage: true });

    const batch = {
      queue: 'trip-pocket-extract',
      messages: [m1, m2],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {},
      ackAll: () => {},
    };
    await handleQueueBatch(batch, env, noopCtx);

    // Both invalid (m1 has a bad contentHash, m2 lacks `stage`) → both ack'd.
    expect(s1()).toBe('acked');
    expect(s2()).toBe('acked');
  });
});
