import { describe, expect, it, vi } from 'vitest';
import { createArenaGenerationService, issueArenaGenerationRoomStartContext, ROOM_GENERATION_START_GATE_VERSION, isArenaGenerationAuditableRejection } from '@mahoshojo/hosted-api/arena-generation/service';
import { createMemoryGenerationReplayStore } from '@mahoshojo/hosted-api/arena-generation/memory-replay-store';
import { canonicalizeNodeArenaGenerationSemanticPayload, createNodeArenaGenerationExecutor, hashArenaGenerationPayload } from '@mahoshojo/hosted-runtime/arena-generation';
import { buildArenaRoomGenerationPayload, hashArenaRoomGenerationPayload } from '#/arena-generation/room-generation-port';
import { createArenaRoomGenerationSnapshot } from '#/arena-room/room-generation-snapshot';
import { createArenaRoomState } from './arena-room-fixtures';

const signatures = { generateSignature: async () => null, verifySignature: async (value: unknown) => (
  !!value && typeof value === 'object' && (value as { signature?: unknown }).signature === 'valid'
) };

describe('Room canonical digest versus actual Node preflight and core reservation', () => {
  it.each(['system', 'byok'] as const)('matches Hlegacy and actual Hseeded with %s funding, defaults, native authority and Web output', async (funding) => {
    const state = createArenaRoomState();
    state.snapshot.sharedConfig.reportFormat = 'web';
    const multiplayerSnapshot = createArenaRoomGenerationSnapshot(state, 'request-golden');
    const input = {
      roomId: 'room-1', generationRequestId: 'request-golden', multiplayerSnapshot,
      internalGuidance: '  trusted golden guidance  ', pvpContext: { matchId: 'generation-golden', roundId: 'attempt-1' },
      payload: {
        combatants: [
          { type: 'magical-girl', isNative: false, data: { name: 'A', signature: 'valid' } },
          { type: 'magical-girl', isNative: true, data: { name: 'B', signature: 'forged' } },
        ], reportFormat: 'web', internalGuidance: 'forged', pvpContext: { roomId: 'forged' },
        ...(funding === 'byok' ? { customProvider: { providerId: 'chatbox', modelId: 'gpt-5.4', apiKey: 'synthetic-test-only' } } : {}),
      },
    };
    const canonicalize = (args: Parameters<typeof canonicalizeNodeArenaGenerationSemanticPayload>[0]) => canonicalizeNodeArenaGenerationSemanticPayload({ ...args, signatures });
    const roomDigest = await hashArenaRoomGenerationPayload(input, (args) => canonicalize({ ...args, signatures }));
    const payload = { ...buildArenaRoomGenerationPayload(input) };
    const executor = createNodeArenaGenerationExecutor({
      env: {}, signatureService: signatures,
      resolveTrustedInternalGuidance: async () => input.internalGuidance.trim(),
      resolveTrustedPvpContext: async () => ({ roomId: input.roomId, ...input.pvpContext }),
      enforceSafety: async () => null,
      generateWithStreamAI: vi.fn(async () => { throw new Error('No provider in golden preflight'); }),
      generateWithStructuredAI: vi.fn(async () => { throw new Error('No provider in golden preflight'); }),
      finalizer: vi.fn(async () => { throw new Error('No finalization in golden preflight'); }),
    });
    const request = new Request('https://synthetic.invalid/api/arena/generate-stream', { method: 'POST' });
    const prepared = await executor.preflight!({ request, actorKey: 'pvp-room:room-1', generationRequestId: input.generationRequestId, payload });
    if (prepared instanceof Response || isArenaGenerationAuditableRejection(prepared)) throw new Error(`Unexpected preflight rejection: ${prepared instanceof Response ? await prepared.text() : prepared.code}`);
    expect(`sha256:${await hashArenaGenerationPayload(prepared.semanticPayload)}`).toBe(roomDigest);
    expect(prepared.semanticPayload).toMatchObject({
      mode: 'classic', language: 'zh-CN', reportFormat: 'web', internalGuidance: input.internalGuidance.trim(),
      combatants: [{ isNative: true }, { isNative: false }], multiplayerGenerationSnapshot: multiplayerSnapshot,
    });
    expect(JSON.stringify(prepared.semanticPayload)).not.toContain('synthetic-test-only');
    const seeded = await hashArenaGenerationPayload({ reservationHashVersion: 'arena-seeded-reservation-v1', semanticPayload: prepared.semanticPayload });
    expect(seeded).not.toBe(roomDigest.slice(7));
    const reserve = vi.fn(async () => ({ kind: 'conflict' as const }));
    const store = { ...createMemoryGenerationReplayStore(), reserve };
    const service = createArenaGenerationService({ store, executor, hashPayload: hashArenaGenerationPayload,
      deriveGenerationId: async () => 'generation-golden', resolveActor: async () => ({ actorKey: 'pvp-room:room-1' }), now: () => new Date(),
    });
    const result = await service.createParsedSubscription(request, {
      generationRequestId: input.generationRequestId, payload, bodyBytes: 2,
      trustedRoomContext: issueArenaGenerationRoomStartContext({ admission: {
        version: ROOM_GENERATION_START_GATE_VERSION, roomId: 'room-1', roomEpoch: 'epoch-1', hostUserId: 'host-1', hostAccountUserId: 101,
        generationId: 'generation-golden', generationRequestId: input.generationRequestId, attempt: 1, configRevision: multiplayerSnapshot.configRevision,
        snapshotDigest: multiplayerSnapshot.snapshotDigest, generationPayloadDigest: roomDigest, mode: 'classic', startedAt: new Date().toISOString(),
      }, bindProducer: async () => { throw new Error('Must not bind a conflict'); } }),
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(409);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ payloadHash: seeded, roomAdmission: expect.objectContaining({ generationPayloadDigest: roomDigest }) }));
  });
});
