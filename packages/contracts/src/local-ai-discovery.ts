import { z } from './zod';
import { ProviderModelIdSchema } from './provider-target';

const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const profileId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const text = (max: number) => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const LocalAiDiscoveryTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('candidate'), candidateId: z.enum(['ollama', 'lm-studio']) }).strict(),
  z.object({ kind: z.literal('profile'), profileId }).strict(),
]);
export const LocalAiDiscoveryRequestSchema = z.object({
  contractVersion: z.literal(1), requestId, target: LocalAiDiscoveryTargetSchema,
}).strict();
export const LocalAiDiscoveryCancelRequestSchema = z.object({ requestId }).strict();
export const LocalAiDiscoveryErrorCodeSchema = z.enum([
  'invalid-request', 'busy', 'profile-not-found', 'profile-rejected', 'missing-secret', 'failed',
]);
export const LocalAiDiscoveryModelSchema = z.object({
  // ProviderModelIdSchema trims user input; a discovered wire ID must be preserved exactly.
  id: z.string().refine(value => value.trim() === value && ProviderModelIdSchema.safeParse(value).success),
  label: text(200).optional(),
  kind: z.enum(['llm', 'unknown']),
  loaded: z.enum(['yes', 'no', 'unknown']),
  execution: z.enum(['remote-indicated', 'unknown']),
}).strict();
export const LocalAiDiscoveryServiceSchema = z.object({
  protocol: z.enum(['ollama-native', 'lm-studio-native', 'openai-compatible']),
  state: z.enum(['reachable', 'no-models', 'no-compatible-models', 'auth-required', 'auth-rejected',
    'access-denied', 'unreachable', 'timed-out', 'unsupported-response', 'failed']),
  models: z.array(LocalAiDiscoveryModelSchema).max(256),
  version: text(128).optional(),
  errorCode: z.enum(['response-too-large', 'invalid-response', 'timed-out', 'unreachable', 'request-failed',
    'auth-rejected', 'auth-required', 'access-denied', 'unexpected-status', 'too-many-models']).optional(),
}).strict();
export const LocalAiDiscoveryResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ contractVersion: z.literal(1), requestId, outcome: z.literal('completed'), service: LocalAiDiscoveryServiceSchema }).strict(),
  z.object({ contractVersion: z.literal(1), requestId, outcome: z.literal('cancelled') }).strict(),
]);
export type LocalAiDiscoveryTarget = z.infer<typeof LocalAiDiscoveryTargetSchema>;
export type LocalAiDiscoveryRequest = z.infer<typeof LocalAiDiscoveryRequestSchema>;
export type LocalAiDiscoveryResponse = z.infer<typeof LocalAiDiscoveryResponseSchema>;
export type LocalAiDiscoveryService = z.infer<typeof LocalAiDiscoveryServiceSchema>;
export type LocalAiDiscoveryModel = z.infer<typeof LocalAiDiscoveryModelSchema>;
