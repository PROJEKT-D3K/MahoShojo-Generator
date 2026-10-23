import { describe, expect, it } from 'vitest';
import { buildWorldbookText, MAGIC_TEA_PARTY_PRESETS } from '@mahoshojo/ai-core/magic-tea-party';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { prepareTeaDirectRequest } from '../src/features/magic-tea-party/direct';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';
import type { ResolvedDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
const target: ResolvedDesktopAiTarget = { location: 'client', providerTarget: { kind: 'custom', profileId: 'tea-loopback' }, profile: null,
  mode: 'direct-local', modelId: 'synthetic', availableModelIds: ['synthetic'], generationOverrides: undefined, unavailableReason: null };

describe.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('real Native Tea presets and explicit organization', () => {
  it('pins another row and active row without switching or saving any editor drafts, recovers unknown receipts and reopens', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const port = createIpcTeaNativePort(probe.invoke); let sequence = 0;
    const owner = new DesktopTeaSession(port, () => `org-${++sequence}`, () => 100);
    try {
      await owner.create(); const first = owner.getSnapshot().record!;
      await owner.create(); const second = owner.getSnapshot().record!;
      owner.setInput('未发送输入'); owner.stageTitle('未保存标题'); owner.stageName('未保存称呼'); owner.stageSummary('未保存摘要');
      const drafts = () => { const s = owner.getSnapshot(); return [s.input, s.titleDraft, s.nameDraft, s.summaryDraft, s.messages]; };
      const before = drafts();
      expect(await owner.setPin(first.session.id, true)).toBe(true);
      expect(owner.getSnapshot().record).toBe(second); expect(drafts()).toEqual(before);
      await probe.control('drop-next-write-reply');
      expect(await owner.setPin(second.session.id, true)).toBe(false); expect(owner.getSnapshot().pending).toBe('unknown');
      await owner.retryPending(); expect(owner.getSnapshot().pending).toBe('unknown');
      await owner.resolvePending(); expect(owner.getSnapshot().pending).toBe('none');
      const active = owner.getSnapshot().record!; expect(active.revision).toBe(second.revision + 1);
      expect(active.session.updatedAt).toBe(second.session.updatedAt); expect(active.session.draft).toBe(''); expect(drafts()).toEqual(before);
      expect(await owner.setPin(first.session.id, false)).toBe(true); expect(drafts()).toEqual(before);
      await probe.control('reopen');
      const stored = await port.read({ version: 1, request: { action: 'session', sessionId: second.session.id, expectedCatalogRevision: null } });
      expect(stored.result.action === 'session' && stored.result.record?.session.pinnedAt).toBe(active.session.pinnedAt);
      await port.mutate({ version: 1, request: { action: 'update', sessionId: active.session.id, instance: active.instance,
        expectedRevision: active.revision, session: { ...active.session, title: '外部新正文' } } });
      await owner.refreshDirectory(); const beforeConflict = await probe.control('snapshot');
      expect(await owner.setPin(active.session.id, false)).toBe(false); expect(await probe.control('snapshot')).toEqual(beforeConflict);
      expect(owner.getSnapshot().record?.revision).toBe(active.revision); expect(drafts()).toEqual(before);
      expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
  it('freezes loaded cleanup targets, cancels with no write, rejects stale selections atomically, and never deletes a recreated instance', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const port = createIpcTeaNativePort(probe.invoke); let sequence = 0;
    const owner = new DesktopTeaSession(port, () => `cleanup-${++sequence}`);
    try {
      await owner.create(); const one = owner.getSnapshot().record!;
      await owner.create(); const two = owner.getSnapshot().record!;
      await owner.create(); const active = owner.getSnapshot().record!; owner.setInput('当前草稿');
      const ids = [one.session.id, two.session.id]; const before = await probe.control('snapshot');
      expect(owner.prepareCleanup([active.session.id])).toBeNull();
      expect(owner.prepareCleanup(ids)?.targets).toHaveLength(2);
      expect(await probe.control('snapshot')).toEqual(before); // Discarding preview/cancel performs no mutation.
      const selection = owner.prepareCleanup(ids)!;
      await port.mutate({ version: 1, request: { action: 'update', sessionId: two.session.id, instance: two.instance, expectedRevision: two.revision, session: { ...two.session, title: '另一持有者修改' } } });
      const changed = await probe.control('snapshot'); expect(await owner.deleteSelected(selection)).toBe(false);
      expect(await probe.control('snapshot')).toEqual(changed); expect(owner.getSnapshot().input).toBe('当前草稿');
      await owner.abandonPending(); expect(owner.getSnapshot().input).toBe('当前草稿'); await owner.refreshDirectory();
      const fresh = owner.prepareCleanup(ids)!; await probe.control('drop-next-write-reply');
      expect(await owner.deleteSelected(fresh)).toBe(false); expect(owner.getSnapshot().pending).toBe('unknown');
      await port.mutate({ version: 1, request: { action: 'create', session: one.session } });
      await owner.resolvePending(); expect(owner.getSnapshot().pending).toBe('none');
      const recreated = await port.read({ version: 1, request: { action: 'session', sessionId: one.session.id, expectedCatalogRevision: null } });
      expect(recreated.result.action === 'session' && recreated.result.record?.instance).not.toBe(one.instance);
      expect(owner.getSnapshot().record?.session.id).toBe(active.session.id);
      const frozen = owner.prepareCleanup([one.session.id])!; await owner.refreshDirectory();
      expect(await owner.deleteSelected(frozen)).toBe(false);
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
  it('creates all presets, applies an explicitly previewed preset once, retains content and feeds production Direct prompts', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const port = createIpcTeaNativePort(probe.invoke); let sequence = 0;
    const owner = new DesktopTeaSession(port, () => `preset-${++sequence}`);
    try {
      await owner.create(null); expect(owner.getSnapshot().record?.session.settings.presetId).toBeFalsy();
      for (const preset of MAGIC_TEA_PARTY_PRESETS) {
        await owner.create(preset.id); const record = owner.getSnapshot().record!;
        expect(record.session.settings.presetId).toBe(preset.id); expect(record.session.scenario?.source).toBe('preset');
        const request = await prepareTeaDirectRequest(port, record, target, null, `request-${preset.id}`, () => true);
        const prompt = request.messages.map(message => message.content).join('\n');
        expect(prompt).toContain(preset.systemPrompt.trim()); expect(prompt).toContain(JSON.stringify(preset.defaultScenario.content).slice(1, -1)); expect(prompt).toContain(buildWorldbookText(preset.worldbook));
        expect(record.session.settings.worldbookPresetId).toBe(preset.worldbookPresetId);
        expect(record.session.settings.choiceCount).toBe(preset.defaultSettings.choiceCount);
      }
      const importedId = 'preset-history';
      const imported = { ...owner.getSnapshot().record!.session, id: importedId, draft: '归档草稿', summary: '归档摘要' };
      const historical = { id: 'preset-message', sessionId: importedId, role: 'assistant' as const, content: '已有历史', createdAt: 1, status: 'done' as const };
      await port.mutate({ version: 1, request: { action: 'import', operationId: 'preset-history-import', entries: [{ session: imported, messages: [historical] }] } });
      await owner.refreshDirectory(); await owner.select(importedId);
      const role = { id: 'role', name: '保留角色', source: 'local' as const, card: { name: '保留角色' } };
      await owner.update({ roles: [role], auxScenarios: [{ id: 'aux', title: '附加', source: 'local', card: { title: '附加' } }] });
      await owner.update({ settings: { ...owner.getSnapshot().record!.session.settings, enableSummary: true, writeArenaHistory: true,
        writeCurrentState: true, updateApplyMode: 'auto', outputPlan: { choices: 'off', summary: 'on', updates: 'on' } } });
      owner.setInput('草稿保留'); const state = owner.getSnapshot(); const original = state.record!;
      expect(await owner.applyPreset('arena-classic', original, state.incarnation)).toBe(true);
      expect(owner.getSnapshot().record?.session.roles).toEqual([role]); expect(owner.getSnapshot().input).toBe('草稿保留');
      expect(owner.getSnapshot().messages).toEqual([historical]); expect(owner.getSnapshot().record?.session.summary).toBe('归档摘要');
      expect(owner.getSnapshot().record?.session.auxScenarios).toEqual([]);
      expect(owner.getSnapshot().record?.session.settings).toMatchObject({ enableSummary: true, writeArenaHistory: true, writeCurrentState: true,
        updateApplyMode: 'auto', outputPlan: { choices: 'auto', summary: 'on', updates: 'on' } });
      const applied = await prepareTeaDirectRequest(port, owner.getSnapshot().record!, target, null, 'applied', () => true);
      const appliedPrompt = applied.messages.map(message => message.content).join('\n');
      expect(appliedPrompt).toContain('- choices：auto'); expect(appliedPrompt).toContain('一共 3 条');
      expect(appliedPrompt).toContain('在需要时输出 choices'); expect(appliedPrompt).not.toContain('- choices：off');
      expect(await owner.applyPreset('arena-classic', original, state.incarnation)).toBe(false);
      const now = owner.getSnapshot(); expect(await owner.applyPreset('arena-classic', now.record!, now.incarnation)).toBe(true);
      expect(owner.getSnapshot().record?.session.settings.presetId).toBeFalsy();
      await owner.create('arena-kizuna'); const originalId = owner.getSnapshot().record!.session.id;
      await owner.setPin(originalId, true); const pinned = owner.getSnapshot().record!.session;
      const archive = await owner.export('json');
      const existing = new Set(owner.getSnapshot().directory.map(row => row.id));
      await owner.importText(archive, 'json', () => true);
      const importedHead = owner.getSnapshot().directory.find(row => !existing.has(row.id))!;
      expect(importedHead).toBeTruthy(); await owner.select(importedHead.id); await probe.control('reopen'); await owner.select(importedHead.id);
      expect(owner.getSnapshot().record?.session.settings.presetId).toBe('arena-kizuna');
      expect(owner.getSnapshot().record?.session.pinnedAt).toBe(pinned.pinnedAt);
      expect(owner.getSnapshot().record?.session.pinnedOrder).toBe(pinned.pinnedOrder);
      expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
});
