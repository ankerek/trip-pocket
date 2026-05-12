// Apify actor client. Fires for IG carousels (to recover slides 2..N that
// og:* meta tags can't see) and as a fallback when og:* parsing fails
// entirely. See docs/superpowers/specs/2026-05-12-apify-ig-scraping-design.md.
//
// We use the run-sync-get-dataset-items endpoint: one HTTP call, blocks until
// the actor finishes, returns the dataset items inline. The endpoint is
// purpose-built for "scrape one thing, give me the result" — no polling, no
// dataset bookkeeping.

export class ApifyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${code} (${status})`);
    this.name = 'ApifyError';
  }
}

export type ApifyInstagramPost = {
  caption: string;
  imageUrls: string[]; // [displayUrl, ...childPosts[].displayUrl]
  author: string | null;
  permalink: string;
};

type ApifyRawItem = {
  // Documented fields on apify/instagram-post-scraper output. We only read
  // what we use; the actor returns much more (likes, hashtags, etc.) but the
  // spec deliberately does not store any of it.
  url?: string;
  shortCode?: string;
  caption?: string | null;
  displayUrl?: string;
  ownerUsername?: string | null;
  childPosts?: Array<{ displayUrl?: string }>;
  type?: string; // 'Image' | 'Video' | 'Sidecar' — informational
};

// Worker subrequests have a hard ceiling well under Apify's 5-minute default.
// 30s leaves room for an actor cold-start without burning the worker invocation.
const APIFY_TIMEOUT_MS = 30000;

export type ApifyClientOptions = {
  token: string;
  /**
   * Actor identifier — either the slash-replaced username form
   * (`apify~instagram-post-scraper`) or the internal hex id. Both work
   * against Apify's REST API.
   */
  actorId: string;
};

/**
 * Fetch a single Instagram post via the configured Apify actor. The actor
 * takes a `directUrls` input array and writes one dataset item per URL.
 */
export async function fetchInstagramViaApify(
  canonicalUrl: string,
  opts: ApifyClientOptions,
): Promise<ApifyInstagramPost> {
  if (!opts.token) throw new ApifyError(500, 'apify-not-configured');
  if (!opts.actorId) throw new ApifyError(500, 'apify-not-configured');

  // run-sync-get-dataset-items: blocks until the actor finishes and returns
  // the dataset items as the response body. Avoids the run-then-poll dance.
  const endpoint =
    `https://api.apify.com/v2/acts/${encodeURIComponent(opts.actorId)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(opts.token)}` +
    `&clean=true&format=json&timeout=25`;

  const body = {
    directUrls: [canonicalUrl],
    resultsType: 'posts',
    resultsLimit: 1,
    // Skip the heavier extras — we don't store comments/likes.
    addParentData: false,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApifyError(504, 'apify-timeout');
    }
    throw new ApifyError(502, 'apify-network');
  } finally {
    clearTimeout(t);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ApifyError(500, 'apify-auth');
  }
  if (resp.status === 404) {
    // Actor or run not found — config error, not a missing post.
    throw new ApifyError(500, 'apify-actor-not-found');
  }
  if (resp.status === 429) throw new ApifyError(502, 'apify-rate-limited');
  if (!resp.ok) throw new ApifyError(502, 'apify-upstream');

  let items: unknown;
  try {
    items = await resp.json();
  } catch {
    throw new ApifyError(502, 'apify-non-json');
  }
  if (!Array.isArray(items) || items.length === 0) {
    // Actor ran but returned nothing — IG post likely private / deleted /
    // unreachable. Same UX as the worker's og: empty-response case.
    throw new ApifyError(502, 'apify-empty');
  }

  const raw = items[0] as ApifyRawItem;
  return mapApifyItem(raw, canonicalUrl);
}

export function mapApifyItem(
  raw: ApifyRawItem,
  fallbackPermalink: string,
): ApifyInstagramPost {
  const imageUrls: string[] = [];
  if (typeof raw.displayUrl === 'string' && raw.displayUrl.length > 0) {
    imageUrls.push(raw.displayUrl);
  }
  if (Array.isArray(raw.childPosts)) {
    for (const child of raw.childPosts) {
      if (
        child &&
        typeof child.displayUrl === 'string' &&
        child.displayUrl.length > 0
      ) {
        imageUrls.push(child.displayUrl);
      }
    }
  }
  return {
    caption: typeof raw.caption === 'string' ? raw.caption : '',
    imageUrls,
    author:
      typeof raw.ownerUsername === 'string' && raw.ownerUsername.length > 0
        ? `@${raw.ownerUsername}`
        : null,
    permalink:
      typeof raw.url === 'string' && raw.url.length > 0
        ? raw.url
        : fallbackPermalink,
  };
}
