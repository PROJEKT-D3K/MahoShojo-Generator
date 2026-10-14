/** Tea-only terminal evidence. Missing/rejected/late SDK evidence never means a normal stop. */
export const resolveMagicTeaPartyFinishReason = async (
  promise: Promise<unknown> | undefined, signal?: AbortSignal, timeoutMs = 1500
): Promise<string | null> => {
  if (!promise || signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const reason = await Promise.race([
      promise.catch(() => null),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        onAbort = () => resolve(null);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    return !signal?.aborted && typeof reason === 'string' ? reason : null;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
};

/** Preserve the existing SSE bytes and ordering; insert evidence immediately before its first done. */
export const withMagicTeaPartyCompletionEvidence = (
  response: Response, finishReasonPromise?: Promise<unknown>, signal?: AbortSignal
): Response => {
  if (!response.body) return response;
  // Attach rejection handling immediately, even if the stream fails before reaching done.
  const reasonPromise = finishReasonPromise?.catch(() => null);
  let buffered = new Uint8Array(0);
  let emitted = false;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const joined = new Uint8Array(buffered.length + chunk.length);
      joined.set(buffered); joined.set(chunk, buffered.length); buffered = joined;
      let start = 0;
      for (let index = 0; index < buffered.length - 1; index += 1) {
        if (buffered[index] !== 10 || buffered[index + 1] !== 10) continue;
        const block = buffered.slice(start, index + 2);
        if (!emitted && /^event: done$/m.test(decoder.decode(block))) {
          emitted = true;
          const finishReason = await resolveMagicTeaPartyFinishReason(reasonPromise, signal);
          controller.enqueue(encoder.encode(`event: tea_completion\ndata: ${JSON.stringify({ finishReason })}\n\n`));
        }
        controller.enqueue(block);
        start = index + 2;
        index += 1;
      }
      buffered = buffered.slice(start);
    },
    flush(controller) { if (buffered.length) controller.enqueue(buffered); },
  });
  return new Response(response.body.pipeThrough(transform), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
};
