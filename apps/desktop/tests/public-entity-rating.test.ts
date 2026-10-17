import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/public-ranking.json';
import { PublicRankingRequestSchema } from '@mahoshojo/contracts/public-ranking';
import { readPublicRanking } from '../src/platform/public-ranking-bridge';
const request = { kind: 'entityRating', entityType: 'data_card', entityId: ' public-card ' } as const;
describe('Desktop current pivot rating bridge', () => {
  it('passes a normalized narrow request without reading account state', async () => {
    const invoke = vi.fn().mockResolvedValue({ kind: 'entityRating', data: fixture.responses.entityRating });
    await expect(readPublicRanking(invoke, request)).resolves.toEqual(fixture.responses.entityRating);
    expect(invoke).toHaveBeenCalledWith('cloud_public_ranking_read', { request: { ...request, entityId: 'public-card' } });
    invoke.mockResolvedValue({ kind: 'entityRating', data: { ...fixture.responses.entityRating, entityId: 'other' } });
    await expect(readPublicRanking(invoke, request)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('rejects arbitrary queues, sources and transport fields before invoke', async () => {
    const invoke = vi.fn();
    for (const invalid of [{ ...request, queue: 'free' }, { ...request, entityType: 'preset' }, { ...request, url: 'https://evil.test' }, { ...request, entityId: 'x'.repeat(201) }]) {
      expect(PublicRankingRequestSchema.safeParse(invalid).success).toBe(false);
      await expect(readPublicRanking(invoke, invalid as typeof request)).rejects.toMatchObject({ code: 'invalid-request' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.PUBLIC_RANKING_NATIVE_WIRE_INPUT)('consumes actual Web handler → Native loopback Serialize wires through the real bridge', async () => {
    const directory = process.env.PUBLIC_RANKING_NATIVE_WIRE_INPUT!;
    for (const name of ['entityRating', ...['found', 'missing', 'zero', 'fraction', 'large'].map(name => `entityRating-handler-${name}`)]) {
      const wire = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
      const invoke = vi.fn().mockResolvedValue(wire);
      await expect(readPublicRanking(invoke, request)).resolves.toEqual(wire.data);
      if (name.startsWith('entityRating-handler-')) {
        const originalDirectory = process.env.PUBLIC_RANKING_HANDLER_WIRE_INPUT;
        expect(originalDirectory, 'Compare Native output to the original handler wire, never its own parsed output').toBeTruthy();
        const original = JSON.parse(readFileSync(join(originalDirectory!, `${name.replace('entityRating-handler-', '')}.json`), 'utf8'));
        expect(wire.data).toEqual(original);
      }
      expect(wire.data.entityId).toBe('public-card');
      expect(JSON.stringify(wire)).not.toContain('DO-NOT-LEAK');
    }
  });
});
