import { requireOptionalNativeModule } from 'expo-modules-core';

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  appleMapsUrl: string;
};

type AppleGeocoderNative = {
  geocodePlace: (name: string, city: string) => Promise<GeocodeResult | null>;
};

// requireOptionalNativeModule returns null in environments where the native
// side isn't registered (Jest, Expo Go, web). Production builds (after
// `npx expo prebuild --clean && npx expo run:ios`) get the real module.
const native = requireOptionalNativeModule('AppleGeocoder') as AppleGeocoderNative | null;

export const isAppleGeocoderAvailable = (): boolean => native !== null;

// Best-effort geocoding. Returns null when:
//   - the native module isn't registered (Jest, web, Expo Go)
//   - MKLocalSearch returns no matches
//   - any underlying error (network, timeout, malformed input)
//
// modules/extraction treats a null result as "place persisted without
// geocoding"; tap-to-Maps falls back to the `?q=` query-string deep link.
export const geocodePlace = async (
  name: string,
  city: string,
): Promise<GeocodeResult | null> => {
  if (!native) return null;
  if (!name.trim()) return null;
  try {
    return await native.geocodePlace(name, city);
  } catch {
    return null;
  }
};

export default { geocodePlace, isAppleGeocoderAvailable };
