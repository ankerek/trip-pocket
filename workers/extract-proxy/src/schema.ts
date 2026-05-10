import { z } from 'zod';

// Mirrors the Gemini `responseSchema` exactly. The LLM is structurally
// guaranteed to produce JSON that conforms to its responseSchema, so this
// is a defense-in-depth check (catches future schema drift) plus the type
// for downstream code.
export const placeSchema = z.object({
  name: z.string().min(1),
  city: z.string(),  // empty string allowed — LLM signals truly ambiguous
  address: z.string(),  // empty string when text has no street address
  category: z.enum(['place', 'food', 'activity']),
  // ISO 3166-1 alpha-2 uppercase, or empty when the LLM can't infer.
  // Lowercase or 3-letter codes would split grouping buckets downstream;
  // the regex is the single point of enforcement.
  country_code: z.string().regex(/^([A-Z]{2})?$/),
});

export const extractionResponseSchema = z.object({
  places: z.array(placeSchema),
});

// Client-side request shape. Empty / whitespace-only ocr_text never reaches
// the proxy in normal operation — the client short-circuits to
// extraction_status='done' without a network call. The check here is a
// defensive 400 in case anyone calls the proxy directly.
export const requestBodySchema = z.object({
  ocr_text: z.string().refine((s) => s.trim().length > 0, {
    message: 'ocr_text must be a non-empty, non-whitespace string',
  }),
});

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;
export type ExtractedPlace = z.infer<typeof placeSchema>;
export type RequestBody = z.infer<typeof requestBodySchema>;
