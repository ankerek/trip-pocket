import { parseSnippet } from '../SearchSnippet';

const STX = '';
const ETX = '';

describe('parseSnippet', () => {
  it('returns a single plain piece when there are no markers', () => {
    expect(parseSnippet('Maru Tonkatsu')).toEqual([{ text: 'Maru Tonkatsu', bold: false }]);
  });

  it('extracts a single highlight in the middle', () => {
    const raw = `Maru ${STX}Tonkatsu${ETX} in Shibuya`;
    expect(parseSnippet(raw)).toEqual([
      { text: 'Maru ', bold: false },
      { text: 'Tonkatsu', bold: true },
      { text: ' in Shibuya', bold: false },
    ]);
  });

  it('extracts multiple highlights', () => {
    const raw = `${STX}Maru${ETX} ${STX}Tonkatsu${ETX} in Shibuya`;
    expect(parseSnippet(raw)).toEqual([
      { text: 'Maru', bold: true },
      { text: ' ', bold: false },
      { text: 'Tonkatsu', bold: true },
      { text: ' in Shibuya', bold: false },
    ]);
  });

  it('handles a highlight at the start', () => {
    const raw = `${STX}Hello${ETX} world`;
    expect(parseSnippet(raw)).toEqual([
      { text: 'Hello', bold: true },
      { text: ' world', bold: false },
    ]);
  });

  it('handles a highlight at the end', () => {
    const raw = `Goodbye ${STX}world${ETX}`;
    expect(parseSnippet(raw)).toEqual([
      { text: 'Goodbye ', bold: false },
      { text: 'world', bold: true },
    ]);
  });

  it('handles a malformed marker (STX without a matching ETX) gracefully', () => {
    const raw = `Hello ${STX}world is unterminated`;
    expect(parseSnippet(raw)).toEqual([
      { text: 'Hello ', bold: false },
      { text: 'world is unterminated', bold: false },
    ]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseSnippet('')).toEqual([]);
  });
});
