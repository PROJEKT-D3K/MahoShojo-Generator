import { z } from './zod';

/** A bounded advisory read, not a ticket or authority for generation/settlement. */
export const STRICT_PREFLIGHT_VERSION = 'desktop-strict-preflight-v1';
export const STRICT_PREFLIGHT_MAX_BYTES = 64 * 1024;
const userId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(256);
const identifier = z.string().trim().min(1).max(256);
const date = z.string().max(128).nullable();
export const StrictPreflightInputSchema = z.object({
  battleMode: z.enum(['classic', 'kizuna', 'daily', 'scenario']),
  language: z.string().min(1).max(64),
  storyLength: z.enum(['default', 'short', 'standard', 'detailed', 'long']),
  scenarioEnabled: z.boolean(), scenarioFileName: identifier.nullable(),
  auxScenarioCount: count, materialCount: count,
  questionnaireLoreEnabled: z.boolean(), questionnaireLoreIds: z.array(identifier).max(20),
  settings: z.object({
    userGuidance: z.string().max(200), readArenaHistory: z.boolean(),
    readCurrentState: z.boolean(), readNarrativeHistory: z.boolean(),
  }).strict(),
  combatants: z.array(z.object({
    isPreset: z.boolean(), filename: identifier.nullable(), sourceDataCardId: identifier.nullable(),
    characterGuidance: z.string().max(2000).nullable(),
  }).strict()).max(32),
  adjudicationEventCount: count,
  customProvider: z.object({ providerId: identifier, modelId: identifier }).strict().optional(),
}).strict();
export type StrictPreflightInput = z.infer<typeof StrictPreflightInputSchema>;
export const DesktopStrictPreflightRequestSchema = z.object({ expectedUserId: userId, body: StrictPreflightInputSchema }).strict();
export type DesktopStrictPreflightRequest = z.infer<typeof DesktopStrictPreflightRequestSchema>;
export const DesktopStrictPreflightResponseSchema = z.object({
  success: z.literal(true), preflightVersion: z.literal(STRICT_PREFLIGHT_VERSION), viewerUserId: userId,
  willCount: z.boolean(), reasons: z.array(z.string().min(1).max(200)).max(64),
  range: z.object({
    absDiff: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER), maxAbsDiff: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    exceededBy: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    aRating: z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    bRating: z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    aGames: natural, bGames: natural, lowGamesTightened: z.boolean(),
  }).strict().nullable(),
  daily: z.object({ used: natural.nullable(), limit: natural, exceeded: z.boolean().nullable(), sinceIso: date }).strict(),
  pair: z.object({
    used: natural.nullable(), limit: natural, exceeded: z.boolean().nullable(), recentDeduped: z.boolean().nullable(),
    recentAppliedAtIso: date, nextEligibleAtIso: date, windowMinutes: natural,
  }).strict(),
}).strict().refine(value => value.willCount === (value.reasons.length === 0), '预检判断与原因不一致');
export type DesktopStrictPreflightResponse = z.infer<typeof DesktopStrictPreflightResponseSchema>;
