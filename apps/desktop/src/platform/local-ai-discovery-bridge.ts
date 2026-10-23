import {
  LocalAiDiscoveryErrorCodeSchema,
  LocalAiDiscoveryRequestSchema,
  LocalAiDiscoveryResponseSchema,
  type LocalAiDiscoveryRequest,
  type LocalAiDiscoveryResponse,
} from '@mahoshojo/contracts/local-ai-discovery';

export type LocalAiDiscoveryInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export class LocalAiDiscoveryError extends Error {
  constructor(readonly code: string) { super(`本机服务检查失败（${code}）`); this.name = 'LocalAiDiscoveryError'; }
}
const aborted = () => new DOMException('本机服务检查已取消', 'AbortError');

/** Abort both releases the UI and asks Native to drop HTTP. A pre-registration miss is bounded by Native's total budget. */
export async function discoverLocalAi(
  invoke: LocalAiDiscoveryInvoke,
  input: LocalAiDiscoveryRequest,
  signal: AbortSignal,
): Promise<LocalAiDiscoveryResponse> {
  const request = LocalAiDiscoveryRequestSchema.parse(input);
  if (signal.aborted) throw aborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      action();
    };
    const cancel = () => {
      // Never expose an IPC error or interpret a missed cancellation as successful upstream cancellation.
      void Promise.resolve().then(() => invoke('cancel_local_ai_discovery', { request: { requestId: request.requestId } })).catch(() => undefined);
      finish(() => reject(aborted()));
    };
    signal.addEventListener('abort', cancel, { once: true });
    void (async () => invoke('discover_local_ai', { request }))().then(raw => {
      if (settled) return;
      const parsed = LocalAiDiscoveryResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.requestId !== request.requestId) {
        finish(() => reject(new LocalAiDiscoveryError('invalid-response')));
        return;
      }
      finish(() => resolve(parsed.data));
    }, cause => {
      const code = LocalAiDiscoveryErrorCodeSchema.safeParse(
        cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined,
      );
      finish(() => reject(new LocalAiDiscoveryError(code.success ? code.data : 'failed')));
    });
  });
}
