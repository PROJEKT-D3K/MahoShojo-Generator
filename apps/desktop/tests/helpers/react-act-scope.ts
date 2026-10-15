import { act as reactAct } from 'react';

/** Drain React's real act queue before unmounting after a Vitest timeout. */
export function createReactActScope(signal: AbortSignal) {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const assertActive = () => {
    signal.throwIfAborted();
    if (closed) throw new Error('React test scope is closed');
  };
  return {
    async act<T>(callback: () => T | Promise<T>): Promise<T> {
      assertActive();
      const completion = Promise.resolve(reactAct(async () => callback()));
      pending.add(completion);
      try {
        const result = await completion;
        // Vitest aborts the test but cannot stop its promise. Do not resume past this act boundary.
        assertActive();
        return result;
      } finally {
        pending.delete(completion);
      }
    },
    async drain(): Promise<void> {
      closed = true;
      // Never race the queue: a late act must finish before the next root is mounted.
      await Promise.allSettled([...pending]);
    },
  };
}
