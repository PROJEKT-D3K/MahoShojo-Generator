import type { ArenaGenerationSubscription } from './service';
import { encodeGenerationSseEvent, projectArenaGenerationEventForClient } from './sse';

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE = new TextEncoder().encode(': keepalive\n\n');

/** Transport comments keep an idle subscriber connected without creating replay events. */
export const subscriptionToSseResponse = (subscription: ArenaGenerationSubscription): Response => {
  const reader = subscription.events.getReader();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const clearHeartbeat = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Flush the response headers even when the model has not produced its first event.
      controller.enqueue(KEEPALIVE);
      heartbeat = setInterval(() => {
        // At most one unconsumed comment; slow readers must not accumulate timer output.
        if (!closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(KEEPALIVE);
      }, KEEPALIVE_INTERVAL_MS);
      (heartbeat as unknown as { unref?: () => void }).unref?.();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          closed = true;
          clearHeartbeat();
          reader.releaseLock();
          controller.close();
          return;
        }
        if (next.value.type === 'done' || next.value.type === 'error') clearHeartbeat();
        controller.enqueue(encodeGenerationSseEvent(projectArenaGenerationEventForClient(next.value)));
      } catch (error) {
        if (closed) return;
        closed = true;
        clearHeartbeat();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      clearHeartbeat();
      try {
        // Cancels only this replay subscriber, never the generation producer.
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const headers = new Headers({
    'Cache-Control': 'no-cache, no-transform',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
    ...subscription.headers,
  });
  return new Response(body, { status: 200, headers });
};
