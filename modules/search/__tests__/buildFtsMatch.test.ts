import { buildFtsMatch } from '../buildFtsMatch';

describe('buildFtsMatch', () => {
  describe('rejected inputs', () => {
    it.each([
      ['empty string', ''],
      ['only whitespace', '   '],
      ['1 char', 'a'],
      ['2 chars', 'ab'],
      ['2 CJK chars (below trigram min)', '定食'],
    ])('returns null for %s', (_label, input) => {
      expect(buildFtsMatch(input)).toBeNull();
    });
  });

  describe('happy paths', () => {
    it('quotes a single ASCII token (no * suffix — trigram already substring-matches)', () => {
      expect(buildFtsMatch('tonk')).toBe('"tonk"');
    });

    it('quotes and AND-joins multiple tokens', () => {
      expect(buildFtsMatch('maru tonkatsu')).toBe('"maru" "tonkatsu"');
    });

    it('trims surrounding whitespace before measuring length', () => {
      expect(buildFtsMatch('   tonk   ')).toBe('"tonk"');
    });

    it('collapses interior whitespace into single AND-joined tokens', () => {
      expect(buildFtsMatch('maru   tonkatsu  shibuya')).toBe('"maru" "tonkatsu" "shibuya"');
    });

    it('passes a 3-codepoint CJK substring through (real OCR trigger case)', () => {
      expect(buildFtsMatch('つ定食')).toBe('"つ定食"');
    });

    it('quotes embedded apostrophe as a literal substring (no FTS5 escape needed)', () => {
      expect(buildFtsMatch("O'Brien")).toBe('"O\'Brien"');
    });

    it('escapes embedded double-quote by doubling it (FTS5 string-literal rule)', () => {
      expect(buildFtsMatch('say "hi"')).toBe('"say" """hi"""');
    });

    it('strips FTS5 special chars inside tokens by quoting them — no operator interpretation', () => {
      // FTS5 normally treats * as a prefix operator. Inside double quotes it
      // is literal. The helper relies on quoting alone to neutralize *, +, -,
      // (, ), :, etc. as operators.
      expect(buildFtsMatch('foo* bar+baz')).toBe('"foo*" "bar+baz"');
    });
  });

  describe('codepoint counting', () => {
    it('counts a 3-codepoint string as enough', () => {
      expect(buildFtsMatch('a b')).toBe('"a" "b"'); // raw length 3, tokens are short
    });

    it('rejects a 2-codepoint string', () => {
      expect(buildFtsMatch('a ')).toBeNull(); // trims to "a"
    });
  });
});
