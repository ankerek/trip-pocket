import { deriveLocationCaption, type ReverseGeocoder } from '../photoLocation';

const TOKYO_EXIF = {
  Make: 'Apple',
  Model: 'iPhone 14 Pro',
  GPSLatitude: 35.6076,
  GPSLatitudeRef: 'N',
  GPSLongitude: 139.668,
  GPSLongitudeRef: 'E',
};

function fakeGeocoder(
  result: ReturnType<typeof Object>[] | ((c: { latitude: number; longitude: number }) => unknown),
) {
  if (typeof result === 'function') return result as ReverseGeocoder;
  return jest.fn(async () => result) as unknown as ReverseGeocoder;
}

describe('deriveLocationCaption', () => {
  it('returns null when EXIF is missing', async () => {
    const got = await deriveLocationCaption(null, fakeGeocoder([]));
    expect(got).toBeNull();
  });

  it('returns null when EXIF lacks Make/Model (treat as screenshot)', async () => {
    // Screenshots on iOS arrive with EXIF stripped down to just dimensions —
    // no camera Make/Model. Treat as not-a-photo.
    const exif = {
      GPSLatitude: 35.6,
      GPSLatitudeRef: 'N',
      GPSLongitude: 139.6,
      GPSLongitudeRef: 'E',
    };
    const geocoder = jest.fn();
    const got = await deriveLocationCaption(exif, geocoder as unknown as ReverseGeocoder);
    expect(got).toBeNull();
    expect(geocoder).not.toHaveBeenCalled();
  });

  it('returns null when camera photo has no GPS (location services off)', async () => {
    const exif = { Make: 'Apple', Model: 'iPhone 14 Pro' };
    const geocoder = jest.fn();
    const got = await deriveLocationCaption(exif, geocoder as unknown as ReverseGeocoder);
    expect(got).toBeNull();
    expect(geocoder).not.toHaveBeenCalled();
  });

  it('skips (0, 0) — almost always missing metadata rather than the Gulf of Guinea', async () => {
    const exif = {
      Make: 'Apple',
      Model: 'iPhone 14 Pro',
      GPSLatitude: 0,
      GPSLatitudeRef: 'N',
      GPSLongitude: 0,
      GPSLongitudeRef: 'E',
    };
    const geocoder = jest.fn();
    await deriveLocationCaption(exif, geocoder as unknown as ReverseGeocoder);
    expect(geocoder).not.toHaveBeenCalled();
  });

  it('applies S/W hemisphere refs to make coordinates signed', async () => {
    const exif = {
      Make: 'Apple',
      Model: 'iPhone 14 Pro',
      GPSLatitude: 33.8688,
      GPSLatitudeRef: 'S',
      GPSLongitude: 151.2093,
      GPSLongitudeRef: 'E',
    };
    const geocoder = jest.fn(async () => [{ city: 'Sydney', country: 'Australia' }]);
    await deriveLocationCaption(exif, geocoder);
    expect(geocoder).toHaveBeenCalledWith({ latitude: -33.8688, longitude: 151.2093 });
  });

  it('builds caption from city + country when both are present', async () => {
    const geocoder = fakeGeocoder([{ city: 'Tokyo', country: 'Japan' }]);
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBe('Photo taken in Tokyo, Japan');
  });

  it('includes district/subregion when geocoder returns them', async () => {
    const geocoder = fakeGeocoder([{ district: 'Jiyugaoka', city: 'Tokyo', country: 'Japan' }]);
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBe('Photo taken in Jiyugaoka, Tokyo, Japan');
  });

  it('dedups identical adjacent fields (Apple geocoder sometimes returns city=region)', async () => {
    const geocoder = fakeGeocoder([
      { city: 'Singapore', region: 'Singapore', country: 'Singapore' },
    ]);
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBe('Photo taken in Singapore');
  });

  it('returns null when geocoder throws (CLGeocoder rate limit / network)', async () => {
    const geocoder: ReverseGeocoder = jest.fn(async () => {
      throw new Error('rate limited');
    });
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBeNull();
  });

  it('returns null when geocoder returns an empty array', async () => {
    const geocoder = fakeGeocoder([]);
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBeNull();
  });

  it('returns null when the result has no usable fields', async () => {
    const geocoder = fakeGeocoder([{}]);
    const got = await deriveLocationCaption(TOKYO_EXIF, geocoder);
    expect(got).toBeNull();
  });
});
