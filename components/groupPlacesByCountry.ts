// Group a trip's places by country_code for the section-headered Places tab.
// Empty-string codes are coerced into the null (unknown) bucket — defensive
// against any drift in how callers represent "no country signal".
//
// Sort: row count desc among non-null groups, ties broken by the order each
// code is first seen. Null/unknown bucket always last so it never visually
// dominates over a known country.

export type CountryGroup<T> = {
  code: string | null;
  places: T[];
};

type PlaceLike = { country_code: string | null };

export function groupPlacesByCountry<T extends PlaceLike>(places: T[]): CountryGroup<T>[] {
  // Maintain insertion order with a Map so ties resolve to first-seen.
  const groups = new Map<string | null, T[]>();
  for (const place of places) {
    const raw = place.country_code;
    const key = raw == null || raw === '' ? null : raw;
    const existing = groups.get(key);
    if (existing) {
      existing.push(place);
    } else {
      groups.set(key, [place]);
    }
  }

  const entries: CountryGroup<T>[] = Array.from(groups.entries()).map(([code, places]) => ({
    code,
    places,
  }));

  return entries.sort((a, b) => {
    if (a.code === null && b.code !== null) return 1;
    if (a.code !== null && b.code === null) return -1;
    return b.places.length - a.places.length;
  });
}
