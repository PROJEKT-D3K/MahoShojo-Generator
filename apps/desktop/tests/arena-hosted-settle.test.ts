import { describe, expect, it, vi } from 'vitest';
import { createArenaHostedNativeSettle } from '../src/platform/arena-hosted-settle';
import { ARENA_HOSTED_STREAM_COMMAND } from '../src/platform/arena-hosted-bridge';

const deferred = () => {
  let resolve!: () => void, reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
describe('Native Hosted invocation completion fence', () => {
  it('waits for the actual invoke and does not mistake allSettled cleanup for success', async () => {
    const run = deferred(), tracker = createArenaHostedNativeSettle(() => run.promise);
    void tracker.invoke(ARENA_HOSTED_STREAM_COMMAND).catch(() => undefined);
    const finish = vi.fn(), settled = tracker.settle().then(value => { finish(value); return value; });
    await Promise.resolve(); expect(finish).not.toHaveBeenCalled();
    run.reject(new Error('private-canary'));
    const result = await settled;
    expect(result).toMatchObject({ status: 'failed', error: { code: 'transport' } });
    if (result.status !== 'failed') throw new Error('expected Native failure');
    expect(result.error.message).not.toContain('private-canary');
  });
  it('retains a rejection which happened before settle was called', async () => {
    const tracker = createArenaHostedNativeSettle(async () => { throw new Error('failed early'); });
    await tracker.invoke(ARENA_HOSTED_STREAM_COMMAND).catch(() => undefined);
    expect(await tracker.settle()).toMatchObject({ status: 'failed' });
  });
  it('uses the final recovered subscription while still waiting for any earlier Native guard', async () => {
    const old = deferred(), current = deferred(); let calls = 0;
    const tracker = createArenaHostedNativeSettle(() => calls++ ? current.promise : old.promise);
    void tracker.invoke(ARENA_HOSTED_STREAM_COMMAND).catch(() => undefined);
    void tracker.invoke(ARENA_HOSTED_STREAM_COMMAND);
    const finish = vi.fn(), settled = tracker.settle().then(value => { finish(value); return value; });
    current.resolve(); await Promise.resolve(); await Promise.resolve(); expect(finish).not.toHaveBeenCalled();
    old.reject(new Error('superseded by C0 recovery'));
    expect(await settled).toEqual({ status: 'succeeded' });
  });
  it('does not let an earlier success replace the latest failed subscription', async () => {
    const tracker = createArenaHostedNativeSettle(vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('last failed')));
    await tracker.invoke(ARENA_HOSTED_STREAM_COMMAND);
    await tracker.invoke(ARENA_HOSTED_STREAM_COMMAND).catch(() => undefined);
    expect(await tracker.settle()).toMatchObject({ status: 'failed' });
  });
  it('aborts only the wait and keeps the original late failure for subsequent observation', async () => {
    const run = deferred(), tracker = createArenaHostedNativeSettle(() => run.promise), abort = new AbortController();
    void tracker.invoke(ARENA_HOSTED_STREAM_COMMAND).catch(() => undefined);
    const settled = tracker.settle(abort.signal); abort.abort(); expect(await settled).toEqual({ status: 'aborted' });
    run.reject(new Error('late failure')); expect(await tracker.settle()).toMatchObject({ status: 'failed' });
  });
  it('does not track unrelated control or detach calls', async () => {
    const tracker = createArenaHostedNativeSettle(() => new Promise(() => undefined));
    void tracker.invoke('arena_hosted_detach'); expect(await tracker.settle()).toEqual({ status: 'succeeded' });
  });
});
