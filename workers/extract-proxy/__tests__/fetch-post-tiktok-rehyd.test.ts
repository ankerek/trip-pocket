import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractTikTokRehydrationJson,
  mapTikTokRehydrationItem,
} from '../src/fetch-post';

const fixtures = join(__dirname, 'fixtures', 'tiktok');
const photoHtml = readFileSync(join(fixtures, 'photo-6slides.html'), 'utf8');
const stubHtml = readFileSync(join(fixtures, 'antibot-stub.html'), 'utf8');

// Helpers to build minimal rehydration payloads inline. Mirror the real
// __DEFAULT_SCOPE__.webapp.reflow.video.detail.itemInfo.itemStruct shape.
function buildRehyd(item: unknown) {
  return {
    __DEFAULT_SCOPE__: {
      'webapp.reflow.video.detail': {
        itemInfo: { itemStruct: item },
      },
    },
  };
}

describe('extractTikTokRehydrationJson', () => {
  it('parses the rehydration JSON from a real photo capture', () => {
    const data = extractTikTokRehydrationJson(photoHtml) as Record<string, unknown>;
    expect(data).toHaveProperty('__DEFAULT_SCOPE__');
  });

  it('throws tiktok-no-rehydration on an anti-bot stub HTML', () => {
    expect(() => extractTikTokRehydrationJson(stubHtml)).toThrow(
      /tiktok-no-rehydration/,
    );
  });

  it('throws tiktok-rehyd-non-json when the script body is not valid JSON', () => {
    const bad =
      '<!doctype html><html><body>' +
      '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">' +
      '{not json}' +
      '</script></body></html>';
    expect(() => extractTikTokRehydrationJson(bad)).toThrow(
      /tiktok-rehyd-non-json/,
    );
  });
});

describe('mapTikTokRehydrationItem', () => {
  const canonical = 'https://www.tiktok.com/@x/photo/123';

  it('extracts all slides for a photo post and tags route="photo"', () => {
    const data = extractTikTokRehydrationJson(photoHtml);
    const out = mapTikTokRehydrationItem(data, canonical);
    expect(out._route).toBe('photo');
    expect(out.platform).toBe('tiktok');
    expect(out.permalink).toBe(canonical);
    expect(out.imageUrls.length).toBe(6);
    expect(out.imageUrls.every((u) => u.startsWith('https://'))).toBe(true);
    expect(out.author).toBe('@photoshoot.dating');
    expect(out.caption).toBe('#founderstory #datingapps');
  });

  it('returns video cover when imagePost is absent', () => {
    const raw = buildRehyd({
      desc: 'caption text',
      author: { uniqueId: 'creator', nickname: 'Creator' },
      video: { cover: 'https://cdn/cover.jpg' },
    });
    const out = mapTikTokRehydrationItem(raw, canonical);
    expect(out._route).toBe('video');
    expect(out.imageUrls).toEqual(['https://cdn/cover.jpg']);
    expect(out.caption).toBe('caption text');
    expect(out.author).toBe('@creator');
  });

  it('returns empty imageUrls when imagePost is present but every urlList[0] is empty', () => {
    const raw = buildRehyd({
      desc: 'x',
      author: { uniqueId: 'u' },
      imagePost: {
        images: [
          { imageURL: { urlList: ['', ''] } },
          { imageURL: { urlList: [''] } },
        ],
      },
    });
    const out = mapTikTokRehydrationItem(raw, canonical);
    expect(out._route).toBe('photo');
    expect(out.imageUrls).toEqual([]);
    expect(out.caption).toBe('x');
    expect(out.author).toBe('@u');
  });

  it('returns empty imageUrls when neither imagePost nor video.cover exists', () => {
    const raw = buildRehyd({
      desc: 'x',
      author: { uniqueId: 'u' },
    });
    const out = mapTikTokRehydrationItem(raw, canonical);
    expect(out._route).toBe('video');
    expect(out.imageUrls).toEqual([]);
  });

  it('returns author=null when uniqueId is missing or empty', () => {
    const rawNone = buildRehyd({
      desc: 'x',
      video: { cover: 'https://cdn/c.jpg' },
    });
    expect(mapTikTokRehydrationItem(rawNone, canonical).author).toBeNull();

    const rawEmpty = buildRehyd({
      desc: 'x',
      author: { uniqueId: '' },
      video: { cover: 'https://cdn/c.jpg' },
    });
    expect(mapTikTokRehydrationItem(rawEmpty, canonical).author).toBeNull();
  });

  it('returns caption="" when desc is missing', () => {
    const raw = buildRehyd({
      author: { uniqueId: 'u' },
      video: { cover: 'https://cdn/c.jpg' },
    });
    expect(mapTikTokRehydrationItem(raw, canonical).caption).toBe('');
  });

  it('throws tiktok-rehyd-no-item when the reflow scope has no itemInfo', () => {
    const raw = {
      __DEFAULT_SCOPE__: {
        'webapp.reflow.video.detail': {
          statusCode: 10204,
          statusMessage: 'item doesn\'t exist',
        },
      },
    };
    expect(() => mapTikTokRehydrationItem(raw, canonical)).toThrow(
      /tiktok-rehyd-no-item/,
    );
  });

  it('skips slides with empty urlList[0] while keeping others', () => {
    const raw = buildRehyd({
      desc: 'mix',
      author: { uniqueId: 'u' },
      imagePost: {
        images: [
          { imageURL: { urlList: ['https://cdn/a.jpg'] } },
          { imageURL: { urlList: [''] } },
          { imageURL: { urlList: ['https://cdn/c.jpg'] } },
        ],
      },
    });
    const out = mapTikTokRehydrationItem(raw, canonical);
    expect(out.imageUrls).toEqual(['https://cdn/a.jpg', 'https://cdn/c.jpg']);
  });
});
