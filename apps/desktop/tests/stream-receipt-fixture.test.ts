import { describe, expect, it, vi } from 'vitest';
import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';

describe('test-only stream command receipt fixture', () => {
  it.each(['stream_direct_ai', 'stream_target_ai', 'arena_hosted_stream'])('counts delivered frames and preserves arguments for %s', async command => {
    const onmessage = vi.fn();
    const channel = { onmessage };
    const args = { request: { requestId: 'fixture-request' }, onEvent: channel };
    const invoke = vi.fn(withFixtureStreamReceipt(async (_command: string, input: typeof args) => {
      expect(input).toBe(args);
      expect(input.onEvent).toBe(channel);
      input.onEvent.onmessage({ sequence: 0 });
      await Promise.resolve();
      input.onEvent.onmessage({ sequence: 1 });
    }));
    await expect(invoke(command, args)).resolves.toEqual({ requestId: 'fixture-request', channelEventCount: 2 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, args);
    expect(onmessage).toHaveBeenCalledTimes(2);
    expect(channel.onmessage).toBe(onmessage);
  });

  it('reports zero deliveries instead of inventing a terminal frame', async () => {
    const invoke = withFixtureStreamReceipt(async (_command: string, _args: unknown) => null);
    await expect(invoke('stream_direct_ai', { request: { requestId: 'empty' }, onEvent: { onmessage: vi.fn() } }))
      .resolves.toEqual({ requestId: 'empty', channelEventCount: 0 });
  });

  it('preserves Native rejection after delivery and restores the handler', async () => {
    const error = { code: 'native-failure' };
    const onmessage = vi.fn(), channel = { onmessage };
    const invoke = withFixtureStreamReceipt(async (_command: string, _args: unknown) => {
      channel.onmessage({ sequence: 0 });
      throw error;
    });
    await expect(invoke('arena_hosted_stream', { request: { requestId: 'failed' }, onEvent: channel })).rejects.toBe(error);
    expect(channel.onmessage).toBe(onmessage);
  });

  it('counts only callbacks that return successfully', async () => {
    const rejectedDelivery = new Error('delivery failed');
    const channel = { onmessage: vi.fn().mockImplementationOnce(() => { throw rejectedDelivery; }) };
    const invoke = withFixtureStreamReceipt(async (_command: string, _args: unknown) => {
      expect(() => channel.onmessage({ sequence: 0 })).toThrow(rejectedDelivery);
      channel.onmessage({ sequence: 1 });
    });
    await expect(invoke('stream_target_ai', { request: { requestId: 'delivery-count' }, onEvent: channel }))
      .resolves.toEqual({ requestId: 'delivery-count', channelEventCount: 1 });
  });

  it('leaves the six-family Hosted command and unrelated replies unchanged', async () => {
    const reply = { status: 200 };
    const invoke = withFixtureStreamReceipt(async (_command: string) => reply);
    for (const command of ['stream_hosted_ai', 'hosted_ai_request', 'cancel_direct_ai']) {
      await expect(invoke(command)).resolves.toBe(reply);
    }
  });
});
