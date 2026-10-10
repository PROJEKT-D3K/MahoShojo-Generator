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
