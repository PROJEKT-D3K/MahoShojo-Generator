import { z } from './zod';

// Public JSON feedback uses finite numbers. Unlike the former Web zod/v3 parser,
// non-finite values are invalid; negative, fractional and large finite values remain valid.

export type GenerationRankingQueue = 'strict' | 'free';

export type GenerationRankingQueueResult = {
  eligible: boolean;
  ineligibleReasons: string[];
  eventStatus: 'missing' | 'pending' | 'applied' | 'skipped' | 'failed';
  skipReason: string | null;
  rating: number | null;
  games: number | null;
  tier: string | null;
  delta: number | null;
  rank: number | null;
  total: number | null;
  rankDelta: number | null;
};

export type GenerationRankingParticipant = {
  displayName: string;
  entityType: 'data_card' | 'preset' | 'unknown';
  entityId: string | null;
  entityKey: string | null;
  dataCardId: string | null;
  presetId: string | null;
  techScore: number | null;
  techLevel: string | null;
  queues: Record<GenerationRankingQueue, GenerationRankingQueueResult>;
};

export type PublicGenerationRankingSnapshot = {
  status: string | null;
  combatantCount: number | null;
};

export type GenerationRankingResponse =
  | {
      success: true;
      generationId: string;
      state: 'pending';
      message: string;
    }
  | {
      success: true;
      generationId: string;
      state: 'ready';
      snapshot: PublicGenerationRankingSnapshot;
      participants: GenerationRankingParticipant[];
    }
  | {
      success: false;
      generationId: string;
      error: string;
    };

const GenerationRankingQueueResultSchema: z.ZodType<GenerationRankingQueueResult> = z.object({
  eligible: z.boolean(),
  ineligibleReasons: z.array(z.string()),
  eventStatus: z.enum(['missing', 'pending', 'applied', 'skipped', 'failed']),
  skipReason: z.string().nullable(),
  rating: z.number().nullable(),
  games: z.number().nullable(),
  tier: z.string().nullable(),
  delta: z.number().nullable(),
  rank: z.number().nullable(),
  total: z.number().nullable(),
  rankDelta: z.number().nullable(),
});

const GenerationRankingParticipantSchema: z.ZodType<GenerationRankingParticipant> = z.object({
  displayName: z.string(),
  entityType: z.enum(['data_card', 'preset', 'unknown']),
  entityId: z.string().nullable(),
  entityKey: z.string().nullable(),
  dataCardId: z.string().nullable(),
  presetId: z.string().nullable(),
  techScore: z.number().nullable(),
  techLevel: z.string().nullable(),
  queues: z.object({
    strict: GenerationRankingQueueResultSchema,
    free: GenerationRankingQueueResultSchema,
  }),
});

const NonEmptyGenerationIdSchema = z.string().refine((value) => value.trim().length > 0);

export const GenerationRankingResponseSchema: z.ZodType<GenerationRankingResponse> = z.union([
  z.object({
    success: z.literal(true),
    generationId: NonEmptyGenerationIdSchema,
    state: z.literal('pending'),
    message: z.string(),
  }),
  z.object({
    success: z.literal(true),
    generationId: NonEmptyGenerationIdSchema,
    state: z.literal('ready'),
    snapshot: z.object({
      status: z.string().nullable(),
      combatantCount: z.number().nullable(),
    }),
    participants: z.array(GenerationRankingParticipantSchema),
  }),
  z.object({
    success: z.literal(false),
    generationId: NonEmptyGenerationIdSchema,
    error: z.string(),
  }),
]);

export const parseGenerationRankingResponse = (
  input: unknown,
): GenerationRankingResponse | null => {
  const result = GenerationRankingResponseSchema.safeParse(input);
  return result.success ? result.data : null;
};

export const requireGenerationRankingResponse = (
  input: unknown,
): GenerationRankingResponse => {
  const parsed = parseGenerationRankingResponse(input);
  if (!parsed) throw new TypeError('ARENA_GENERATION_RANKING_RESPONSE_INVALID');
  return parsed;
};
