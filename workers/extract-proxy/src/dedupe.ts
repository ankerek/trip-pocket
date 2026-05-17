import type { ExtractedPlace } from './schema';

/**
 * Per-post dedup. Drops case-insensitive name + trimmed-city + trimmed-address
 * duplicates while preserving the first occurrence. Mirrors the existing
 * client-side per-call dedup in modules/extraction/extraction.ts so the
 * server-deduped list matches what the client would have produced — the
 * client now just inserts what we hand it without doing this pass again.
 */
export function dedupePlaces(places: ExtractedPlace[]): ExtractedPlace[] {
  const seen = new Set<string>();
  const out: ExtractedPlace[] = [];
  for (const p of places) {
    const key =
      p.name.toLowerCase() +
      '::' +
      p.city.trim().toLowerCase() +
      '::' +
      p.address.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
