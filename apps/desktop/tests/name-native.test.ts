import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { buildNameGenerationResult, serializeNameGenerationResult } from '@mahoshojo/domain/name-generation';
import { NameSession } from '../src/features/name/session';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

const generated = { flowerName: '铃兰', flowerDescription: '幸福归来', appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊' };
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; };

describe('classic name owner through real Native Direct loopback', () => {
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('runs NameSession through stream_direct_ai and shared projection, then reopens without replay', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const disk = storage();
    const owner = new NameSession({ storage: disk, repository: {} as CardRepository });
    try {
      owner.updateDraft({ inputName: '小满🌸', selectedLanguage: '日本語' });
      const raw = JSON.stringify(generated);
      await probe.control('checkpoint', { action: 'model', chunks: [raw], deferred: false });
      await owner.generate(probe.aiOptions, { realName: '小满🌸', language: '日本語' }, { mode: 'direct-local', modelId: 'synthetic' });
      const expected = buildNameGenerationResult('小满🌸', generated);
      expect(owner.getSnapshot()).toMatchObject({ phase: 'completed', card: expected, rawText: raw });
      expect(JSON.stringify(owner.getSnapshot().card, null, 2)).toBe(serializeNameGenerationResult(expected));
      expect(probe.trace.filter(row => row.command === 'stream_direct_ai')).toHaveLength(1);
      expect(await probe.control('requestCount')).toMatchObject({ count: 1 });
      owner.dispose();
      const reopened = new NameSession({ storage: disk, repository: {} as CardRepository }); reopened.restoreDraft(false);
      expect(reopened.getSnapshot()).toMatchObject({ phase: 'completed', card: expected, resultRestored: true });
      expect(await probe.control('requestCount')).toMatchObject({ count: 1 }); reopened.dispose();
    } finally { owner.dispose(); await probe.close(); }
  }, 20000);
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('cancels real name Direct HTTP, retains the previous card and accepted raw prefix after reopen', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const disk = storage();
    const owner = new NameSession({ storage: disk, repository: {} as CardRepository });
    try {
      const input = { realName: '小满', language: 'zh-CN' }; const intent = { mode: 'direct-local' as const, modelId: 'synthetic' };
      await probe.control('checkpoint', { action: 'model', chunks: [JSON.stringify(generated)], deferred: false });
      await owner.generate(probe.aiOptions, input, intent);
      await probe.control('checkpoint', { action: 'model', chunks: ['{"flowerName":"未完成', '不得迟到追加'], deferred: true });
      const running = owner.generate(probe.aiOptions, input, intent);
      await vi.waitFor(() => expect(owner.getSnapshot().rawText).toBe('{"flowerName":"未完成'), { timeout: 5000 });
      owner.cancel(); await running;
      const saved = owner.getSnapshot();
      expect(saved).toMatchObject({ phase: 'cancelled', card: null, draft: { lastSuccessfulResult: buildNameGenerationResult('小满', generated) } });
      await vi.waitFor(async () => expect(await probe.control('requestCount')).toMatchObject({ count: 2, disconnected: 1 }), { timeout: 5000 });
      await probe.control('checkpoint', { action: 'release' });
      expect(owner.getSnapshot()).toEqual(saved);
      const reopened = new NameSession({ storage: disk, repository: {} as CardRepository }); reopened.restoreDraft(false);
      expect(reopened.getSnapshot()).toMatchObject({ phase: 'cancelled', rawText: '{"flowerName":"未完成', draft: saved.draft });
      expect(await probe.control('requestCount')).toMatchObject({ count: 2 }); reopened.dispose();
    } finally { owner.dispose(); await probe.close(); }
  }, 20000);
});
