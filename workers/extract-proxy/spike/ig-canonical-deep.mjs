#!/usr/bin/env node
// Deep probe: fetch canonical post URL with Safari UA and decode HTML entities
// so we can see the actual caption length and content. Also look for any JSON
// blob that exposes carousel slide URLs.
//
// Run: node workers/extract-proxy/spike/ig-canonical-deep.mjs [post-id]

import { writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'DP5p9sRjGoT', // user-supplied carousel (6 Mt Fuji spots)
      'DSUuRC-EjTA', // user-supplied single (Trip To Japan)
    ];

function findOg(html, prop) {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function decodeEntities(s) {
  if (!s) return s;
  // Numeric (decimal and hex) HTML entities
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function findAllCdnImages(html) {
  // Image-shaped CDN URLs (.jpg, .webp, .png) on scontent / cdninstagram
  const re =
    /https:\/\/[a-z0-9.-]*(?:cdninstagram|fbcdn)\.com\/[^"'\s<>]+?\.(?:jpg|jpeg|webp|png)(?:\?[^"'\s<>]*)?/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    found.add(m[0]);
  }
  return [...found];
}

function findShortcodeMediaBlob(html) {
  const idx = html.indexOf('"shortcode_media"');
  if (idx === -1) return null;
  const start = html.lastIndexOf('{', idx);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
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
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
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
  return html.slice(start, end);
}

function lookForVariousBlobs(html) {
  const markers = [
    'edge_sidecar_to_children',
    'PolarisPostRootImpl',
    'XDTGraphSidecarImage',
    'XDTMediaDict',
    'GraphImage',
    'GraphSidecar',
    'GraphVideo',
    '"display_resources"',
    '"display_url"',
    '"is_video"',
    '"video_url"',
    '__bbox',
    'require:[["ScheduledServerJS"',
    'ServerJS',
    'media_overlay_info',
  ];
  return markers.map((m) => ({ marker: m, idx: html.indexOf(m) }));
}

async function probe(id) {
  const url = `https://www.instagram.com/p/${id}/`;
  console.log(`\n══ ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  const html = await res.text();
  console.log(`  HTTP ${res.status} · ${html.length} bytes`);

  const ogTitleRaw = findOg(html, 'og:title');
  const ogDescRaw = findOg(html, 'og:description');
  const ogImageRaw = findOg(html, 'og:image');
  const ogType = findOg(html, 'og:type');

  const ogTitle = decodeEntities(ogTitleRaw);
  const ogDesc = decodeEntities(ogDescRaw);
  const ogImage = decodeEntities(ogImageRaw);

  console.log(`\n  og:type        = ${ogType}`);
  console.log(
    `  og:title       = (${ogTitleRaw?.length ?? 0} raw chars) ${ogTitle?.slice(0, 200)}`,
  );
  console.log(`  og:description = (${ogDescRaw?.length ?? 0} raw chars)`);
  if (ogDesc) {
    console.log(`     ┌─ full decoded ─`);
    ogDesc.split('\n').forEach((l) => console.log(`     │ ${l}`));
    console.log(`     └─ (${ogDesc.length} decoded chars)`);
  }
  console.log(`  og:image       = ${ogImage}`);

  console.log(`\n  Marker presence (looking for carousel/slide data):`);
  for (const { marker, idx } of lookForVariousBlobs(html)) {
    console.log(`    ${marker.padEnd(36)} ${idx === -1 ? '✗' : `✓ at ${idx}`}`);
  }

  const shortcodeBlob = findShortcodeMediaBlob(html);
  if (shortcodeBlob) {
    console.log(`\n  shortcode_media blob: ${shortcodeBlob.length} chars`);
    try {
      const parsed = JSON.parse(shortcodeBlob);
      console.log(`    PARSED ok, top keys: ${Object.keys(parsed).join(', ')}`);
    } catch (e) {
      console.log(`    parse failed: ${e.message}`);
      console.log(`    first 300 chars: ${shortcodeBlob.slice(0, 300)}`);
    }
  } else {
    console.log(`\n  shortcode_media blob: not found`);
  }

  const cdnImages = findAllCdnImages(html);
  console.log(`\n  CDN image URLs: ${cdnImages.length} unique`);
  cdnImages.slice(0, 20).forEach((u, i) => console.log(`    [${i}] ${u.slice(0, 160)}`));

  // Dump HTML for offline inspection
  const outPath = new URL(`./dump-${id}.html`, import.meta.url);
  await writeFile(outPath, html);
  console.log(`\n  HTML dumped → ${outPath.pathname}`);
}

for (const id of TARGETS) {
  await probe(id);
}
