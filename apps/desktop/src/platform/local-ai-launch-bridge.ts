import {
  LocalAiLaunchErrorCodeSchema, LocalAiLaunchOperationRequestSchema, LocalAiLaunchRequestSchema,
  LocalAiLaunchRuntimeRequestSchema, LocalAiLaunchSnapshotSchema,
  type LocalAiLaunchOperationRequest, type LocalAiLaunchRequest,
  type LocalAiLaunchRuntimeRequest, type LocalAiLaunchSnapshot,
} from '@mahoshojo/contracts/local-ai-launch';
import type { LocalAiDiscoveryInvoke } from './local-ai-discovery-bridge';

export class LocalAiLaunchError extends Error {
  constructor(readonly code: string, readonly operationId?: string) {
    super(`本次启动操作未确认（${code}）`); this.name = 'LocalAiLaunchError';
  }
}
const runtime: LocalAiLaunchRuntimeRequest = { contractVersion: 1, runtimeId: 'ollama' };
async function call(invoke: LocalAiDiscoveryInvoke, command: string,
  request: LocalAiLaunchRuntimeRequest | LocalAiLaunchOperationRequest | LocalAiLaunchRequest,
): Promise<LocalAiLaunchSnapshot> {
  const operationId = 'operationId' in request ? request.operationId : undefined;
  let raw: unknown;
  try { raw = await invoke(command, { request }); }
  catch (cause) {
    const code = LocalAiLaunchErrorCodeSchema.safeParse(cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined);
    throw new LocalAiLaunchError(code.success ? code.data : 'failed', operationId);
  }
  const parsed = LocalAiLaunchSnapshotSchema.safeParse(raw);
  if (!parsed.success || (operationId !== undefined && parsed.data.operationId !== operationId) ||
    ('installationId' in request && parsed.data.installation !== undefined && parsed.data.installation.installationId !== request.installationId)) {
    throw new LocalAiLaunchError('invalid-response', operationId);
  }
  return parsed.data;
}
/** No AbortSignal: callers retain late tickets and explicitly cancel the returned operation. */
export function prepareLocalAiLaunch(invoke: LocalAiDiscoveryInvoke, input: LocalAiLaunchRuntimeRequest = runtime) {
  return call(invoke, 'prepare_local_ai_launch', LocalAiLaunchRuntimeRequestSchema.parse(input));
}
/** Reads Native state and held-handle status, never service discovery or process enumeration. */
export function getLocalAiLaunchStatus(invoke: LocalAiDiscoveryInvoke, input: LocalAiLaunchRuntimeRequest = runtime) {
  return call(invoke, 'get_local_ai_launch_status', LocalAiLaunchRuntimeRequestSchema.parse(input));
}
export function startLocalAi(invoke: LocalAiDiscoveryInvoke, input: LocalAiLaunchRequest) {
  return call(invoke, 'start_local_ai', LocalAiLaunchRequestSchema.parse(input));
}
export function cancelLocalAiLaunch(invoke: LocalAiDiscoveryInvoke, input: LocalAiLaunchOperationRequest) {
  return call(invoke, 'cancel_local_ai_launch', LocalAiLaunchOperationRequestSchema.parse(input));
}
export function stopLocalAi(invoke: LocalAiDiscoveryInvoke, input: LocalAiLaunchOperationRequest) {
  return call(invoke, 'stop_local_ai', LocalAiLaunchOperationRequestSchema.parse(input));
}
