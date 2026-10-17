const RECEIPT_COMMANDS = new Set(['stream_direct_ai', 'stream_target_ai', 'arena_hosted_stream']);

/** Test fixture adapter for the command receipt normally returned by Tauri.
 * Counts callbacks actually delivered by the fixture, without replacing its Channel
 * identity. Protocol-validation tests should pass malformed receipts directly instead. */
export function withFixtureStreamReceipt<Args extends unknown[]>(invoke: (...args: Args) => unknown) {
  return async (...args: Args): Promise<unknown> => {
    if (!RECEIPT_COMMANDS.has(String(args[0]))) return invoke(...args);
    const input = args[1] as { request?: { requestId?: unknown }; onEvent?: { onmessage?: (event: unknown) => void } } | undefined;
    const requestId = input?.request?.requestId;
    const channel = input?.onEvent;
    const onmessage = channel?.onmessage;
    if (typeof requestId !== 'string' || !channel || typeof onmessage !== 'function') {
      throw new Error('Stream receipt fixture requires a request ID and initialized Channel');
    }
    let channelEventCount = 0;
    const countDelivered = (event: unknown) => {
      onmessage.call(channel, event);
      channelEventCount += 1;
    };
    channel.onmessage = countDelivered;
    try {
      await invoke(...args);
      return { requestId, channelEventCount };
    } finally {
      if (channel.onmessage === countDelivered) channel.onmessage = onmessage;
    }
  };
}
