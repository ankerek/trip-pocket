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
          {
            name: 'Maru Tonkatsu',
            city: 'Tokyo',
            address: '',
            category: 'food',
            country_code: 'JP',
          },
          {
            name: 'Tsukiji Outer Market',
            city: 'Tokyo',
            address: '5 Chome-2-1 Tsukiji, Chuo City, Tokyo 104-0045, Japan',
            category: 'sights',
            country_code: 'JP',
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
        places: [{ name: 'X', city: 'Y', address: '', category: 'bogus', country_code: '' }],
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
        places: [
          { name: 'Mystery Place', city: '', address: '', category: 'sights', country_code: '' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty address string (LLM signaling no address in OCR)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Paris', address: '', category: 'food', country_code: 'FR' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects places missing the address field', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: 'Paris', category: 'food', country_code: 'FR' }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts a valid uppercase ISO-2 country_code', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Paris', address: '', category: 'food', country_code: 'FR' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('FR');
    });

    it('accepts empty country_code (LLM signaling truly ambiguous country)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: '', address: '', category: 'food', country_code: '' }],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('');
    });

    it('coerces lowercase country_code to uppercase (keeps the place; never splits grouping buckets)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Tokyo', address: '', category: 'food', country_code: 'jp' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('JP');
    });

    it('coerces 3-letter country code to empty (keeps the place, drops the bad value)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Tokyo', address: '', category: 'food', country_code: 'JPN' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('');
    });

    it('coerces 1-character country_code to empty (keeps the place)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: 'Tokyo', address: '', category: 'food', country_code: 'J' }],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('');
    });

    it('coerces full country name to empty (keeps the place)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Tokyo', address: '', category: 'food', country_code: 'Japan' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('');
    });

    it('defaults missing country_code to empty (keeps the place — model omission is non-fatal)', () => {
      const result = extractionResponseSchema.safeParse({
        places: [{ name: 'Cafe', city: 'Paris', address: '', category: 'food' }],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('');
    });

    it('trims surrounding whitespace before validating', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Cafe', city: 'Paris', address: '', category: 'food', country_code: '  fr  ' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('FR');
    });

    it('keeps surviving places when one place in the batch has a bad country_code', () => {
      const result = extractionResponseSchema.safeParse({
        places: [
          { name: 'Good', city: 'Tokyo', address: '', category: 'food', country_code: 'JP' },
          { name: 'Bad', city: 'Tokyo', address: '', category: 'food', country_code: 'JPN' },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.data?.places[0]?.country_code).toBe('JP');
      expect(result.data?.places[1]?.country_code).toBe('');
    });
  });
});
