import { z } from 'zod';

// Mirrors the Gemini `responseSchema` exactly. The LLM is structurally
// guaranteed to produce JSON that conforms to its responseSchema, so this
// is a defense-in-depth check (catches future schema drift) plus the type
// for downstream code.
export const placeSchema = z.object({
  name: z.string().min(1),
  city: z.string(), // empty string allowed — LLM signals truly ambiguous
  address: z.string(), // empty string when text has no street address
  category: z.enum(['food', 'drinks', 'stays', 'sights', 'activities', 'shops']),
  // ISO 3166-1 alpha-2. Lenient parser: any non-conforming value (missing,
  // wrong case, 3-letter, full name, non-string, …) coerces to empty
  // string. Rationale: a single malformed country_code from the LLM
  // shouldn't blow up the whole extraction batch — drop the bad value,
  // keep the place. Empty string normalises to NULL at the storage
  // boundary, where enrichment can still fill it authoritatively from
  // Google Places.
  country_code: z.unknown().transform((v) => {
    if (typeof v !== 'string') return '';
    const upper = v.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(upper) ? upper : '';
  }),
});

export const extractionResponseSchema = z.object({
  places: z.array(placeSchema),
});

// Request payload — three shapes accepted at the wire.
//
// 1. `{ mode: 'text', text }`             — canonical text-mode (PR 2+)
// 2. `{ mode: 'vision', imageBase64, caption? }` — canonical vision-mode (PR 2+)
// 3. `{ ocr_text }`                       — legacy alias, kept for one release
//                                            so worker and app can be deployed
//                                            independently. Transforms into
//                                            text-mode internally.
//
// Empty / whitespace-only text never reaches the proxy in normal operation —
// the client short-circuits to extraction_status='done' without a network call.
// The checks here are defensive 400s in case anyone calls the proxy directly.

const textModeSchema = z.object({
  mode: z.literal('text'),
  text: z.string().refine((s) => s.trim().length > 0, {
    message: 'text must be a non-empty, non-whitespace string',
  }),
});

const visionModeSchema = z.object({
  mode: z.literal('vision'),
  imageBase64: z.string().min(1, 'imageBase64 must be non-empty'),
  caption: z.string().optional(),
});

const legacyAliasSchema = z
  .object({
    ocr_text: z.string().refine((s) => s.trim().length > 0, {
      message: 'ocr_text must be a non-empty, non-whitespace string',
    }),
  })
  .transform((r) => ({ mode: 'text' as const, text: r.ocr_text }));

export const requestBodySchema = z.union([textModeSchema, visionModeSchema, legacyAliasSchema]);

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;
export type ExtractedPlace = z.infer<typeof placeSchema>;
export type RequestBody = z.infer<typeof requestBodySchema>;
