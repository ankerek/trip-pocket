import { sha256OfBytes } from '../importFsRuntime';

describe('sha256OfBytes', () => {
  it('hashes the bytes of "hello" to the documented SHA-256 hex', async () => {
    // shasum -a 256 <(printf 'hello')
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const bytes = new TextEncoder().encode('hello');
    expect(await sha256OfBytes(bytes)).toBe(expected);
  });

  it('hashes the bytes of "abc" to the documented SHA-256 hex', async () => {
    // FIPS 180-2 test vector
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256OfBytes(bytes)).toBe(expected);
  });

  it('hashes empty input to the empty-string SHA-256', async () => {
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(await sha256OfBytes(new Uint8Array(0))).toBe(expected);
  });

  it('hashes a subarray view (non-zero byteOffset) using only the view bytes', async () => {
    // FIPS 180-2 test vector for 'abc'
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const big = new TextEncoder().encode('XXabcYY');
    const view = big.subarray(2, 5); // 'abc' as a view with byteOffset=2
    expect(await sha256OfBytes(view)).toBe(expected);
  });
});
