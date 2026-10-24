import { describe, expect, it } from 'vitest';
import type { TeaMessageDocument, TeaSessionDocument } from '@mahoshojo/contracts/desktop-magic-tea-party';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { prepareTeaDirectRequest, readTeaMessagePages } from '../src/features/magic-tea-party/direct';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';
import type { ResolvedDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
const target: ResolvedDesktopAiTarget = { location: 'client', providerTarget: { kind: 'custom', profileId: 'tea-loopback' }, profile: null,
  mode: 'direct-local', modelId: 'synthetic', availableModelIds: ['synthetic'], generationOverrides: undefined, unavailableReason: null };

describe.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('real Native Tea independent branch journey', () => {
  it('copies unseen prefix, drops old tail/summary from actual Direct request, reopens and archives both branches with remapped links', async () => {
    const probe = await startMagicTeaPartyJourneyProbe(); const port = createIpcTeaNativePort(probe.invoke); let sequence = 0;
    const owner = new DesktopTeaSession(port, () => `fork-journey-${++sequence}`, () => 100);
    try {
      const session: TeaSessionDocument = { id: 'source', title: '源会话', createdAt: 1, updatedAt: 1,
        roles: [{ id: 'r', name: '星光', source: 'local', card: { name: '星光' } }],
        settings: { providerId: 'synthetic', modelId: 'synthetic', outputFormat: 'markdown', autoSummaryEnabled: true },
        summary: '不应泄漏的旧尾摘要', summaryMeta: { updatedAt: 1, toMessageId: 'm-105' }, draft: '已保存草稿',
        lastChoices: [{ id: 'c', text: '旧选项' }], protocolShadow: { future: true }, updateSnapshot: { future: true }, pinnedAt: 9, pinnedOrder: 8 };
      const messages: TeaMessageDocument[] = Array.from({ length: 108 }, (_, i) => ({ id: `m-${i}`, sessionId: 'source',
        role: i % 2 ? 'assistant' : 'user', content: i === 0 ? '首条前缀证据' : i >= 104 ? '禁止混入的源尾部' : `保留前缀${i}`, createdAt: 1, status: 'done',
        ...(i === 3 ? { sourceMessageId: 'm-1', revisionOf: 'm-2' } : {}) }));
      await port.mutate({ version: 1, request: { action: 'import', operationId: 'source-import', entries: [{ session, messages }] } });
      await owner.select('source'); const before = owner.getSnapshot().record!;
      expect(owner.getSnapshot().messages.length).toBe(8); // Loaded UI page does not contain the entire prefix.
      owner.startMessageEdit('m-104'); owner.setMessageEditDraft('新的分支问题');
      await probe.control('drop-next-write-reply');
      expect(await owner.forkMessageEdit()).toBe(false); expect(owner.getSnapshot().pending).toBe('unknown');
      const writes = probe.trace.filter(row => row.command === 'mutate_magic_tea_party').length;
      await owner.retryPending(); expect(probe.trace.filter(row => row.command === 'mutate_magic_tea_party')).toHaveLength(writes);
      await owner.resolvePending(); expect(owner.getSnapshot().pending).toBe('none');
      const branch = owner.getSnapshot().record!; const branchId = branch.session.id;
      expect(branchId).not.toBe('source');
      expect(branch.revision).toBe(1); expect(branch.instance).not.toBe(before.instance);
      expect(branch.session).toMatchObject({ draft: '已保存草稿', lastChoices: session.lastChoices, protocolShadow: session.protocolShadow,
        updateSnapshot: session.updateSnapshot, pinnedAt: 9, pinnedOrder: 8, settings: { autoSummaryEnabled: false }, forkedFrom: { sessionId: 'source', messageId: 'm-104' } });
      expect(branch.session.summary).toBeUndefined();
      const all: TeaMessageDocument[] = []; for await (const page of readTeaMessagePages(port, branch, () => true)) all.push(...page.rows.map(row => row.message));
      expect(all).toHaveLength(105); expect(all[0].content).toBe('首条前缀证据'); expect(all.at(-1)).toMatchObject({ content: '新的分支问题', revisionOf: 'm-104' });
      expect(all[3]).toMatchObject({ sourceMessageId: all[1].id, revisionOf: all[2].id });
      const request = await prepareTeaDirectRequest(port, branch, target, null, 'fork-direct', () => true);
      const prompt = request.messages.map(message => message.content).join('\n');
      expect(prompt).toContain('新的分支问题'); expect(prompt).not.toContain('禁止混入的源尾部'); expect(prompt).not.toContain('不应泄漏的旧尾摘要');
      const source = await port.read({ version: 1, request: { action: 'session', sessionId: 'source', expectedCatalogRevision: null } });
      expect(source.result.action === 'session' && source.result.record).toEqual(before);
      await probe.control('reopen'); await owner.select(branchId); expect(owner.getSnapshot().record).toEqual(branch);
      const archive = await owner.export('archive');
      await owner.importText(archive, 'json', () => true);
      expect(owner.getSnapshot().error).toBeNull();
      const importedHead = owner.getSnapshot().directory.find(head => !['source', branchId].includes(head.id) && head.messageCount === 105)!;
      expect(importedHead).toBeTruthy(); await owner.select(importedHead.id); const imported = owner.getSnapshot().record!;
      expect(imported.session.forkedFrom?.sessionId).not.toBe('source');
      const importedMessages: TeaMessageDocument[] = []; for await (const page of readTeaMessagePages(port, imported, () => true)) importedMessages.push(...page.rows.map(row => row.message));
      expect(importedMessages.at(-1)?.revisionOf).toBe(imported.session.forkedFrom?.messageId);
      expect(importedMessages[3]).toMatchObject({ sourceMessageId: importedMessages[1].id, revisionOf: importedMessages[2].id });
      await probe.control('reopen'); await owner.select(importedHead.id); expect(owner.getSnapshot().record).toEqual(imported);
      expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
});
