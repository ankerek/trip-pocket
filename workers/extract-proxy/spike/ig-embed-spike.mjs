#!/usr/bin/env node
// Phase 0 spike for the URL share extraction spec.
//
// Fetches https://www.instagram.com/p/<id>/embed/captioned for a list of IG
// post / reel / carousel URLs and reports what structured data is available.
//
// Run: node workers/extract-proxy/spike/ig-embed-spike.mjs [url ...]
// If no URLs are given, falls back to the hardcoded sample list below.

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const SAMPLE_URLS = [
  // Single-image feed post (Trip To Japan — user-supplied)
  'https://www.instagram.com/p/DSUuRC-EjTA/',
  // Carousel: 6 Mt Fuji spots (nataliaandkarolina — user-supplied)
  'https://www.instagram.com/p/DP5p9sRjGoT/',
];

function shortcodeFrom(url) {
  // Accept /p/<id>/, /reel/<id>/, /tv/<id>/
  const m = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? { kind: m[1], shortcode: m[2] } : null;
}

function findOg(html, prop) {
  const re = new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`,
    'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function findJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // skip non-parsable
    }
  }
  return out;
}

function findAdditionalData(html) {
  // Look for window.__additionalDataLoaded("extra", { ... })
  // or window.__additionalDataLoaded('extra', { ... })
  const re = /__additionalDataLoaded\(\s*['"][^'"]+['"]\s*,\s*(\{[\s\S]*?\})\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // skip
    }
  }
  return out;
}

function findInlineGraphQL(html) {
  // IG embeds sometimes embed media data inside other <script> tags as raw JSON
  // assignments like `window.__initialData={"data":{...,"shortcode_media":{...}}}`
  // or simply within the page as a JS object literal. Search for "shortcode_media"
  // as a strong signal that media JSON is reachable.
  const idx = html.indexOf('"shortcode_media"');
  if (idx === -1) return null;

  // Take a window around the match; we'll try to extract a balanced JSON object
  // starting at the nearest preceding `{`.
  const start = html.lastIndexOf('{', idx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  const blob = html.slice(start, end);
  try {
    return JSON.parse(blob);
  } catch {
    // Could be a JS literal with unquoted keys, etc. Return raw for inspection.
    return { __raw: blob.slice(0, 500) + (blob.length > 500 ? '…[truncated]' : '') };
  }
}

function extractFromAdditionalData(blobs) {
  for (const blob of blobs) {
    const media =
      blob?.shortcode_media ??
      blob?.media ??
      blob?.graphql?.shortcode_media ??
      null;
    if (!media) continue;
    const caption =
      media?.edge_media_to_caption?.edges?.[0]?.node?.text ??
      media?.caption ??
      null;
    const displayUrl = media?.display_url ?? null;
    const isCarousel =
      Array.isArray(media?.edge_sidecar_to_children?.edges) &&
      media.edge_sidecar_to_children.edges.length > 0;
    let slideUrls = null;
    if (isCarousel) {
      slideUrls = media.edge_sidecar_to_children.edges
        .map((e) => e?.node?.display_url)
        .filter(Boolean);
    } else if (displayUrl) {
      slideUrls = [displayUrl];
    }
    const owner = media?.owner?.username ?? null;
    return { caption, slideUrls, owner, source: '__additionalDataLoaded' };
  }
  return null;
}

function extractFromInlineGraphQL(blob) {
  if (!blob) return null;
  if (blob.__raw) return { source: 'inline-graphql-raw', preview: blob.__raw };
  const media =
    blob?.shortcode_media ??
    blob?.graphql?.shortcode_media ??
    blob?.data?.shortcode_media ??
    null;
  if (!media) return null;
  const caption =
    media?.edge_media_to_caption?.edges?.[0]?.node?.text ?? null;
  const displayUrl = media?.display_url ?? null;
  const isCarousel =
    Array.isArray(media?.edge_sidecar_to_children?.edges) &&
    media.edge_sidecar_to_children.edges.length > 0;
  let slideUrls = null;
  if (isCarousel) {
    slideUrls = media.edge_sidecar_to_children.edges
      .map((e) => e?.node?.display_url)
      .filter(Boolean);
  } else if (displayUrl) {
    slideUrls = [displayUrl];
  }
  return {
    caption,
    slideUrls,
    owner: media?.owner?.username ?? null,
    source: 'inline-graphql',
  };
}

async function probe(url) {
  const code = shortcodeFrom(url);
  if (!code) {
    return { url, ok: false, error: 'no-shortcode' };
  }
  const embedUrl = `https://www.instagram.com/p/${code.shortcode}/embed/captioned`;

  let res;
  try {
    res = await fetch(embedUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (e) {
    return { url, embedUrl, ok: false, error: `network: ${e.message}` };
  }

  const html = await res.text();
  const result = {
    url,
    embedUrl,
    status: res.status,
    contentType: res.headers.get('content-type'),
    bodyBytes: html.length,
    ok: res.ok,
  };

  result.og = {
    title: findOg(html, 'og:title'),
    description: findOg(html, 'og:description'),
    image: findOg(html, 'og:image'),
    type: findOg(html, 'og:type'),
    url: findOg(html, 'og:url'),
  };

  result.jsonLd = findJsonLd(html);
  result.additionalData = findAdditionalData(html);
  result.shortcodeMediaInline = findInlineGraphQL(html);

  result.parsedFromAdditional = extractFromAdditionalData(result.additionalData);
  result.parsedFromInline = extractFromInlineGraphQL(result.shortcodeMediaInline);

  // Look for telltale signs of a login wall / anti-bot response
  result.loginWallSignals = {
    hasLoginButton: /["']loginForm["']|loginButton|Log in to Instagram/.test(html),
    hasContinueAsGuest: /Continue as Guest/i.test(html),
    isErrorPage: /Page Not Found|This page isn['']t available/i.test(html),
  };

  return result;
}

function shortJSON(obj, max = 800) {
  const s = JSON.stringify(obj, null, 2);
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

function summary(r) {
  const lines = [];
  lines.push(`URL: ${r.url}`);
  lines.push(`  embed: ${r.embedUrl}`);
  lines.push(`  http: ${r.status} ${r.contentType} ${r.bodyBytes} bytes`);
  if (!r.ok) {
    lines.push(`  ✗ non-OK response`);
  }
  if (r.error) {
    lines.push(`  ✗ error: ${r.error}`);
    return lines.join('\n');
  }

  if (r.og) {
    lines.push(`  og:title       = ${r.og.title ? '✓ ' + r.og.title.slice(0, 70) : '✗ missing'}`);
    lines.push(`  og:description = ${r.og.description ? '✓ (' + r.og.description.length + ' chars)' : '✗ missing'}`);
    lines.push(`  og:image       = ${r.og.image ? '✓' : '✗ missing'}`);
    lines.push(`  og:type        = ${r.og.type || '✗ missing'}`);
  }

  lines.push(`  json-ld blobs:           ${r.jsonLd.length}`);
  lines.push(`  __additionalDataLoaded:  ${r.additionalData.length} blob(s)`);
  lines.push(`  shortcode_media inline:  ${r.shortcodeMediaInline ? 'found' : '✗'}`);

  const parsed = r.parsedFromAdditional || r.parsedFromInline;
  if (parsed) {
    lines.push(`  ✓ parsed via: ${parsed.source}`);
    lines.push(`    owner:       ${parsed.owner || '✗'}`);
    lines.push(
      `    caption:     ${
        parsed.caption ? '✓ (' + parsed.caption.length + ' chars) ' + parsed.caption.slice(0, 60).replace(/\n/g, ' ') + '…' : '✗ missing'
      }`
    );
    lines.push(
      `    slides:      ${
        parsed.slideUrls && parsed.slideUrls.length
          ? `✓ ${parsed.slideUrls.length} url(s)`
          : '✗ none'
      }`
    );
  } else {
    lines.push(`  ✗ no structured caption/slide data parsed`);
  }

  if (r.loginWallSignals.hasLoginButton || r.loginWallSignals.isErrorPage) {
    lines.push(
      `  ⚠ login-wall signals: ${JSON.stringify(r.loginWallSignals)}`
    );
  }

  return lines.join('\n');
}

async function main() {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLE_URLS;
  console.log(`Spiking ${urls.length} URL(s). User-Agent: ${DESKTOP_UA.slice(0, 60)}…\n`);

  const results = [];
  for (const url of urls) {
    process.stderr.write(`→ ${url}\n`);
    const r = await probe(url);
    results.push(r);
    console.log(summary(r));
    console.log('');
  }

  // Compact summary across all URLs
  console.log('═══ Summary ═══');
  for (const r of results) {
    const parsed = r.parsedFromAdditional || r.parsedFromInline;
    const slides = parsed?.slideUrls?.length ?? 0;
    const captionLen = parsed?.caption?.length ?? 0;
    const verdict =
      !r.ok ? '✗ NON-OK'
      : !parsed ? '✗ NO DATA'
      : slides === 0 ? '⚠ no slides'
      : captionLen === 0 ? '⚠ no caption'
      : '✓ ok';
    console.log(
      `  ${verdict.padEnd(12)} ${slides}slide(s)  ${captionLen}cap  ${r.url}`
    );
  }

  // Dump raw findings to ./spike-output.json for inspection
  const outPath = new URL('./spike-output.json', import.meta.url);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull dump → ${outPath.pathname}`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
