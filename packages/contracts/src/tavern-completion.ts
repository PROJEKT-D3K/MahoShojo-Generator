import { z } from './zod';

/** Provider terminal evidence only; this does not authorize a completed card or a save. */
export const TAVERN_COMPLETION_HEADER = 'x-mahoshojo-tavern-completion';
export const TAVERN_COMPLETION_HEADER_VALUE = 'v1';
export const TAVERN_COMPLETION_PROTOCOL = 'tavern-completion';
export const TavernFinishReasonSchema = z.enum([
  'stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown',
]);
export type TavernFinishReason = z.infer<typeof TavernFinishReasonSchema>;

export const TavernCompletionSchema = z.object({
  version: z.literal(1),
  finishReason: TavernFinishReasonSchema.nullable(),
}).strict();
export const TavernCompletionDoneSchema = z.object({
  ok: z.literal(true),
  tavernCompletion: TavernCompletionSchema,
}).strict();
export type TavernCompletionDone = z.infer<typeof TavernCompletionDoneSchema>;

export const TavernCompletionCapabilitySchema = z.object({
  protocol: z.literal(TAVERN_COMPLETION_PROTOCOL),
  version: z.literal(1),
}).strict();

/** Invalid/legacy payloads return null; a valid null finishReason remains distinguishable. */
export const parseTavernCompletionDone = (payload: unknown): TavernCompletionDone | null => {
  const parsed = TavernCompletionDoneSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};
