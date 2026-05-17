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

// Shape stored in EXTRACT_STATE KV and returned by both POST and GET. The
// status field is the state machine; later states carry more fields.
//   pending  → only the hash is known; nothing else yet
//   partial  → fetch-post finished; caption + coverUrl available
//   done     → extraction finished; places + model present
//   error    → terminal failure; code carries the reason
export const orchestratorStateSchema = z.object({
  contentHash: z.string().regex(HEX_64),
  status: z.enum(['pending', 'partial', 'done', 'error']),
  caption: z.string().optional(),
  coverUrl: z.string().url().optional(),
  videoPresent: z.boolean().optional(),
  places: z.array(placeSchema).optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type OrchestratorState = z.infer<typeof orchestratorStateSchema>;
