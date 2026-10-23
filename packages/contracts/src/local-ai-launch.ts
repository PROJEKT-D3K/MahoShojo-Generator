import { z } from './zod';
import { LocalAiDiscoveryServiceSchema } from './local-ai-discovery';

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const runtime = { contractVersion: z.literal(1), runtimeId: z.literal('ollama') };
/** Native owns executable identity, argv, environment and process handles. */
export const LocalAiLaunchRuntimeRequestSchema = z.object(runtime).strict();
export const LocalAiLaunchRequestSchema = z.object({ ...runtime, installationId: id, operationId: id }).strict();
export const LocalAiLaunchOperationRequestSchema = z.object({ ...runtime, operationId: id }).strict();
export const LocalAiLaunchErrorCodeSchema = z.enum([
  'invalid-request', 'busy', 'unsupported-platform', 'installation-not-found', 'installation-untrusted',
  'installation-changed', 'permission-denied', 'existing-process', 'invalid-operation', 'expired',
  'cancelled', 'port-in-use', 'spawn-failed', 'process-exited', 'ownership-unverified', 'timed-out',
  'stop-failed', 'failed',
]);
export const LocalAiLaunchInstallationSchema = z.object({
  installationId: id, source: z.enum(['default-location', 'registered-location']), product: z.literal('Ollama'),
}).strict();
export const LocalAiLaunchSnapshotSchema = z.object({
  ...runtime,
  state: z.enum(['idle', 'preparing', 'prepared', 'starting', 'ready', 'external', 'stopping', 'stopped', 'cancelled', 'failed']),
  operationId: id.optional(),
  installation: LocalAiLaunchInstallationSchema.optional(),
  service: LocalAiDiscoveryServiceSchema.optional(),
  errorCode: LocalAiLaunchErrorCodeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((value.state === 'idle') !== (value.operationId === undefined)) reject('Only idle has no operationId');
  if (value.state === 'idle' && (value.installation !== undefined || value.service !== undefined || value.errorCode !== undefined)) reject('Idle has no operation data');
  if (['prepared', 'starting', 'ready'].includes(value.state) && value.installation === undefined) reject('Installation is required');
  if (['preparing', 'stopped', 'cancelled', 'external'].includes(value.state) && value.installation !== undefined) reject('Installation is not allowed');
  if (['ready', 'external'].includes(value.state) !== (value.service !== undefined)) reject('Only ready/external has service');
  if ((value.state === 'failed') !== (value.errorCode !== undefined)) reject('Only failed has errorCode');
});
export type LocalAiLaunchRuntimeRequest = z.infer<typeof LocalAiLaunchRuntimeRequestSchema>;
export type LocalAiLaunchRequest = z.infer<typeof LocalAiLaunchRequestSchema>;
export type LocalAiLaunchOperationRequest = z.infer<typeof LocalAiLaunchOperationRequestSchema>;
export type LocalAiLaunchSnapshot = z.infer<typeof LocalAiLaunchSnapshotSchema>;
export type LocalAiLaunchErrorCode = z.infer<typeof LocalAiLaunchErrorCodeSchema>;
