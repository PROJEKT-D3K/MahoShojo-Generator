/**
 * native IPC 无法中途取消已发出的 HTTP；abort 的语义是「调用方不再认领结果」。
 * 这里把它物化成 rejection，让共享 hooks 的 `signal.aborted` 检查继续成立。
 */
export function withReadAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      // IPC 可能已经开始；即使不再认领结果，也要处理晚到拒绝。
      void promise.catch(() => undefined);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (cause) => { signal.removeEventListener('abort', onAbort); reject(cause); },
    );
  });
}
