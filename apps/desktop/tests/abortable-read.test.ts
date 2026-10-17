import { describe, expect, it, vi } from 'vitest';
import { withReadAbort } from '../src/platform/abortable-read';

const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('aborted Native read ownership', () => {
  it.each(['resolve', 'reject'] as const)('releases immediately while Native is pending, then ignores its late %s', async terminal => {
    const native = deferred<number>(), controller = new AbortController(), success = vi.fn();
    const read = withReadAbort(native.promise, controller.signal).then(success);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    if (terminal === 'resolve') native.resolve(1); else native.reject(new Error('late Native failure'));
    await Promise.resolve(); expect(success).not.toHaveBeenCalled();
  });
  it('handles an already aborted read without leaking a rejected Native promise', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(withReadAbort(Promise.reject(new Error('Native failure')), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('preserves a live read result', async () => {
    await expect(withReadAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});
