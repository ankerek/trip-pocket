import { normalizeUrl } from '@/modules/capture/importUrl';
import fixtures from '../../../__fixtures__/canonical-urls.json';

// Parity contract: this fixture is the source of truth for the URL
// canonicalization shared by the iOS share extension (Swift) and the app
// (TypeScript via modules/capture/importUrl#normalizeUrl). Any change to
// the algorithm MUST update both implementations AND the fixture, and
// CanonicalizeTests.swift must pass against the same JSON.
describe('normalizeUrl — fixture parity with native/ShareExtension/Canonicalize.swift', () => {
  for (const [input, expected] of fixtures as [string, string][]) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeUrl(input)).toBe(expected);
    });
  }
});
