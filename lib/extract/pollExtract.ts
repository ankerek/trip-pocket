// Client for the worker's POST /extract + GET /extract/:contentHash. Driven
// by runForegroundIngest on every foreground for URL sources that haven't
// reached extraction_status='done'. On a cache hit (the share-extension
// pre-warm finished while the user was tapping back), the first GET returns
// status='done' immediately; on cold-open or when the prewarm never fired
// (offline-at-share, missing RC id), `triggerOnMissing` POSTs to kick off
// the pipeline and the loop polls until done or timeout.

export type ExtractedPlace = {
  name: string;
  city: string;
  address: string;
  category: 'food' | 'drinks' | 'stays' | 'sights' | 'activities' | 'shops';
  country_code: string;
};

export type ExtractState =
  | { status: 'pending'; contentHash?: string }
  | {
      status: 'partial';
      contentHash?: string;
      caption?: string;
      coverUrl?: string;
      videoPresent?: boolean;
    }
  | {
      status: 'done';
      contentHash?: string;
      caption?: string;
      coverUrl?: string;
      videoPresent?: boolean;
      places: ExtractedPlace[];
      model: string;
    }
  | { status: 'error'; contentHash?: string; error?: string }
  | { status: 'missing'; contentHash?: string }
  | { status: 'timeout'; contentHash?: string };

export type PollExtractOptions = {
  contentHash: string;
  rcUserId: string;
  workerBase: string;
  maxAttempts: number;
  delayMs: number;
  /** When true and GET returns 404, POST /extract once and re-poll. */
  triggerOnMissing?: boolean;
  /** Required when triggerOnMissing is true. */
  url?: string;
};

export async function pollExtract(opts: PollExtractOptions): Promise<ExtractState> {
  const getUrl = `${opts.workerBase}/extract/${opts.contentHash}`;
  let triggered = false;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const resp = await fetch(getUrl, {
      method: 'GET',
      headers: { 'X-RC-User-Id': opts.rcUserId },
    });

    if (resp.status === 404) {
      if (opts.triggerOnMissing && opts.url && !triggered) {
        triggered = true;
        await fetch(`${opts.workerBase}/extract`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-RC-User-Id': opts.rcUserId,
          },
          body: JSON.stringify({
            contentHash: opts.contentHash,
            kind: 'url',
            url: opts.url,
          }),
        });
        if (attempt < opts.maxAttempts - 1) await sleep(opts.delayMs);
        continue;
      }
      return { status: 'missing', contentHash: opts.contentHash };
    }

    let body: ExtractState;
    try {
      body = (await resp.json()) as ExtractState;
    } catch {
      return { status: 'error', contentHash: opts.contentHash, error: 'non-json-response' };
    }

    if (body.status === 'done') return body;
    if (body.status === 'error') return body;
    if (body.status === 'pending' || body.status === 'partial') {
      if (attempt < opts.maxAttempts - 1) await sleep(opts.delayMs);
      continue;
    }
    // Schema drift safety: any unexpected status string ends the poll
    // rather than looping forever.
    return { status: 'error', contentHash: opts.contentHash, error: 'unknown-status' };
  }
  return { status: 'timeout', contentHash: opts.contentHash };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
