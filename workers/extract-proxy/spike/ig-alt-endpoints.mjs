#!/usr/bin/env node
// Test alternative IG endpoints since /embed/captioned moved to client-side rendering.
// Run: node workers/extract-proxy/spike/ig-alt-endpoints.mjs

const UAS = {
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  facebookBot:
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  twitterBot: 'Twitterbot/1.0',
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

const POST_ID = process.argv[2] || 'DP5p9sRjGoT';
const POST_URL = `https://www.instagram.com/p/${POST_ID}/`;
const EMBED_URL_PLAIN = `https://www.instagram.com/p/${POST_ID}/embed/`;
const EMBED_URL_CAPTIONED = `https://www.instagram.com/p/${POST_ID}/embed/captioned`;

function findOg(html, prop) {
  const re = new RegExp(
    `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`,
    'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function findShortcodeMediaIdx(html) {
  return html.indexOf('"shortcode_media"');
}

function quickProbe(url, ua) {
  return fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  }).then(async (res) => {
    const html = await res.text();
    return {
      status: res.status,
      finalUrl: res.url,
      bytes: html.length,
      og: {
        title: findOg(html, 'og:title'),
        description: findOg(html, 'og:description'),
        image: findOg(html, 'og:image'),
        type: findOg(html, 'og:type'),
      },
      hasShortcodeMedia: findShortcodeMediaIdx(html) !== -1,
      has__additionalDataLoaded: html.indexOf('__additionalDataLoaded') !== -1,
      hasJsonLd: html.indexOf('application/ld+json') !== -1,
    };
  }).catch((e) => ({ error: e.message }));
}

async function main() {
  console.log(`Testing post: ${POST_URL}\n`);

  const targets = [
    { label: 'POST URL (canonical)', url: POST_URL },
    { label: 'EMBED plain (/embed/)', url: EMBED_URL_PLAIN },
    { label: 'EMBED captioned', url: EMBED_URL_CAPTIONED },
  ];

  for (const t of targets) {
    console.log(`\n=== ${t.label} ===`);
    for (const [uaName, ua] of Object.entries(UAS)) {
      const r = await quickProbe(t.url, ua);
      if (r.error) {
        console.log(`  ${uaName.padEnd(14)} → ERR ${r.error}`);
        continue;
      }
      const ogSummary =
        (r.og.title ? 'T' : '-') +
        (r.og.description ? 'D' : '-') +
        (r.og.image ? 'I' : '-');
      console.log(
        `  ${uaName.padEnd(14)} → ${r.status} ${String(r.bytes).padStart(7)}b ` +
          `og:[${ogSummary}] sm=${r.hasShortcodeMedia ? '✓' : '-'} ` +
          `addl=${r.has__additionalDataLoaded ? '✓' : '-'} ` +
          `jsonld=${r.hasJsonLd ? '✓' : '-'}` +
          (r.finalUrl !== t.url ? ` (→${r.finalUrl.slice(0, 50)})` : '')
      );
      if (r.og.title || r.og.description) {
        if (r.og.title) console.log(`    title: ${r.og.title.slice(0, 100)}`);
        if (r.og.description)
          console.log(`    desc:  ${r.og.description.slice(0, 200)}`);
        if (r.og.image) console.log(`    image: ${r.og.image.slice(0, 100)}`);
      }
    }
  }
}

main();
