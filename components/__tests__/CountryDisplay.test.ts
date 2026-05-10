import { COUNTRY_NAMES, displayCountry } from '../CountryDisplay';

describe('CountryDisplay', () => {
  it('returns the English name for a known ISO-2 code', () => {
    expect(displayCountry('JP')).toBe('Japan');
    expect(displayCountry('US')).toBe('United States');
    expect(displayCountry('FR')).toBe('France');
    expect(displayCountry('GB')).toBe('United Kingdom');
  });

  it('falls back to the raw code when the code is not in the map', () => {
    expect(displayCountry('ZZ')).toBe('ZZ');
  });

  it('returns null/empty for null/empty input', () => {
    expect(displayCountry(null)).toBeNull();
    expect(displayCountry('')).toBeNull();
  });

  it('covers a wide span of common travel destinations', () => {
    // Spot-check several countries the app is likely to encounter early.
    const required = ['JP', 'US', 'FR', 'IT', 'ES', 'GB', 'DE', 'KR', 'TH', 'VN', 'TR', 'MX', 'PT', 'GR', 'AU'];
    for (const code of required) {
      expect(COUNTRY_NAMES[code]).toBeTruthy();
    }
  });
});
