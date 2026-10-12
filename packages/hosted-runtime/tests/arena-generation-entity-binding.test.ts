import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import { createNodeArenaGenerationExecutor } from '../src/arena-generation/node-executor';
import type { SignatureService } from '../src/signature';

const signatures: SignatureService = {
  generateSignature: async () => 'valid',
  verifySignature: async (value) => (value as { signature?: unknown } | null)?.signature === 'valid',
};
const season = {
  authorityAvailable: true, seasonId: null, mode: 'classic' as const,
  storyGuidance: '', scenarioPresetFilename: null,
  questionnaireLoreAllowed: false, questionnaireLorePresetIds: [],
};
const body = (name: string) => ({ templateId: '通用角色', name, content: `${name}的设定`, signature: 'valid' });
const online = (id: string, name: string) => ({
  type: 'general-character', data: body(name), sourceDataCardId: id,
  sourceDataCardUpdatedAt: '2026-01-01T00:00:00.000Z', isPreset: false,
});

describe('Arena server-owned ranked entity binding', () => {
  it.each(['arena/generate', 'generate-battle-story'])('checks final non-stream guidance normalization for %s', async (route) => {
    const combatants = await Promise.all(['C01_egg.json', 'C02_pupa.json'].map(async (filename) => ({
      type: 'canshou', isPreset: true, filename,
      data: JSON.parse(await readFile(new URL(`../../../content/presets/${filename}`, import.meta.url), 'utf8')),
    })));
    const guidance = '引'.repeat(200);
    const executor = createNodeArenaGenerationExecutor({ env: {}, signatureService: signatures,
      readSeasonContext: async () => ({ ...season, storyGuidance: guidance }), enforceSafety: async () => null,
      generateWithStreamAI: vi.fn(), finalizer: async () => ({ resultRef: null, ranking: null }) });
    const prepared = await executor.prepare!({ request: new Request(`https://example.test/api/${route}`, {
      headers: { 'cf-connecting-ip': '192.0.2.10' },
    }), actorKey: 'user:42', generationRequestId: 'non-stream-guidance-binding', payload: {
      combatants, mode: 'classic', language: 'zh-CN', readArenaHistory: false,
      readCurrentState: false, readNarrativeHistory: false, userGuidance: ` ${guidance}ignored-suffix `,
    } });
    if (prepared instanceof Response || !('executionPayload' in prepared)) throw new Error('Expected prepared generation');
    expect(prepared.executionPayload.userGuidance).toBe(guidance);
    expect(prepared.executionPayload.__arenaServerContextV1).toMatchObject({ ratingEntityBinding: { status: 'bound' } });
  });

  it.each(['arena/generate-stream', 'arena/generate', 'generate-battle-story', 'arena/session/generate-next'])(
    'binds real bundled presets through shared %s preparation and overwrites client authority', async (route) => {
      const combatants = await Promise.all(['C01_egg.json', 'C02_pupa.json'].map(async (filename) => ({
        type: 'canshou', isPreset: true, filename,
        data: JSON.parse(await readFile(new URL(`../../../content/presets/${filename}`, import.meta.url), 'utf8')),
      })));
      const getD1Client = vi.fn(() => null);
      const executor = createNodeArenaGenerationExecutor({ env: {}, signatureService: signatures,
        getD1Client, readSeasonContext: async () => season, enforceSafety: async () => null,
        generateWithStreamAI: vi.fn(), finalizer: async () => ({ resultRef: null, ranking: null }) });
      const prepared = await executor.prepare!({ request: new Request(`https://example.test/api/${route}`, {
        headers: { 'cf-connecting-ip': '192.0.2.10' },
      }), actorKey: 'user:42', generationRequestId: 'bundled-preset-identity', payload: {
        combatants, mode: 'classic', language: 'zh-CN', readArenaHistory: false,
        readCurrentState: false, readNarrativeHistory: false,
        __arenaServerContextV1: { ratingEntityBinding: { version: 1, status: 'unbound', reason: 'entity-body-mismatch' } },
      } });
      if (prepared instanceof Response || !('executionPayload' in prepared)) throw new Error('Expected prepared generation');
      expect(prepared.executionPayload.__arenaServerContextV1).toMatchObject({ ratingEntityBinding: {
        version: 1, status: 'bound', entities: [{ entityId: 'C01_egg.json' }, { entityId: 'C02_pupa.json' }],
      } });
      expect(prepared.semanticPayload).not.toHaveProperty('__arenaServerContextV1');
      expect(getD1Client).not.toHaveBeenCalled();
    },
  );

  it.each(['online', 'preset'] as const)('does not grant Strict authority to signed A claiming another %s identity', async (kind) => {
    const claimed = kind === 'online'
      ? online('card-B', 'A')
      : { type: 'general-character', data: body('A'), isPreset: true, filename: 'C01_egg.json' };
    const all = vi.fn(async () => ({ success: true, meta: {}, results: [
      { id: 'card-B', type: 'character', data: JSON.stringify(body('B')), is_public: 1,
        review_status: 'approved', deleted_at: null, updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'card-C', type: 'character', data: JSON.stringify(body('C')), is_public: 1,
        review_status: 'approved', deleted_at: null, updated_at: '2026-01-01T00:00:00.000Z' },
    ] }));
    const statement = { bind: (..._params: unknown[]) => statement, all, run: all };
    const generateWithStreamAI = vi.fn();
    const options = {
      env: {}, signatureService: signatures, readSeasonContext: async () => season,
      getD1Client: () => ({ prepare: (_sql: string) => statement }),
      enforceSafety: async () => null, generateWithStreamAI,
      finalizer: async () => ({ resultRef: null, ranking: null }),
    };
    const executor = createNodeArenaGenerationExecutor(options);
    const result = await executor.prepare!({
      request: new Request('https://example.test/api/arena/generate-stream', {
        headers: { 'cf-connecting-ip': '192.0.2.10' },
      }),
      actorKey: 'user:42', generationRequestId: 'synthetic-identity-binding',
      payload: {
        combatants: [claimed, online('card-C', 'C')], mode: 'classic', language: 'zh-CN',
        readArenaHistory: false, readCurrentState: false, readNarrativeHistory: false,
      },
    });
    // Ordinary generation remains available. A valid signature proves only A's origin.
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response || !('executionPayload' in result)) throw new Error('Expected prepared payload');
    expect((result.executionPayload.combatants as Array<Record<string, unknown>>)[0]).toMatchObject({
      ...claimed, isNative: true,
    });
    expect(result.executionPayload.__arenaServerContextV1).toMatchObject({
      ratingEntityBinding: { version: 1, status: 'unbound', reason: 'entity-body-mismatch' },
    });
    expect(generateWithStreamAI).not.toHaveBeenCalled();
  });
});
