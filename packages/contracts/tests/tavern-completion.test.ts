import { describe, expect, it } from 'vitest';
import {
  TavernCompletionCapabilitySchema,
  TavernCompletionDoneSchema,
  parseTavernCompletionDone,
} from '@mahoshojo/contracts/tavern-completion';

const done = (finishReason: unknown) => ({ ok: true, tavernCompletion: { version: 1, finishReason } });

describe('Tavern provider completion evidence', () => {
  it.each(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown', null])(
    'preserves explicit provider terminal %s without inventing product completion', finishReason => {
      expect(parseTavernCompletionDone(done(finishReason))).toEqual(done(finishReason));
      expect(TavernCompletionDoneSchema.parse(done(finishReason))).not.toHaveProperty('completed');
    },
  );

  it.each([
    null, [], 'stop', { ok: true }, { tavernCompletion: { version: 1, finishReason: 'stop' } },
    { ...done('stop'), ok: false }, { ...done('stop'), ok: 'true' },
    { ok: true, teaCompletion: { version: 1, finishReason: 'stop' } },
    { ok: true, tavernCompletion: { version: '1', finishReason: 'stop' } },
    { ok: true, tavernCompletion: { version: 2, finishReason: 'stop' } },
    { ok: true, tavernCompletion: { version: 1 } },
    { ok: true, tavernCompletion: { version: 1, finishReason: 'stop', safetyPassed: true } },
    { ...done('stop'), completed: true }, done('STOP'), done('end_turn'), done(1), done(false), done({}),
  ])('rejects legacy, wrong namespace, unknown version and malformed fields: %j', payload => {
    expect(parseTavernCompletionDone(payload)).toBeNull();
  });

  it('limits capability to this protocol and version', () => {
    expect(TavernCompletionCapabilitySchema.safeParse({ protocol: 'tavern-completion', version: 1 }).success).toBe(true);
    for (const payload of [
      { protocol: 'other', version: 1 }, { protocol: 'tavern-completion', version: '1' },
      { protocol: 'tavern-completion', version: 2 }, { protocol: 'tavern-completion', version: 1, desktopReady: true },
    ]) expect(TavernCompletionCapabilitySchema.safeParse(payload).success).toBe(false);
  });
});
