import {
  buildVideoPart,
  INLINE_TRANSPORT_CUTOFF_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_SEC,
  VideoError,
  bytesToBase64,
  type WaitUntilCtx,
} from '../src/video';

type ScriptStep = {
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response;
};

function scriptedFetch(script: ScriptStep[]) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const step of script) {
      if (step.match(url, init)) return step.response();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function makeCtx(): WaitUntilCtx & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
  };
}

const ENV = { GEMINI_API_KEY: 'test-key' };

describe('buildVideoPart — duration / config gates', () => {
  it('throws video-too-long when durationSec exceeds the ceiling', async () => {
    await expect(
      buildVideoPart(
        { url: 'https://cdn/r.mp4', durationSec: MAX_VIDEO_DURATION_SEC + 1 },
        ENV,
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: 'video-too-long' });
  });

  it('throws video-misconfigured when GEMINI_API_KEY is empty', async () => {
    await expect(
      buildVideoPart({ url: 'https://cdn/r.mp4' }, { GEMINI_API_KEY: '' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'video-misconfigured' });
  });
});

describe('buildVideoPart — fetch errors', () => {
  it('maps 4xx CDN responses to video-fetch-4xx', async () => {
    global.fetch = scriptedFetch([
      { match: () => true, response: () => new Response('', { status: 403 }) },
    ]);
    await expect(
      buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, makeCtx()),
    ).rejects.toMatchObject({ code: 'video-fetch-4xx' });
  });

  it('maps 5xx CDN responses to video-fetch-5xx', async () => {
    global.fetch = scriptedFetch([
      { match: () => true, response: () => new Response('', { status: 503 }) },
    ]);
    await expect(
      buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, makeCtx()),
    ).rejects.toMatchObject({ code: 'video-fetch-5xx' });
  });

  it('aborts and throws video-too-large when the streamed body exceeds the cap', async () => {
    // Stream a body larger than MAX_VIDEO_BYTES in 1 MB chunks. The reader
    // should cancel after the first chunk that pushes past the cap.
    const oneMb = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(oneMb);
      },
    });
    global.fetch = scriptedFetch([
      {
        match: () => true,
        response: () =>
          new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      },
    ]);
    await expect(
      buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, makeCtx()),
    ).rejects.toMatchObject({ code: 'video-too-large' });
  });
});

describe('buildVideoPart — inline transport', () => {
  it('returns an inline_data part for small bodies and does not schedule cleanup', async () => {
    const small = new Uint8Array(1024);
    small.fill(0xaa);
    global.fetch = scriptedFetch([
      {
        match: (url) => url.startsWith('https://cdn/'),
        response: () => new Response(small, { status: 200 }),
      },
    ]);
    const ctx = makeCtx();
    const out = await buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, ctx);
    expect(out.transport).toBe('inline');
    expect(out.bytes).toBe(1024);
    const inline = out.part as { inline_data?: { mime_type?: string; data?: string } };
    expect(inline.inline_data?.mime_type).toBe('video/mp4');
    expect(inline.inline_data?.data).toBe(bytesToBase64(small));
    expect(ctx.promises).toHaveLength(0);
  });
});

describe('buildVideoPart — Files API transport', () => {
  it('uploads, polls until ACTIVE, returns file_data, and schedules cleanup via ctx.waitUntil', async () => {
    // Construct a body ≥ INLINE_TRANSPORT_CUTOFF_BYTES to force the Files
    // API path. Real videos are far larger; a single allocation is enough
    // to trip the cutoff for the test.
    const big = new Uint8Array(INLINE_TRANSPORT_CUTOFF_BYTES);
    big.fill(0xff);

    const calls: { url: string; method?: string }[] = [];
    const fileName = 'files/abc123';
    const fileUri = 'https://files/abc123';

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      // 1. CDN fetch
      if (url.startsWith('https://cdn/')) {
        return new Response(big, { status: 200 });
      }
      // 2. Files API upload start
      if (url.includes('/upload/v1beta/files') && method === 'POST') {
        return new Response('', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload/session/A' },
        });
      }
      // 3. Files API upload finalize (returns PROCESSING)
      if (url.startsWith('https://upload/session/A') && method === 'POST') {
        return new Response(
          JSON.stringify({
            file: { name: fileName, uri: fileUri, mimeType: 'video/mp4', state: 'PROCESSING' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // 4. Status poll → ACTIVE
      if (url.includes(`/v1beta/${fileName}`) && method === 'GET') {
        return new Response(
          JSON.stringify({ name: fileName, uri: fileUri, mimeType: 'video/mp4', state: 'ACTIVE' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // 5. DELETE for cleanup
      if (url.includes(`/v1beta/${fileName}`) && method === 'DELETE') {
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const ctx = makeCtx();
    const out = await buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, ctx);
    expect(out.transport).toBe('files_api');
    expect(out.bytes).toBe(INLINE_TRANSPORT_CUTOFF_BYTES);
    const fd = out.part as { file_data?: { mime_type?: string; file_uri?: string } };
    expect(fd.file_data?.mime_type).toBe('video/mp4');
    expect(fd.file_data?.file_uri).toBe(fileUri);

    // Cleanup is scheduled via ctx.waitUntil — exercise it to confirm
    // it actually completes without throwing.
    expect(ctx.promises).toHaveLength(1);
    await Promise.all(ctx.promises);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('DELETE');
  });

  it('throws files-api-failed when the file state goes to FAILED', async () => {
    const big = new Uint8Array(INLINE_TRANSPORT_CUTOFF_BYTES);
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('https://cdn/')) return new Response(big, { status: 200 });
      if (url.includes('/upload/v1beta/files') && method === 'POST') {
        return new Response('', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload/session/B' },
        });
      }
      if (url.startsWith('https://upload/session/B')) {
        return new Response(
          JSON.stringify({
            file: { name: 'files/x', uri: 'https://u/x', mimeType: 'video/mp4', state: 'FAILED' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      buildVideoPart({ url: 'https://cdn/r.mp4' }, ENV, makeCtx()),
    ).rejects.toMatchObject({ code: 'files-api-failed' });
  });
});

describe('VideoError', () => {
  it('carries code + status', () => {
    const e = new VideoError('video-too-large', 413);
    expect(e.code).toBe('video-too-large');
    expect(e.status).toBe(413);
    expect(e.name).toBe('VideoError');
  });
});

describe('MAX_VIDEO_BYTES sanity', () => {
  it('is larger than the inline cutoff (otherwise no path would ever pick Files API)', () => {
    expect(MAX_VIDEO_BYTES).toBeGreaterThan(INLINE_TRANSPORT_CUTOFF_BYTES);
  });
});
