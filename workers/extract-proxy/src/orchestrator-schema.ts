import { z } from 'zod';
import { placeSchema } from './schema';

const HEX_64 = /^[0-9a-f]{64}$/;

const urlKindSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  kind: z.literal('url'),
  url: z.string().url(),
  suggestedTripId: z.string().optional(),
});

export const orchestratorRequestSchema = urlKindSchema;
export type OrchestratorRequest = z.infer<typeof orchestratorRequestSchema>;

// Enriched place returned from the orchestrator. Extends the bare
// extraction schema (`placeSchema`) with Google Places fields and the
// optional bulk-blurb output. The client treats `enrichment_status='enriched'`
// as the terminal state for these — only `blurb_status='failed'` is a
// retry signal (the tile calls /blurb-retry with cachedDetails to recover).
export const enrichedPlaceSchema = placeSchema.extend({
  external_place_id: z.string().nullable().optional(),
  formatted_address: z.string().nullable().optional(),
  photo_name: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  rating: z.number().nullable().optional(),
  price_level: z.number().int().nullable().optional(),
  external_url: z.string().nullable().optional(),
  editorial_summary: z.string().nullable().optional(),
  blurb: z.string().nullable().optional(),
  // Mirrors enrichDebugSchema.blurbOutcome plus 'not-found' for places
  // that lacked a Google Places match (we still record the place but
  // can't generate a grounded blurb without `displayName` and details).
  blurb_status: z.enum(['ok', 'empty', 'failed', 'not-found']).nullable().optional(),
});

export type EnrichedPlace = z.infer<typeof enrichedPlaceSchema>;

// Shape stored in EXTRACT_STATE KV and returned by both POST and GET. The
// status field is the state machine; later states carry more fields.
//   pending  → only the hash is known; nothing else yet
//   partial  → fetch-post finished; caption + coverUrl available
//   done     → extraction + enrichment finished; places present with
//              Google Places data + blurbs (best-effort; some may have
//              blurb_status='failed' for the client to retry via
//              /blurb-retry)
//   error    → terminal failure; code carries the reason
export const orchestratorStateSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  status: z.enum(['pending', 'partial', 'done', 'error']),
  caption: z.string().optional(),
  coverUrl: z.string().url().optional(),
  videoPresent: z.boolean().optional(),
  places: z.array(enrichedPlaceSchema).optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;
