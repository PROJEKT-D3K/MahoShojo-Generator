import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channel } from '@tauri-apps/api/core';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { createDesktopAiExecutionPort } from '../src/platform/desktop-ai-execution';
import { openArenaHostedStream } from '../src/platform/arena-hosted-bridge';
import { createArenaHostedNativeSettle } from '../src/platform/arena-hosted-settle';
import { invokeWithChannelDelivery, NATIVE_CHANNEL_DRAIN_TIMEOUT_MS } from '../src/platform/native-channel-delivery';
import { executeNameGeneration } from '../src/features/name/generation';
import { executeTeaDirect } from '../src/features/magic-tea-party/direct';

// Use Tauri's actual Channel index buffering. Its >=8 KiB native deliveries fetch
// independently of the command response; releasing this queue is an explicit gate,
// not a timer intended to win a scheduling race.
function nativeChannel() {
  const callbacks = new Map<number, (value: unknown) => void>();
  let serial = 0;
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {
    transformCallback: (callback: (value: unknown) => void) => { callbacks.set(++serial, callback); return serial; },
    unregisterCallback: (id: number) => callbacks.delete(id),
  } });
  const channel = new Channel<unknown>();
  return { channel, deliver: (index: number, message: unknown) => callbacks.get(channel.id)?.({ index, message }),
    end: (index: number) => callbacks.get(channel.id)?.({ index, end: true }) };
}
const commandTurn = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Native Channel completion is independent from invoke completion', () => {
  it('Direct retains the terminal fetched after its native command has resolved', async () => {
    const peer = nativeChannel();
    const request: AiExecutionRequest = { requestId: 'channel-delivery', contractVersion: 1, mode: 'direct-local', messages: [{ role: 'user', content: 'test' }] };
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    const text = 'x'.repeat(9000);
    const terminal: AiStreamEvent = { ...identity, type: 'result', sequence: 2,
      result: { ...identity, status: 'completed', output: { text }, finishReason: 'stop' } };
    const port = createDesktopAiExecutionPort({ profileId: 'fixture', createChannel: () => peer.channel as Channel<AiStreamEvent>,
      invoke: async () => {
        peer.deliver(0, { ...identity, type: 'started', sequence: 0 });
        // An outstanding large fetch delays index 1. Small later frames may arrive
        // first; the actual Tauri Channel holds them until the missing index arrives.
        peer.end(3);
        return { requestId: request.requestId, channelEventCount: 3 };
      } });
    const seen: AiStreamEvent[] = [];
    const consumed = (async () => { for await (const event of port.stream(request, new AbortController().signal)) seen.push(event); })();
    await commandTurn();
    peer.deliver(2, terminal);
    peer.deliver(1, { ...identity, type: 'text-delta', sequence: 1, delta: text });
    await consumed;
    expect(seen.at(-1)?.type).toBe('result');
    expect(seen).toHaveLength(3);
  });

  it.each([false, true])('Hosted drains delayed data after invoke success (delayed response: %s)', async delayedResponse => {
    const peer = nativeChannel();
    const request = { operation: 'create-stream' as const, product: 'battle' as const, requestId: 'channel-delivery-hosted', actor: { kind: 'anonymous' as const },
      body: { reportFormat: 'web' as const, combatants: [{ name: 'A' }, { name: 'B' }], mode: 'classic' as const, writeArenaHistory: false, writeCurrentState: false } };
    const response = { kind: 'response', requestId: request.requestId, sequence: 0, status: 200,
      generationId: `arena_${'a'.repeat(64)}`, generationRequestId: request.requestId, metadataState: 'missing', recoveryCredentialState: 'stored' };
    const text = `id: 1-0\nevent: markdown\ndata: ${JSON.stringify({ chunk: 'x'.repeat(9000) })}\n\n`;
    const done = 'id: 2-0\nevent: done\ndata: {"status":"completed","ok":true}\n\n';
    const opened = openArenaHostedStream(async () => {
      if (!delayedResponse) peer.deliver(0, response);
      peer.deliver(2, { kind: 'sse-fragment', requestId: request.requestId, sequence: 2, text: done, final: true });
      peer.deliver(3, { kind: 'stream-end', requestId: request.requestId, sequence: 3 });
      peer.end(4);
      return { requestId: request.requestId, channelEventCount: 4 };
    }, request, { createChannel: () => peer.channel });
    const consumed = opened.then(result => result.text()).then(value => ({ value }), error => ({ error }));
    await commandTurn();
    if (delayedResponse) peer.deliver(0, response);
    peer.deliver(1, { kind: 'sse-fragment', requestId: request.requestId, sequence: 1, text, final: true });
    const result = await consumed;
    expect(result).not.toHaveProperty('error');
    expect('value' in result && result.value).toBe(text + done);
  });
});

describe('request-bound Channel completion receipt', () => {
  const requestId = 'receipt-request';
  it.each([undefined, null, {}, { requestId, channelEventCount: -1 }, { requestId, channelEventCount: 1.5 },
    { requestId, channelEventCount: Number.MAX_SAFE_INTEGER + 1 }, { requestId: 'other', channelEventCount: 0 },
    { requestId, channelEventCount: 0, extra: 'private' }])('rejects invalid or old Native receipt %# without accepting EOF', async receipt => {
    await expect(invokeWithChannelDelivery(async () => receipt, 'stream_direct_ai', { onEvent: {} }, requestId))
      .rejects.toMatchObject({ code: 'ipc-receipt-invalid' });
  });
  it.each(['sync', 'async'] as const)('classifies only opaque invoke %s rejection without exposing its text', async mode => {
    const invoke = () => { if (mode === 'sync') throw 'PRIVATE-INVOKE-CANARY'; return Promise.reject('PRIVATE-INVOKE-CANARY'); };
    const error = await invokeWithChannelDelivery(invoke, 'stream_direct_ai', { onEvent: {} }, requestId).catch(cause => cause);
    expect(error).toMatchObject({ code: 'native-invoke-rejected' });
    expect(String(error) + JSON.stringify(error)).not.toContain('PRIVATE');
  });
  it('does not relabel an opaque Channel handler failure as an invoke rejection', async () => {
    const channel = { onmessage: () => { throw 'PRIVATE-HANDLER-CANARY'; } };
    await expect(invokeWithChannelDelivery(async () => {
      channel.onmessage(); return { requestId, channelEventCount: 1 };
    }, 'stream_direct_ai', { onEvent: channel }, requestId)).rejects.toBe('PRIVATE-HANDLER-CANARY');
  });
  it('rejects more delivered frames than the successful Native receipt records', async () => {
    const channel = { onmessage: (_value: number) => undefined };
    await expect(invokeWithChannelDelivery(async () => {
      channel.onmessage(1); channel.onmessage(2); return { requestId, channelEventCount: 1 };
    }, 'stream_direct_ai', { onEvent: channel }, requestId)).rejects.toMatchObject({ code: 'ipc-delivery-invalid' });
  });
  it('starts a bounded delivery deadline only after Native success', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(yes => { resolve = yes; });
    const finished = vi.fn();
    const result = invokeWithChannelDelivery(() => pending, 'stream_direct_ai', { onEvent: {} }, requestId)
      .then(finished, error => { finished(error); return error; });
    await vi.advanceTimersByTimeAsync(NATIVE_CHANNEL_DRAIN_TIMEOUT_MS * 2);
    expect(finished).not.toHaveBeenCalled();
    resolve({ requestId, channelEventCount: 1 });
    await vi.advanceTimersByTimeAsync(NATIVE_CHANNEL_DRAIN_TIMEOUT_MS - 1);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: 'ipc-delivery-timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a pending drain and ignores late frames without re-dispatch', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), onmessage = vi.fn(), channel = { onmessage };
    const invoke = vi.fn(async () => ({ requestId, channelEventCount: 1 }));
    const result = invokeWithChannelDelivery(invoke, 'stream_direct_ai', { onEvent: channel }, requestId, controller.signal)
      .catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); expect(await result).toMatchObject({ name: 'AbortError' });
    channel.onmessage('late'); expect(onmessage).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps separate receipts and queues for simultaneous requests', async () => {
    const first = { onmessage: vi.fn() }, second = { onmessage: vi.fn() };
    const done = vi.fn();
    const one = invokeWithChannelDelivery(async () => ({ requestId: 'one', channelEventCount: 1 }), 'stream_direct_ai', { onEvent: first }, 'one').then(done);
    const two = invokeWithChannelDelivery(async () => ({ requestId: 'two', channelEventCount: 1 }), 'stream_direct_ai', { onEvent: second }, 'two').then(done);
    await commandTurn(); first.onmessage('first'); await one;
    expect(done).toHaveBeenCalledTimes(1); second.onmessage('second'); await two;
    expect(done).toHaveBeenCalledTimes(2);
  });
  it('preserves a handler exception and a late Native rejection after terminal delivery', async () => {
    const failure = new Error('synthetic failure');
    const broken = { onmessage: () => { throw failure; } };
    await expect(invokeWithChannelDelivery(async () => {
      broken.onmessage(); return { requestId, channelEventCount: 1 };
    }, 'stream_direct_ai', { onEvent: broken }, requestId)).rejects.toBe(failure);
    const delivered = { onmessage: vi.fn() };
    await expect(invokeWithChannelDelivery(async () => {
      delivered.onmessage('terminal'); throw failure;
    }, 'stream_direct_ai', { onEvent: delivered }, requestId)).rejects.toBe(failure);
    expect(delivered.onmessage).toBeTypeOf('function');
  });
});

describe('shared Direct consumers explain local delivery failures', () => {
  it.each(['native-invoke-rejected', 'ipc-receipt-invalid', 'ipc-delivery-invalid', 'ipc-delivery-timeout'] as const)(
    'retains the controlled %s explanation without the raw Native message', async code => {
      const invoke = vi.fn(async () => { throw { code, message: 'PRIVATE-PROVIDER-VALUE' }; });
      const options = { invoke, profileId: 'fixture', createChannel: () => ({}) };
      const name = await executeNameGeneration(options, { realName: '测试', language: 'zh-CN' },
        { requestId: 'receipt-name', mode: 'direct-local', generationMode: 'non-stream' }, new AbortController().signal);
      expect(name).toMatchObject({ status: 'failed', code, rawText: '' });
      expect(JSON.stringify(name)).not.toContain('PRIVATE');
      if (name.status !== 'failed') throw new Error('expected controlled failure');
      expect(name.message).toContain(code === 'native-invoke-rejected' ? '原生调用被拒绝' : code === 'ipc-receipt-invalid' ? '完整重启' : code === 'ipc-delivery-timeout' ? '未完整送达' : '回执不一致');
      const tea = await executeTeaDirect(options, { requestId: 'receipt-tea', contractVersion: 1, mode: 'direct-local', messages: [{ role: 'user', content: 'test' }] },
        new AbortController().signal, () => undefined);
      expect(tea).toMatchObject({ completion: 'failed', rawText: '', message: name.message });
      expect(JSON.stringify(tea)).not.toContain('PRIVATE');
      expect(invoke).toHaveBeenCalledTimes(2);
    },
  );
  it('treats old Native void success as incompatible even if a valid model terminal was delivered', async () => {
    const request: AiExecutionRequest = { requestId: 'old-native', contractVersion: 1, mode: 'direct-local', messages: [{ role: 'user', content: 'test' }] };
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args!.onEvent as { onmessage: (event: AiStreamEvent) => void };
      channel.onmessage({ ...identity, type: 'started', sequence: 0 });
      channel.onmessage({ ...identity, type: 'result', sequence: 1, result: { ...identity, status: 'completed', output: { text: '' }, finishReason: 'stop' } });
      return undefined;
    });
    await expect(createDesktopAiExecutionPort({ invoke, profileId: 'fixture', createChannel: () => ({}) }).execute(request, new AbortController().signal))
      .rejects.toMatchObject({ code: 'ipc-receipt-invalid' });
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('opaque Native rejection after Hosted model completion', () => {
  it('keeps an unknown dispatch and the safe category through the same-invoke fence', async () => {
    const channel = { onmessage: (_value: unknown) => undefined };
    const request = { operation: 'create-stream' as const, product: 'battle' as const, requestId: 'opaque-native-rejection', actor: { kind: 'anonymous' as const },
      body: { reportFormat: 'web' as const, combatants: [{ name: 'A' }, { name: 'B' }], mode: 'classic' as const, writeArenaHistory: false, writeCurrentState: false } };
    let reject!: (cause: unknown) => void;
    const pending = new Promise<unknown>((_resolve, no) => { reject = no; });
    const invoke = vi.fn(() => {
      channel.onmessage({ kind: 'response', requestId: request.requestId, sequence: 0, status: 200,
        generationId: `arena_${'a'.repeat(64)}`, generationRequestId: request.requestId, metadataState: 'missing', recoveryCredentialState: 'stored' });
      channel.onmessage({ kind: 'sse-fragment', requestId: request.requestId, sequence: 1, final: true,
        text: 'id: 1-0\nevent: done\ndata: {"status":"completed","ok":true}\n\n' });
      channel.onmessage({ kind: 'stream-end', requestId: request.requestId, sequence: 2 });
      return pending;
    });
    const native = createArenaHostedNativeSettle(invoke);
    const response = await openArenaHostedStream(native.invoke, request, { createChannel: () => channel });
    await response.text(); reject('PRIVATE-LATE-NATIVE-CANARY');
    const settled = await native.settle();
    expect(settled).toMatchObject({ status: 'failed', error: { code: 'native-invoke-rejected', dispatchState: 'unknown', intentOwnership: 'unknown' } });
    expect(JSON.stringify(settled)).not.toContain('PRIVATE');
    if (settled.status !== 'failed') throw new Error('expected failed native invocation');
    expect(settled.error.message).not.toContain('PRIVATE'); expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('C0 reader completion retains the exact Channel drain fence', () => {
  it.each(['done', 'error'] as const)('waits for delayed stream-end after reader cancellation and Native receipt (%s)', async terminal => {
    const peer = nativeChannel();
    const request = { operation: 'create-stream' as const, product: 'battle' as const, requestId: 'delayed-end-request', actor: { kind: 'anonymous' as const },
      body: { reportFormat: 'web' as const, combatants: [{ name: 'A' }, { name: 'B' }], mode: 'classic' as const, writeArenaHistory: false, writeCurrentState: false } };
    const invoke = vi.fn(async (command: string) => {
      if (command !== 'arena_hosted_stream') return undefined;
      peer.deliver(0, { kind: 'response', requestId: request.requestId, sequence: 0, status: 200,
        generationId: `arena_${'a'.repeat(64)}`, generationRequestId: request.requestId, metadataState: 'missing', recoveryCredentialState: 'stored' });
      peer.deliver(1, { kind: 'sse-fragment', requestId: request.requestId, sequence: 1, final: true,
        text: terminal === 'done' ? 'id: 1-0\nevent: done\ndata: {"status":"completed","ok":true}\n\n'
          : 'id: 1-0\nevent: error\ndata: {"status":"failed","code":"AI_STREAM_INCOMPLETE"}\n\n' });
      return { requestId: request.requestId, channelEventCount: 3 };
    });
    const fence = createArenaHostedNativeSettle(invoke);
    const opened = await openArenaHostedStream(fence.invoke, request, { createChannel: () => peer.channel });
    const reader = opened.body!.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock();
    const finished = vi.fn();
    const result = (terminal === 'done' ? fence.settle() : fence.settleFailed()).then(value => { finished(value); return value; });
    await commandTurn(); expect(finished).not.toHaveBeenCalled();
    peer.deliver(2, { kind: 'stream-end', requestId: request.requestId, sequence: 2 }); peer.end(3);
    expect(await result).toEqual(terminal === 'done' ? { status: 'succeeded' } : { requestId: request.requestId, code: 'AI_STREAM_INCOMPLETE' });
  });
});
