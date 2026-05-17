import { dedupePlaces } from '../src/dedupe';

describe('dedupePlaces', () => {
  const base = { address: '', country_code: 'US', category: 'food' as const };

  it('drops case-insensitive name+city duplicates', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'San Francisco' },
      { ...base, name: 'tartine', city: 'San Francisco' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Tartine');
  });

  it('keeps places that differ in city', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'San Francisco' },
      { ...base, name: 'Tartine', city: 'Berlin' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps places that differ in address', () => {
    const out = dedupePlaces([
      { ...base, name: 'Tartine', city: 'SF', address: '600 Guerrero' },
      { ...base, name: 'Tartine', city: 'SF', address: '375 Valencia' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('preserves order (first occurrence wins)', () => {
    const out = dedupePlaces([
      { ...base, name: 'A', city: 'X' },
      { ...base, name: 'B', city: 'Y' },
      { ...base, name: 'A', city: 'X' },
    ]);
    expect(out.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('treats trimmed city and address as equal to padded variants', () => {
    const out = dedupePlaces([
      { ...base, name: 'X', city: 'SF', address: '  Guerrero  ' },
      { ...base, name: 'X', city: 'SF ', address: 'Guerrero' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('returns an empty array unchanged', () => {
    expect(dedupePlaces([])).toEqual([]);
  });
});
