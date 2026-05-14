import { groupPlacesByCountry } from '../groupPlacesByCountry';

type T = { id: string; country_code: string | null };

const p = (id: string, country_code: string | null): T => ({ id, country_code });

describe('groupPlacesByCountry', () => {
  it('returns a single group when all places share the same country', () => {
    const groups = groupPlacesByCountry<T>([p('a', 'JP'), p('b', 'JP'), p('c', 'JP')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.code).toBe('JP');
    expect(groups[0]?.places.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a single null-coded group when all places are missing country', () => {
    const groups = groupPlacesByCountry<T>([p('a', null), p('b', null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.code).toBeNull();
  });

  it('orders multi-country groups by row count desc, ties broken by first-seen', () => {
    const places: T[] = [
      p('a', 'JP'),
      p('b', 'FR'),
      p('c', 'JP'),
      p('d', 'FR'),
      p('e', 'JP'),
      p('f', 'IT'),
    ];
    const groups = groupPlacesByCountry<T>(places);
    expect(groups.map((g) => g.code)).toEqual(['JP', 'FR', 'IT']);
    expect(groups[0]?.places).toHaveLength(3);
    expect(groups[1]?.places).toHaveLength(2);
    expect(groups[2]?.places).toHaveLength(1);
  });

  it('always sorts the null-coded bucket last, regardless of size', () => {
    const places: T[] = [p('n1', null), p('n2', null), p('n3', null), p('jp', 'JP')];
    const groups = groupPlacesByCountry<T>(places);
    expect(groups.map((g) => g.code)).toEqual(['JP', null]);
  });

  it('preserves input order of places within a group', () => {
    const groups = groupPlacesByCountry<T>([p('b', 'JP'), p('a', 'JP'), p('c', 'JP')]);
    expect(groups[0]?.places.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns an empty array for empty input', () => {
    expect(groupPlacesByCountry<T>([])).toEqual([]);
  });

  it('treats empty-string country_code as null bucket (defensive)', () => {
    const groups = groupPlacesByCountry<{ id: string; country_code: string | null }>([
      { id: 'a', country_code: '' as unknown as null },
      { id: 'b', country_code: 'JP' },
    ]);
    expect(groups.map((g) => g.code)).toEqual(['JP', null]);
  });
});
