import { orchestratorRequestSchema, orchestratorStateSchema } from '../src/orchestrator-schema';

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

  it('rejects when contentHash has uppercase hex chars (lowercase only)', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'A'.repeat(64),
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

  it('rejects when url is not parseable', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'a'.repeat(64),
      kind: 'url',
      url: 'not-a-url',
    });
    expect(r.success).toBe(false);
  });

  it('accepts an optional suggestedTripId pass-through', () => {
    const r = orchestratorRequestSchema.safeParse({
      contentHash: 'a'.repeat(64),
      kind: 'url',
      url: 'https://www.instagram.com/reel/abc/',
      suggestedTripId: 'trip_123',
    });
    expect(r.success).toBe(true);
  });
});

describe('orchestratorStateSchema', () => {
  it('parses a done state with places', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'done',
      caption: 'hi',
      coverUrl: 'https://cdn.example/a.jpg',
      places: [{ name: 'Tartine', city: 'SF', address: '', category: 'food', country_code: 'US' }],
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

  it('parses a partial state with caption + coverUrl', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'partial',
      caption: 'hi',
      coverUrl: 'https://cdn.example/a.jpg',
      videoPresent: true,
    });
    expect(r.success).toBe(true);
  });

  it('parses an error state with code', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'error',
      error: 'fetch-failed',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const r = orchestratorStateSchema.safeParse({
      contentHash: 'a'.repeat(64),
      status: 'unknown-status',
    });
    expect(r.success).toBe(false);
  });
});
