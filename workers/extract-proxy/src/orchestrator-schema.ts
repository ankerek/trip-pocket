import { z } from 'zod';
import { placeSchema } from './schema';
import { fetchPostResponseSchema } from './fetch-post';

const HEX_64 = /^[0-9a-f]{64}$/;

const urlKindSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  kind: z.literal('url'),
  url: z.string().url(),
  suggestedTripId: z.string().optional(),
});

export const orchestratorRequestSchema = urlKindSchema;
export type OrchestratorRequest = z.infer<typeof orchestratorRequestSchema>;

/**
 * Queue message that drives the orchestrator. Each stage handler reads
 * the persisted KV state for `contentHash` and only requires the hash to
 * resume — the rest of the work in-flight is the KV row.
 *
 * The fetch-post stage additionally needs `url` (and optionally
 * `suggestedTripId`) because no prior KV row exists for the share yet.
 */
export const extractJobMessageSchema = z.discriminatedUnion('stage', [
  z.object({
    stage: z.literal('fetch-post'),
    contentHash: z.string().regex(HEX_64),
    url: z.string().url(),
    suggestedTripId: z.string().optional(),
  }),
  z.object({
    stage: z.literal('extract'),
    contentHash: z.string().regex(HEX_64),
  }),
  z.object({
    stage: z.literal('enrich'),
    contentHash: z.string().regex(HEX_64),
  }),
]);

export type ExtractJobMessage = z.infer<typeof extractJobMessageSchema>;

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
//   partial  → fetch-post finished; caption + coverUrl available, AND the
//              full `fetched` payload is persisted so the next stage
//              (extract) can run on a separate Worker invocation without
//              re-hitting Apify/OG. Required for the queue-driven split:
//              each stage owns its own ctx.waitUntil budget and reads
//              everything it needs from KV.
//   done     → extraction + enrichment finished; places present with
//              Google Places data + blurbs (best-effort; some may have
//              blurb_status='failed' for the client to retry via
//              /blurb-retry). May land as an "early" un-enriched done
//              after the extract stage; the enrich stage upgrades it.
//   error    → terminal failure; code carries the reason
export const orchestratorStateSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  status: z.enum(['pending', 'partial', 'done', 'error']),
  caption: z.string().optional(),
  coverUrl: z.string().url().optional(),
  videoPresent: z.boolean().optional(),
  /**
   * Snapshot of the FetchPostResponse the fetch-post stage produced.
   * Persisted on `partial` so the extract / enrich stages can read it on
   * a fresh Worker invocation. Omitted from `done` / `error` rows the
   * client already consumed (they only need places at that point) but
   * never explicitly stripped — write whatever's been observed.
   */
  fetched: fetchPostResponseSchema.optional(),
  places: z.array(enrichedPlaceSchema).optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;
