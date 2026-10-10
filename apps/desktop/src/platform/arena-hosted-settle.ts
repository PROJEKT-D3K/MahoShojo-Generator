import {
  ARENA_HOSTED_STREAM_COMMAND, getArenaHostedStreamCompletionCheck, normalizeArenaHostedBridgeFailure, type ArenaHostedBridgeError,
} from './arena-hosted-bridge';
import type { InvokeFn } from './cloud-bridge';

export type ArenaHostedNativeSettleResult =
  | { status: 'succeeded' }
  | { status: 'failed'; error: ArenaHostedBridgeError }
  | { status: 'aborted' };

/** C0 can finish from SSE before Native releases its SubscriptionGuard. Keep that completion
 * separate from invocation success, including rejections arriving after the last Channel event. */
export const createArenaHostedNativeSettle = (invoke: InvokeFn): {
  invoke: InvokeFn;
  settle: (signal?: AbortSignal) => Promise<ArenaHostedNativeSettleResult>;
} => {
  const pending = new Set<Promise<ArenaHostedNativeSettleResult>>();
  let latest: { observed: Promise<ArenaHostedNativeSettleResult>; checkCompletion?: () => ArenaHostedBridgeError | null } | undefined;
  const trackedInvoke: InvokeFn = (command, args) => {
    const checkCompletion = getArenaHostedStreamCompletionCheck(args);
    let invocation: Promise<unknown>;
    try { invocation = Promise.resolve(invoke(command, args)); }
    catch (cause) { invocation = Promise.reject(cause); }
    if (command === ARENA_HOSTED_STREAM_COMMAND) {
      const observed = invocation.then<ArenaHostedNativeSettleResult, ArenaHostedNativeSettleResult>(
        () => ({ status: 'succeeded' }),
        (cause: unknown) => ({ status: 'failed', error: normalizeArenaHostedBridgeFailure(cause) }),
      );
      latest = { observed, checkCompletion }; pending.add(observed);
      void observed.then(() => pending.delete(observed));
    }
    return invocation;
  };
  const settled = async (): Promise<ArenaHostedNativeSettleResult> => {
    while (pending.size) await Promise.all([...pending]);
    // A failed create/older subscription may have been recovered by C0. Only the last actual
    // stream invoke proves the final subscription succeeded; all older guards must be released.
    if (!latest) return { status: 'succeeded' };
    const current = latest, result = await current.observed;
    if (result.status !== 'succeeded') return result;
    const failure = current.checkCompletion?.();
    return failure ? { status: 'failed', error: failure } : result;
  };
  return { invoke: trackedInvoke, settle: (signal) => new Promise(resolve => {
    const finish = (result: ArenaHostedNativeSettleResult) => { signal?.removeEventListener('abort', abort); resolve(result); };
    const abort = () => finish({ status: 'aborted' });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else void settled().then(finish);
  }) };
};
