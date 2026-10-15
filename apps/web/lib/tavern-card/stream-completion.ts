import {
  TavernFinishReasonSchema,
  type TavernCompletionDone,
} from '@mahoshojo/contracts/tavern-completion';

/** Catch provider rejection before body consumption, including when that body later fails. */
export const createTavernCompletionPayloadResolver = (
  finishReasonPromise: Promise<unknown> | undefined,
  signal: AbortSignal,
): (() => Promise<Omit<TavernCompletionDone, 'ok'>>) => {
  const reasonPromise = finishReasonPromise?.then((value) => {
    const parsed = TavernFinishReasonSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }, () => null);

  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const finishReason = !reasonPromise || signal.aborted ? null : await Promise.race([
        reasonPromise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1_500);
          onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return { tavernCompletion: { version: 1, finishReason: signal.aborted ? null : finishReason } };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };
};
