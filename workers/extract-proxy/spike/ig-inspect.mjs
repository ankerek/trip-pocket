#!/usr/bin/env node
// Inspect what's actually in an IG /embed/captioned HTML response.
// Run: node workers/extract-proxy/spike/ig-inspect.mjs [url]

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const url = process.argv[2] || 'https://www.instagram.com/p/DP5p9sRjGoT/';
const m = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
if (!m) {
  console.error('bad url:', url);
  process.exit(1);
}
const embedUrl = `https://www.instagram.com/p/${m[2]}/embed/captioned`;
console.log(`Fetching ${embedUrl}\n`);

const res = await fetch(embedUrl, {
  headers: {
    'User-Agent': DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html',
  },
});
const html = await res.text();
console.log(`HTTP ${res.status} · ${html.length} bytes\n`);

// Dump useful markers
const markers = [
  '__additionalDataLoaded',
  'shortcode_media',
  'edge_media_to_caption',
  'edge_sidecar_to_children',
  'application/ld+json',
  'og:image',
  'og:description',
  'og:title',
  'display_url',
  'video_url',
  'is_video',
  '"caption"',
  'EmbedAsync',
  'EmbedSimpleContextV3',
  'PolarisEmbed',
  'CaptionComment',
  'CaptionMedia',
  'media_id',
  'twitter:image',
  'twitter:description',
  'window._sharedData',
  'window.__data',
  'instagram://media',
  'data-media-id',
  'data-instgrm-permalink',
];

console.log('Marker presence:');
for (const m of markers) {
  const idx = html.indexOf(m);
  console.log(`  ${m.padEnd(34)} ${idx === -1 ? '✗' : `✓ at ${idx}`}`);
}

// Pull all <meta> tags
console.log('\n<meta> tags:');
const metaRe = /<meta\s+[^>]+>/gi;
let mm;
while ((mm = metaRe.exec(html)) !== null) {
  console.log('  ', mm[0].slice(0, 200));
}

// Pull all <script src> + first 100 chars of inline scripts
console.log('\n<script> tags:');
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let i = 0;
while ((mm = scriptRe.exec(html)) !== null) {
  const attrs = mm[1].trim();
  const body = mm[2].trim();
  i++;
  if (i > 40) {
    console.log(`  … (${i}+ more)`);
    break;
  }
  if (attrs.includes('src=')) {
    const src = attrs.match(/src=["']([^"']+)["']/)?.[1] ?? '?';
    console.log(`  [${i}] src=${src.slice(0, 100)}`);
  } else {
    console.log(`  [${i}] inline (${body.length}b): ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
}

// Look for any URL that looks like a CDN image hosted at scontent / cdninstagram
console.log('\nCDN URLs found in HTML:');
const cdnRe = /https:\/\/[a-z0-9.-]*(?:cdninstagram|fbcdn)\.com[^\s"'<>]+/gi;
const found = new Set();
while ((mm = cdnRe.exec(html)) !== null) {
  found.add(mm[0]);
}
[...found].slice(0, 20).forEach((u) => console.log('  ', u.slice(0, 200)));
console.log(`  (${found.size} unique CDN URLs total)`);

// Dump first 4 KB of HTML for raw eyeball
console.log('\n--- First 4 KB of HTML ---');
console.log(html.slice(0, 4096));
console.log('\n--- Tail 2 KB of HTML ---');
console.log(html.slice(Math.max(0, html.length - 2048)));
