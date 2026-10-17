import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';
import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';
import { ARENA_COMPANION_PROTOCOL_VERSION } from '@mahoshojo/contracts/arena-companion';
import { BUILTIN_ARENA_NEWS_PACKAGE_REF, createWebPackageOverlayFromBase, resolveWebPackage } from '@mahoshojo/web-package';
import { DesktopArenaSession, createInitialArenaDraft } from '../src/features/arena/session';

const requestId = 'package-fallback-session', generationId = `arena_${'f'.repeat(64)}`;
const source = '<!doctype html><html><body>完整且可体验的原始故事</body></html>';

describe('Desktop Hosted package metadata fallback session', () => {
  it.each((['battle', 'arena'] as const).flatMap(product => (['stream', 'non-stream'] as const).map(delivery => ({ product, delivery }))))(
    '$product/$delivery preserves a playable package and opted-in body history without automatic role writes', async ({ product, delivery }) => {
      const base = await resolveWebPackage(BUILTIN_ARENA_NEWS_PACKAGE_REF);
      const { generatedContent: _content, ...artifact } = await createWebPackageOverlayFromBase(base, source);
      expect(_content).toBe(source);
      const values = new Map<string, string>(), records = new Map<string, LocalCardRecordV1>();
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
      const repository = { get: async (id: string) => records.get(id) ?? null, putIfAbsent: vi.fn(async (record: LocalCardRecordV1) => {
        records.set(record.id, record); return { written: true };
      }) } as unknown as CardRepository;
      const session = new DesktopArenaSession({ product, storage, repository, requestId: () => requestId,
        resolveWebPackage: async () => base, hostedTestPorts: { createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } });
      session.setScope('one');
      const initial = createInitialArenaDraft();
      const draft = { ...initial, reportFormat: 'web' as const, webPackageRef: base.ref, battleMode: 'daily' as const, generationMode: delivery,
        settings: { ...initial.settings, writeArenaHistory: true, writeCurrentState: true, writeNarrativeHistory: true },
        combatants: [{ type: 'general-character' as const, isPreset: false, isValid: true, filename: '甲.json', data: { name: '甲', content: '原始角色', signature: 'original-signature' } }] };
      const operations: string[] = [];
      const invoke = vi.fn(withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'arena_hosted_detach') return;
        const request = args!.request as { operation: string }; operations.push(request.operation);
        const channel = args!.onEvent as { onmessage(value: unknown): void }; let sequence = 0;
        const send = (value: Record<string, unknown>) => channel.onmessage({ requestId, sequence: sequence++, ...value });
        if (request.operation === 'create-stream') {
          send({ kind: 'response', status: 200, generationId, generationRequestId: requestId, metadataState: 'missing', recoveryCredentialState: 'stored' });
          const event = (id: string, name: string, data: unknown) => send({ kind: 'sse-fragment', final: true, text: `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n` });
          event('1-0', 'markdown', { chunk: source });
          event('2-0', 'meta_error', { parseOk: false, error: 'missing-meta' });
          event('3-0', 'done', { status: 'completed', ok: true, webPackage: artifact });
          send({ kind: 'stream-end' });
        } else if (request.operation === 'create-json') {
          const envelope = { version: ARENA_COMPANION_PROTOCOL_VERSION,
            body: { generationId, updatedCombatants: [], report: { headline: '', reporterInfo: { name: '记者', publication: 'Arena' },
              article: { body: source, analysis: '' }, officialReport: { winner: '', conclusion: '' }, mode: 'daily', reportFormat: 'web', webPackage: artifact } },
            metadata: { reportFormat: 'web', outputContract: 'web-package-target', mode: 'daily', webPackageRef: base.ref } };
          send({ kind: 'json-response', status: 200, generationId, generationRequestId: requestId, recoveryCredentialState: 'stored' });
          send({ kind: 'json-fragment', text: JSON.stringify(envelope), final: true }); send({ kind: 'json-end' });
        } else throw new Error(`Unexpected automatic operation: ${request.operation}`);
      }));
      session.updateDraft(draft);
      await session.generateHosted({ invoke }, draft, { mode: 'hosted', generationMode: delivery, modelId: 'default', systemConfig: {} }, { kind: 'anonymous' });
      expect(session.getSnapshot()).toMatchObject({ phase: 'completed', markdown: source, report: { headline: '', officialReport: { winner: '' } },
        renderSnapshot: { reportFormat: 'web', webPackage: artifact }, hosted: { outputValidation: 'valid' }, roleUpdates: { status: 'unavailable' } });
      expect(session.getSnapshot().message).toContain('可体验和导出'); expect(session.getSnapshot().draft.combatants).toEqual(draft.combatants);
      expect(session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1); expect(session.getSnapshot().draft.narrativeHistoryEntries[0]?.content).toBe(source);
      expect(session.canRetryHostedRoleUpdates()).toBe(false); await session.retryHostedRoleUpdates({ invoke });
      expect(operations).toEqual([delivery === 'stream' ? 'create-stream' : 'create-json']);
      expect(records.size).toBe(0); expect(await session.save('characters')).toBe(false);
      expect(JSON.parse(session.exportDocument()).result.renderSnapshot.webPackage).toEqual(artifact);
      // Explicit history copy remains idempotent after the opted-in body append.
      expect(session.canAppendHostedHistory()).toBe(true); session.appendHostedHistory();
      expect(session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1);
      expect(session.getSnapshot().draft.combatants).toEqual(draft.combatants); expect(await session.save('history')).toBe(true);
      session.dispose();
    },
  );
});
