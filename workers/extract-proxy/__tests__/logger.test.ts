import { logEvent, logStageError } from '../src/logger';

// Sentry is loaded as @sentry/cloudflare from node_modules and never
// initialized in tests, so captureException is a safe no-op. We assert
// on console output to verify the structured JSON shape.

describe('logger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits stage_done as a JSON line on console.log with required fields', () => {
    logEvent({
      event: 'stage_done',
      stage: 'fetch-post',
      contentHash: 'abc123',
      source: 'instagram',
      duration_ms: 42,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      event: 'stage_done',
      stage: 'fetch-post',
      contentHash: 'abc123',
      source: 'instagram',
      duration_ms: 42,
    });
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });

  it('routes stage_warn through console.warn, not console.log', () => {
    logEvent({
      event: 'stage_warn',
      stage: 'extract',
      mode: 'video',
      contentHash: 'h',
      error_code: 'video-fetch-403',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(parsed.event).toBe('stage_warn');
    expect(parsed.mode).toBe('video');
    expect(parsed.error_code).toBe('video-fetch-403');
  });

  it('logStageError emits stage_error on console.error with error_code derived from the thrown value', () => {
    logStageError(new Error('upstream-rate-limited'), {
      stage: 'extract',
      mode: 'video',
      contentHash: 'h',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({
      event: 'stage_error',
      stage: 'extract',
      mode: 'video',
      contentHash: 'h',
      error_code: 'upstream-rate-limited',
    });
  });

  it('logStageError prefers an explicit error_code over the thrown message', () => {
    logStageError(new Error('thrown-message-ignored'), {
      stage: 'fetch-post',
      contentHash: 'h',
      error_code: 'apify-timeout',
    });
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.error_code).toBe('apify-timeout');
  });

  it('logStageError tolerates non-Error throwables (string/number)', () => {
    // Some upstream layers throw primitives. The logger must not break the
    // pipeline just because the thrown value lacked a .message.
    expect(() => logStageError('boom', { stage: 'enrich', contentHash: 'h' })).not.toThrow();
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.event).toBe('stage_error');
    expect(parsed.error_code).toBe('boom');
  });
});
