import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BattleSettingsSchema } from '@/components/arena/utils/schemas';

const settings = {
  readArenaHistory: false,
  readArenaHistoryLimit: 10,
  isArenaHistoryUnlimited: false,
  writeArenaHistory: false,
  readCurrentState: false,
  writeCurrentState: false,
  readNarrativeHistory: false,
  readNarrativeHistoryLimit: 10,
  isNarrativeHistoryUnlimited: false,
  writeNarrativeHistory: false,
};

describe('Arena resumable stream transport cutover', () => {
  it('migrates the removed non-resumable plain-stream preference to SSE', () => {
    expect(BattleSettingsSchema.parse({
      ...settings,
      streamTransport: 'plain-stream',
    }).streamTransport).toBe('sse');
  });

  it('keeps the Next disaster-recovery adapter from creating process-local active lifecycle', () => {
    const runtimeSource = readFileSync('app/api/arena/generation-runtime.ts', 'utf8');

    expect(runtimeSource).toContain('createUnavailableGenerationReplayStore');
    expect(runtimeSource).not.toContain('createMemoryGenerationReplayStore');
  });

  it('keeps Next generate-stream methods aligned with the Hono POST/DELETE adapter', () => {
    const routeSource = readFileSync('app/api/arena/generate-stream/route.ts', 'utf8');

    expect(routeSource).toContain('export const POST');
    expect(routeSource).toContain('export const DELETE');
    expect(routeSource).not.toMatch(/export const (?:GET|HEAD|OPTIONS|PUT|PATCH)/u);
  });

  it('preserves nested battle-story generation identity and SSE ids without card hash fencing', () => {
    const proxySource = readFileSync('app/api/arena/session/generate-next/handler.ts', 'utf8');
    const serviceSource = readFileSync('../../packages/hosted-runtime/src/arena-companion/session.ts', 'utf8');
    const hookSource = readFileSync('components/arena/hooks/useBattleStorySession.ts', 'utf8');

    expect(proxySource).toContain('getCloudflareDrArenaCompanionService');
    expect(serviceSource).toContain('generationRequestId: payload.generationRequestId');
    expect(serviceSource).toContain('encodeGenerationSseEvent(event)');
    expect(serviceSource).not.toContain('parseGenerationSseBlock');
    expect(serviceSource).not.toMatch(/\bfetch\s*\(/u);
    expect(hookSource).not.toContain('baseRevisionHash');
    expect(hookSource).toContain('generationRequestId: secureRandomUUID()');
    expect(hookSource).not.toContain('generationRequestId: crypto.randomUUID()');
  });

  it('reuses create authentication semantics for every local-card reconciliation request', () => {
    const updaterSource = readFileSync('components/arena/hooks/useStreamCombatantUpdater.ts', 'utf8');
    const storySessionSource = readFileSync('components/arena/hooks/useBattleStorySession.ts', 'utf8');

    expect(updaterSource).toContain('buildGenerationApiHeaders');
    expect(updaterSource).toContain('authStorage');
    expect(updaterSource).toMatch(
      /withArenaGenerationActorToken\(await buildGenerationApiHeaders\([\s\S]*?authStorage/u,
    );
    // The story owner freezes create auth once. Roles reuse those exact headers;
    // rebuilding headers after generation could silently bind a later actor.
    const expectInOrder = (source: string, fragments: string[]) => {
      let previous = -1;
      for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, fragment).toBeGreaterThan(previous);
        previous = index;
      }
    };
    expectInOrder(storySessionSource, [
      "const originalAuth = readLocalStorageString('mahoshojo_auth');",
      'const originalActorEpoch = actorEpochRef.current;',
      'const preparedHeaders = await buildRequestHeaders(true);',
      "if (actorEpochRef.current !== originalActorEpoch || readLocalStorageString('mahoshojo_auth') !== originalAuth)",
      'throw new Error(',
      'const originalHeaders = withArenaGenerationActorToken(preparedHeaders);',
      'const preparedActor = originalHeaders.get(ARENA_GENERATION_ACTOR_TOKEN_HEADER);',
      'isCurrent: () => mountedRef.current && !generationController.signal.aborted',
      "actorEpochRef.current === originalActorEpoch && readLocalStorageString('mahoshojo_auth') === originalAuth",
      'withArenaGenerationActorToken({}, { createIfMissing: false }).get(ARENA_GENERATION_ACTOR_TOKEN_HEADER) === preparedActor',
      'const generationIntent = generationApiIntentLatch.tryAcquire();',
      'generationDispatchGuardRef.current = dispatchGuard;',
      "generationIntent.dispatch('/api/arena/session/generate-next',",
      "method: 'POST', headers: originalHeaders,",
      'const roleHeaders = new Headers(originalHeaders);',
      'const returnedActor = response.headers.get(ARENA_GENERATION_ACTOR_TOKEN_HEADER)?.trim();',
      'if (returnedActor) roleHeaders.set(ARENA_GENERATION_ACTOR_TOKEN_HEADER, returnedActor);',
      "roleHeaders.delete('Accept');",
      'const originalActor = roleHeaders.get(ARENA_GENERATION_ACTOR_TOKEN_HEADER);',
      "const isActorCurrent = () => actorEpochRef.current === originalActorEpoch && readLocalStorageString('mahoshojo_auth') === originalAuth",
      'withArenaGenerationActorToken({}, { createIfMissing: false }).get(ARENA_GENERATION_ACTOR_TOKEN_HEADER) === originalActor',
      'resolveRoles: async () => {',
      'roleBody ??= JSON.stringify(await buildArenaReconciliationRetryPayload(',
      'if (!isActorCurrent()) throw new Error(',
      'resolveWebBattleStoryRoles({ body: roleBody, headers: roleHeaders, workingCombatants: input.workingCombatants })',
    ]);
    const latchSource = storySessionSource.slice(
      storySessionSource.indexOf('const generationApiIntentLatch = useGenerationApiIntentLatch('),
      storySessionSource.indexOf('const useBattleSelector ='),
    );
    expect(latchSource).toContain('auth: { getAuthHeader: async () => null, getActivityHeaders: async () => ({}) }');
    expectInOrder(latchSource, [
      'fetcher: async (url, init) => {',
      'const guard = generationDispatchGuardRef.current;',
      'if (!guard?.isCurrent()) {',
      'if (guard) guard.blocked = true;',
      'throw new Error(',
      'return fetch(url, init);',
    ]);
  });
});
