import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DesktopArenaHostedStreamRequestSchema } from '@mahoshojo/contracts/desktop-arena-hosted';
import { createArenaHostedNativeSettle } from '../src/platform/arena-hosted-settle';
import { ARENA_HOSTED_STREAM_COMMAND, openArenaHostedStream, type ArenaHostedChannel } from '../src/platform/arena-hosted-bridge';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-arena-hosted.json', import.meta.url), 'utf8'));
const request = DesktopArenaHostedStreamRequestSchema.parse(fixture.validOperations[0]);
const generationId = `arena_${'a'.repeat(64)}`;
const wire = (event: string, data: unknown) => `id: 1-0\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function harness() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const invocation = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const channel: ArenaHostedChannel = { onmessage: () => undefined };
  const invoke = vi.fn(async (command: string) => command === ARENA_HOSTED_STREAM_COMMAND ? invocation : undefined);
  const native = createArenaHostedNativeSettle(invoke);
  const opened = openArenaHostedStream(native.invoke, request, { createChannel: () => channel });
  let sequence = 0;
  const send = (event: Record<string, unknown>) => channel.onmessage({ requestId: request.requestId, sequence: sequence++, ...event });
  send({ kind: 'response', status: 200, generationId, generationRequestId: request.requestId,
    metadataState: 'missing', recoveryCredentialState: 'stored' });
  const done = () => send({ kind: 'sse-fragment', final: true, text: wire('done', { status: 'completed', ok: true }) });
  return { opened, native, send, done, resolve, reject, invoke };
}

describe('same Native invocation SSE completion proof', () => {
  it('failure retention uses its own exact failed terminal, stream-end and successful invoke seal', async () => {
    const h = harness(), response = await h.opened;
    h.send({ kind: 'sse-fragment', final: true, text: wire('error', { status: 'failed', code: 'AI_STREAM_INCOMPLETE' }) });
    h.send({ kind: 'stream-end' }); await response.text();
    const observed = vi.fn(); const pending = h.native.settleFailed().then(value => { observed(value); return value; });
    await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    h.resolve(); expect(await pending).toEqual({ requestId: request.requestId, code: 'AI_STREAM_INCOMPLETE' });
    expect(await h.native.settle()).toMatchObject({ status: 'failed', error: { code: 'protocol' } });
  });
  it.each(['late-reject-before-close', 'late-reject-after-close', 'missing-end', 'sequence', 'identity', 'duplicate-terminal', 'late-policy', 'tail', 'unsafe-meta'] as const)(
    'refuses failure retention after %s through the actual bridge', async fault => {
      const h = harness(), response = await h.opened, reader = response.body!.getReader();
      if (fault === 'unsafe-meta') h.send({ kind: 'sse-fragment', final: true,
        text: 'id: 0-0\nevent: meta\ndata: {"parseOk":true,"meta":{"constructor":{}},"raw":"","rawTruncated":false}\n\n' });
      h.send({ kind: 'sse-fragment', final: true, text: wire('error', { status: 'failed', code: 'AI_STREAM_INCOMPLETE' }) });
      await reader.read();
      if (fault === 'late-reject-before-close') h.reject(new Error('private-early-native-error'));
      await reader.cancel().catch(() => undefined); reader.releaseLock();
      if (fault === 'sequence') h.send({ kind: 'stream-end', sequence: 90 });
      else if (fault === 'identity') h.send({ kind: 'stream-end', requestId: 'another-request' });
      else if (fault === 'duplicate-terminal' || fault === 'late-policy') h.send({ kind: 'sse-fragment', final: true,
        text: wire('error', { status: 'failed', code: fault === 'late-policy' ? 'AI_OUTPUT_FILTERED' : 'AI_STREAM_INCOMPLETE' }) });
      else if (fault === 'tail') h.send({ kind: 'sse-fragment', final: true, text: wire('markdown', { chunk: 'late' }) });
      if (fault !== 'missing-end' && fault !== 'sequence' && fault !== 'identity') h.send({ kind: 'stream-end' });
      if (fault === 'late-reject-after-close') h.reject(new Error('private-late-native-error'));
      else if (fault !== 'late-reject-before-close') h.resolve();
      expect(await h.native.settleFailed()).toBeNull();
    },
  );
  it.each(['missing-end', 'wrong-sequence', 'malformed', 'extra-sse', 'duplicate-end'] as const)(
    'retains %s failure after the done reader has already been cancelled', async fault => {
      const h = harness(), response = await h.opened, reader = response.body!.getReader();
      h.done(); expect((await reader.read()).done).toBe(false);
      await reader.cancel(); reader.releaseLock();
      if (fault === 'wrong-sequence') h.send({ kind: 'stream-end', sequence: 90 });
      else if (fault === 'malformed') h.send({ kind: 'invalid-ipc' });
      else if (fault === 'extra-sse') h.send({ kind: 'sse-fragment', final: true, text: wire('markdown', { chunk: 'late' }) });
      else if (fault === 'duplicate-end') { h.send({ kind: 'stream-end' }); h.send({ kind: 'stream-end' }); }
      h.resolve(); expect(await h.native.settle()).toMatchObject({ status: 'failed', error: { code: 'protocol' } });
    },
  );
  it('accepts only a valid end from the same cancelled-reader Channel and successful Native invocation', async () => {
    const h = harness(), response = await h.opened, reader = response.body!.getReader();
    h.done(); await reader.read(); await reader.cancel(); reader.releaseLock();
    h.send({ kind: 'stream-end' }); h.resolve(); expect(await h.native.settle()).toEqual({ status: 'succeeded' });
  });
  it('still rejects Native failure after the complete Channel proof', async () => {
    const h = harness(), response = await h.opened;
    h.done(); h.send({ kind: 'stream-end' }); await response.text();
    h.reject(new Error('late Native failure')); expect(await h.native.settle()).toMatchObject({ status: 'failed', error: { code: 'transport' } });
  });
  it('does not treat a well-framed stream-end without a successful done as completion', async () => {
    const h = harness(), response = await h.opened;
    h.send({ kind: 'sse-fragment', final: true, text: wire('markdown', { chunk: 'original' }) }); h.send({ kind: 'stream-end' });
    await response.text(); h.resolve(); expect(await h.native.settle()).toMatchObject({ status: 'failed', error: { code: 'protocol' } });
  });
});
