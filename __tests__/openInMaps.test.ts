import {
  buildMapUrl,
  _resetDetectionForTests,
  _setDetectionForTests,
} from '@/lib/openInMaps';

describe('buildMapUrl', () => {
  beforeEach(() => {
    _resetDetectionForTests();
  });

  describe('apple-only (Google Maps not installed)', () => {
    beforeEach(() => _setDetectionForTests('apple-only'));

    it('builds a pinned URL with ll and q when coords are present', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        latitude: 35.6076,
        longitude: 139.668,
      });
      expect(url).toMatch(/^https:\/\/maps\.apple\.com\/\?/);
      expect(url).toContain('ll=35.6076%2C139.668');
      expect(url).toContain('q=Kosoan');
    });

    it('falls back to a search URL with name + address when no coords', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        city: 'Tokyo',
        address: '1 Chome-24-23 Jiyugaoka, Meguro City, Tokyo',
      });
      expect(url).toBe(
        'https://maps.apple.com/?q=Kosoan%2C%201%20Chome-24-23%20Jiyugaoka%2C%20Meguro%20City%2C%20Tokyo',
      );
    });

    it('falls back to city when no address', () => {
      const url = buildMapUrl({ name: 'Kosoan', city: 'Tokyo' });
      expect(url).toBe('https://maps.apple.com/?q=Kosoan%2C%20Tokyo');
    });

    it('uses just the name when no city or address', () => {
      const url = buildMapUrl({ name: 'Kosoan' });
      expect(url).toBe('https://maps.apple.com/?q=Kosoan');
    });

    it('treats whitespace-only address as empty', () => {
      const url = buildMapUrl({ name: 'Kosoan', city: 'Tokyo', address: '   ' });
      expect(url).toBe('https://maps.apple.com/?q=Kosoan%2C%20Tokyo');
    });

    it('ignores externalPlaceId in apple-only mode', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        latitude: 35.6076,
        longitude: 139.668,
        externalPlaceId: 'ChIJabc',
      });
      expect(url).not.toContain('ChIJabc');
      expect(url).toContain('ll=');
    });
  });

  describe('google-installed', () => {
    beforeEach(() => _setDetectionForTests('google-installed'));

    it('prefers the universal-link form with query_place_id when present', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        externalPlaceId: 'ChIJabc',
        latitude: 35.6076,
        longitude: 139.668,
      });
      expect(url).toBe(
        'https://www.google.com/maps/search/?api=1&query=Kosoan&query_place_id=ChIJabc',
      );
    });

    it('uses comgooglemaps:// with center and zoom when coords but no place id', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        latitude: 35.6076,
        longitude: 139.668,
      });
      expect(url).toMatch(/^comgooglemaps:\/\/\?/);
      expect(url).toContain('q=Kosoan');
      expect(url).toContain('center=35.6076%2C139.668');
      expect(url).toContain('zoom=15');
    });

    it('falls back to comgooglemaps:// search query when no coords or place id', () => {
      const url = buildMapUrl({
        name: 'Kosoan',
        city: 'Tokyo',
        address: '1 Chome-24-23 Jiyugaoka',
      });
      expect(url).toBe(
        'comgooglemaps://?q=Kosoan%2C%201%20Chome-24-23%20Jiyugaoka',
      );
    });
  });

  describe('unknown (not yet warmed)', () => {
    it('defaults to Apple Maps before warm-up completes', () => {
      // detection is 'unknown' (reset in outer beforeEach).
      const url = buildMapUrl({ name: 'Kosoan' });
      expect(url).toBe('https://maps.apple.com/?q=Kosoan');
    });
  });
});
