import {
  ARENA_HOSTED_STREAM_COMMAND, getArenaHostedStreamCompletionCheck, getArenaHostedFailedStreamCheck,
  normalizeArenaHostedBridgeFailure, type ArenaHostedBridgeError, type ArenaHostedFailedStreamSeal,
} from './arena-hosted-bridge';
import { normalizeNativeInvokeRejection } from './native-channel-delivery';
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
  settleFailed: (signal?: AbortSignal) => Promise<ArenaHostedFailedStreamSeal | null>;
} => {
  const pending = new Set<Promise<ArenaHostedNativeSettleResult>>();
  let latest: { observed: Promise<ArenaHostedNativeSettleResult>; checkCompletion?: () => Promise<ArenaHostedBridgeError | null>;
    checkFailed?: () => Promise<ArenaHostedFailedStreamSeal | null> } | undefined;
  const trackedInvoke: InvokeFn = (command, args) => {
    const checkCompletion = getArenaHostedStreamCompletionCheck(args);
    let invocation: Promise<unknown>;
    try { invocation = Promise.resolve(invoke(command, args)); }
    catch (cause) { invocation = Promise.reject(cause); }
    if (command === ARENA_HOSTED_STREAM_COMMAND) {
      const observed = invocation.then<ArenaHostedNativeSettleResult, ArenaHostedNativeSettleResult>(
        () => ({ status: 'succeeded' }),
        (cause: unknown) => ({ status: 'failed', error: normalizeArenaHostedBridgeFailure(normalizeNativeInvokeRejection(cause)) }),
      );
      latest = { observed, checkCompletion, checkFailed: getArenaHostedFailedStreamCheck(args) }; pending.add(observed);
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
    const failure = await current.checkCompletion?.();
    return failure ? { status: 'failed', error: failure } : result;
  };
  return { invoke: trackedInvoke, settleFailed: (signal) => new Promise(resolve => {
    const finish = (result: ArenaHostedFailedStreamSeal | null) => { signal?.removeEventListener('abort', abort); resolve(result); };
    const abort = () => finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void (async () => {
      while (pending.size) await Promise.all([...pending]);
      const current = latest;
      if (!current || (await current.observed).status !== 'succeeded') return null;
      return current.checkFailed?.() ?? null;
    })().then(finish);
  }), settle: (signal) => new Promise(resolve => {
    const finish = (result: ArenaHostedNativeSettleResult) => { signal?.removeEventListener('abort', abort); resolve(result); };
    const abort = () => finish({ status: 'aborted' });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else void settled().then(finish);
  }) };
};
