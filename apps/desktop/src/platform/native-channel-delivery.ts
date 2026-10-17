export const NATIVE_CHANNEL_DRAIN_TIMEOUT_MS = 15_000;
export type NativeChannelDeliveryErrorCode = 'native-invoke-rejected' | 'ipc-receipt-invalid' | 'ipc-delivery-invalid' | 'ipc-delivery-timeout';
export class NativeChannelDeliveryError extends Error {
  constructor(readonly code: NativeChannelDeliveryErrorCode) {
    const messages: Record<NativeChannelDeliveryErrorCode, string> = {
      'native-invoke-rejected': '本机原生调用被拒绝，无法取得具体分类。请完整退出并确认界面与桌面程序来自同一版本；已收到的内容仍保留。',
      'ipc-receipt-invalid': '桌面界面与原生程序的流协议不匹配，请完整重启或重新安装同一版本客户端；不要重发原生成请求。',
      'ipc-delivery-invalid': '本机流消息与原生完成回执不一致，已保留收到的内容。',
      'ipc-delivery-timeout': '原生操作已结束，但本机流消息未完整送达。请先保存已收到的原文并检查客户端，不要直接重发。',
    };
    super(messages[code]); this.name = 'NativeChannelDeliveryError';
  }
}

// Use only at an invoke throw/reject boundary. Never inspect or retain opaque text.
export const normalizeNativeInvokeRejection = (cause: unknown): unknown =>
  typeof cause === 'string' ? new NativeChannelDeliveryError('native-invoke-rejected') : cause;

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Channel<T> = { onmessage?: (value: T) => void };

/** Native send queues a Channel message; command resolution does not acknowledge
 * its delivery. Tauri fetches large messages separately and orders those fetches
 * only within the Channel. A request-bound final count closes that transport gap.
 * The deadline starts after Native has finished, never while the model is working.
 * This is a local delivery failure deadline, not a sleep or a generation timeout. */
export const invokeWithChannelDelivery = <T>(
  invoke: Invoke, command: string, args: Record<string, unknown> & { onEvent: Channel<T> },
  requestId: string, signal?: AbortSignal, onAbortedMessage?: (event: T) => void,
): Promise<void> => new Promise((resolve, reject) => {
  let received = 0, expected: number | undefined, ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onmessage = args.onEvent.onmessage;
  const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  const fail = (cause: unknown) => { if (ended) return; ended = true; cleanup(); reject(cause); };
  const abort = () => fail(new DOMException('本机流接收已停止。', 'AbortError'));
  const complete = () => {
    if (ended || expected === undefined) return;
    if (received > expected) { fail(new NativeChannelDeliveryError('ipc-delivery-invalid')); return; }
    if (received === expected) { ended = true; cleanup(); resolve(); }
  };
  args.onEvent.onmessage = (event) => {
    if (ended) {
      // Direct cancellation may precede Native's request-registry insertion. Its
      // eventual started frame is still needed to cancel the paid upstream once.
      if (signal?.aborted) onAbortedMessage?.(event);
      return;
    }
    received += 1;
    if (expected !== undefined && received > expected) { fail(new NativeChannelDeliveryError('ipc-delivery-invalid')); return; }
    try { onmessage?.(event); } catch (cause) { fail(cause); return; }
    complete();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  let invocation: Promise<unknown>;
  try { invocation = Promise.resolve(invoke(command, args)); }
  catch (cause) { fail(normalizeNativeInvokeRejection(cause)); return; }
  void invocation.then((raw) => {
    if (ended) return;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { fail(new NativeChannelDeliveryError('ipc-receipt-invalid')); return; }
    const receipt = raw as Record<string, unknown>;
    if (Object.keys(receipt).length !== 2 || receipt.requestId !== requestId
      || !Number.isSafeInteger(receipt.channelEventCount) || Number(receipt.channelEventCount) < 0) {
      fail(new NativeChannelDeliveryError('ipc-receipt-invalid')); return;
    }
    expected = Number(receipt.channelEventCount);
    complete();
    if (!ended) timer = setTimeout(() => fail(new NativeChannelDeliveryError('ipc-delivery-timeout')), NATIVE_CHANNEL_DRAIN_TIMEOUT_MS);
  }, cause => fail(normalizeNativeInvokeRejection(cause)));
});
