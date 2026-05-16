// Derives a "Photo taken in X" caption from an iOS/Android photo's EXIF + a
// reverse-geocoder. Used only on the photo-picker path so we can give the
// vision LLM useful geographic context for tightly-framed photos of place
// signs (e.g. a café board that just says "Maru" — knowing the GPS resolves
// to Jiyugaoka, Tokyo turns it from ambiguous into specific).
//
// Scope decisions:
//   - Photos only, never screenshots. We treat presence of EXIF `Make` +
//     `Model` as the camera-photo signal; iOS strips these on screenshots
//     and most edited/shared paths preserve them.
//   - GPS is OPTIONAL. A camera photo without GPS (location services off,
//     EXIF stripped by share sheet) returns null and we extract via plain
//     vision strategy — same as before.
//   - Reverse-geocoder is injected so the unit tests don't need
//     expo-location's native module. The runtime wires expo-location's
//     `reverseGeocodeAsync`.

export type GeocodeResult = {
  city?: string | null;
  region?: string | null;
  subregion?: string | null;
  district?: string | null;
  country?: string | null;
  isoCountryCode?: string | null;
};

export type ReverseGeocoder = (coords: {
  latitude: number;
  longitude: number;
}) => Promise<GeocodeResult[]>;

export async function deriveLocationCaption(
  exif: Record<string, unknown> | null | undefined,
  geocoder: ReverseGeocoder,
): Promise<string | null> {
  if (!isCameraPhoto(exif)) return null;
  const coords = readGpsCoords(exif);
  if (!coords) return null;
  let results: GeocodeResult[];
  try {
    results = await geocoder(coords);
  } catch {
    // CLGeocoder rate-limits at ~50 req/min; treat any failure as a soft
    // skip — the photo still extracts via the plain vision path.
    return null;
  }
  const first = results?.[0];
  if (!first) return null;
  return buildCaption(first);
}

// Camera-photo signal: EXIF has `Make` AND `Model`. iOS screenshots have
// neither; shared/edited photos almost always preserve them.
function isCameraPhoto(
  exif: Record<string, unknown> | null | undefined,
): exif is Record<string, unknown> {
  if (!exif || typeof exif !== 'object') return false;
  const make = exif['Make'];
  const model = exif['Model'];
  return (
    typeof make === 'string' && make.length > 0 && typeof model === 'string' && model.length > 0
  );
}

// expo-image-picker returns GPS as positive decimal degrees plus separate
// Ref strings (N/S, E/W) carrying the hemisphere. Apply the ref so Southern /
// Western coordinates land negative.
function readGpsCoords(
  exif: Record<string, unknown>,
): { latitude: number; longitude: number } | null {
  const lat = exif['GPSLatitude'];
  const lng = exif['GPSLongitude'];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!isFinite(lat) || !isFinite(lng)) return null;
  // (0, 0) — almost certainly missing/zeroed metadata rather than a photo
  // taken in the Gulf of Guinea. Treat as absent.
  if (lat === 0 && lng === 0) return null;
  const latRef = exif['GPSLatitudeRef'];
  const lngRef = exif['GPSLongitudeRef'];
  const signedLat = latRef === 'S' ? -Math.abs(lat) : lat;
  const signedLng = lngRef === 'W' ? -Math.abs(lng) : lng;
  return { latitude: signedLat, longitude: signedLng };
}

// Builds "Photo taken in <neighborhood>, <city>, <country>". Drops empty /
// duplicate components — Apple's geocoder sometimes returns the same string
// in two adjacent fields.
function buildCaption(geo: GeocodeResult): string | null {
  const candidates = [geo.district, geo.subregion, geo.city, geo.region, geo.country];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(trimmed);
  }
  if (parts.length === 0) return null;
  return `Photo taken in ${parts.join(', ')}`;
}
