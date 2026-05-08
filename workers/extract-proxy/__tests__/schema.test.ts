import { extractionResponseSchema, requestBodySchema } from '../src/schema';

describe('extract-proxy schema', () => {
  describe('requestBodySchema', () => {
    it('accepts a non-empty ocr_text string', () => {
      const result = requestBodySchema.safeParse({ ocr_text: 'hello world' });
      expect(result.success).toBe(true);
    });

    it('rejects missing ocr_text', () => {
      const result = requestBodySchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects non-string ocr_text', () => {
      const result = requestBodySchema.safeParse({ ocr_text: 123 });
      expect(result.success).toBe(false);
    });

    it('rejects empty ocr_text — proxy refuses extraction calls with no content', () => {
      const result = requestBodySchema.safeParse({ ocr_text: '' });
      expect(result.success).toBe(false);
    });

    it('rejects whitespace-only ocr_text', () => {
      const result = requestBodySchema.safeParse({ ocr_text: '   \n\t  ' });
      expect(result.success).toBe(false);
    });
  });

  describe('extractionResponseSchema', () => {
    it('accepts a valid places array', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Maru Tonkatsu', city: 'Tokyo', address: '', category: 'food' },
          {
            name: 'Tsukiji Outer Market',
            city: 'Tokyo',
            address: '5 Chome-2-1 Tsukiji, Chuo City, Tokyo 104-0045, Japan',
            category: 'place',
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts an empty places array — the noise classifier signal', () => {
      const result = extractionResponseSchema.safeParse({ places: [] });
      expect(result.success).toBe(true);
    });

    it('rejects unknown category values', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'X', city: 'Y', address: '', category: 'bogus' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects places missing required fields', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'X', category: 'food' }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts empty city string (LLM signaling truly ambiguous location)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Mystery Place', city: '', address: '', category: 'place' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty address string (LLM signaling no address in OCR)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: 'Paris', address: '', category: 'food' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects places missing the address field', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: 'Paris', category: 'food' }],
      });
      expect(result.success).toBe(false);
    });
  });
});
