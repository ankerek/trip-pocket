import { Linking } from 'react-native';

export type MapTarget = {
  name: string;
  city?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  externalPlaceId?: string | null;
};

const GOOGLE_MAPS_SCHEME = 'comgooglemaps://';

let detection: 'unknown' | 'apple-only' | 'google-installed' = 'unknown';
let inflight: Promise<void> | null = null;

export async function warmMapAppDetection(): Promise<void> {
  if (detection !== 'unknown') return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ok = await Linking.canOpenURL(GOOGLE_MAPS_SCHEME);
      detection = ok ? 'google-installed' : 'apple-only';
    } catch {
      detection = 'apple-only';
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function _resetDetectionForTests(): void {
  detection = 'unknown';
  inflight = null;
}

export function _setDetectionForTests(value: 'apple-only' | 'google-installed'): void {
  detection = value;
}

export function buildMapUrl(target: MapTarget): string {
  return detection === 'google-installed' ? buildGoogleUrl(target) : buildAppleUrl(target);
}

export async function openInMaps(target: MapTarget): Promise<void> {
  await warmMapAppDetection();
  const url = buildMapUrl(target);
  await Linking.openURL(url);
}

function buildAppleUrl(t: MapTarget): string {
  if (hasCoords(t)) {
    const params = new URLSearchParams({
      ll: `${t.latitude},${t.longitude}`,
      q: t.name,
    });
    return `https://maps.apple.com/?${params.toString()}`;
  }
  return `https://maps.apple.com/?q=${encodeURIComponent(buildSearchQuery(t))}`;
}

function buildGoogleUrl(t: MapTarget): string {
  // `query_place_id` pins the exact venue; the universal-link form opens
  // Google Maps app on iOS when installed (intercepted) and the browser
  // otherwise. Most precise option when external_place_id is known.
  if (t.externalPlaceId) {
    const params = new URLSearchParams({
      api: '1',
      query: t.name,
      query_place_id: t.externalPlaceId,
    });
    return `https://www.google.com/maps/search/?${params.toString()}`;
  }
  if (hasCoords(t)) {
    const params = new URLSearchParams({
      q: t.name,
      center: `${t.latitude},${t.longitude}`,
      zoom: '15',
    });
    return `comgooglemaps://?${params.toString()}`;
  }
  return `comgooglemaps://?q=${encodeURIComponent(buildSearchQuery(t))}`;
}

function hasCoords(
  t: MapTarget,
): t is MapTarget & { latitude: number; longitude: number } {
  return (
    typeof t.latitude === 'number' &&
    Number.isFinite(t.latitude) &&
    typeof t.longitude === 'number' &&
    Number.isFinite(t.longitude)
  );
}

function buildSearchQuery(t: MapTarget): string {
  const hint = t.address?.trim() || t.city?.trim() || '';
  return [t.name, hint].filter(Boolean).join(', ');
}
