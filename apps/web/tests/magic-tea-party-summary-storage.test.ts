// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { captureMagicTeaPartySummarySnapshot, compareAndPatchMagicTeaPartySummary, deleteMagicTeaPartySession, getMagicTeaPartySession,
  listMagicTeaPartyMessages, putMagicTeaPartyMessage, putMagicTeaPartySession, putMagicTeaPartySessionKeepingSummary, setMagicTeaPartyAutoSummaryEnabled } from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartySession } from '@/lib/magic-tea-party/types';
let session: MagicTeaPartySession;
beforeEach(async () => {
  session = { id: crypto.randomUUID(), title: 'Tea', createdAt: 1, updatedAt: 1, roles: [], draft: '原草稿', summary: '旧摘要',
    summaryMeta: { updatedAt: 1 }, settings: { providerId: 'openai', modelId: 'test', autoSummaryEnabled: true } };
  await putMagicTeaPartySession(session);
});
const patch = (expected = captureMagicTeaPartySummarySnapshot(session)) => compareAndPatchMagicTeaPartySummary({
  sessionId: session.id, expectedSnapshot: expected, patch: { summary: '新摘要', summarySections: undefined, summaryMeta: { updatedAt: 2 } },
});
describe('summary-only IndexedDB conditional transaction', () => {
  it('merges after commit while preserving current unrelated fields and all original messages', async () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ id: `${session.id}-${index}`, sessionId: session.id,
      role: 'user' as const, content: `原文${index}`, createdAt: index }));
    await Promise.all(messages.map(putMagicTeaPartyMessage));
    await putMagicTeaPartySession({ ...session, title: '别处改名', draft: '别处的新草稿',
      settings: { ...session.settings, temperature: 0.2 }, lastChoices: [{ id: 'new', text: '新选项' }] });
    const result = await patch();
    expect(result).toMatchObject({ summary: '新摘要', title: '别处改名', draft: '别处的新草稿',
      settings: { temperature: 0.2 }, lastChoices: [{ id: 'new', text: '新选项' }] });
    expect(await getMagicTeaPartySession(session.id)).toEqual(result);
    expect(await listMagicTeaPartyMessages(session.id)).toEqual(messages);
  });
  it.each(['summary', 'summarySections', 'summaryMeta', 'autoSummaryState', 'settings'] as const)('rejects stale %s without rewriting other-tab state', async field => {
    const concurrent = { ...session, [field]: field === 'summary' ? '别处的摘要' : field === 'summarySections' ? { 标题: '新小节' }
      : field === 'summaryMeta' ? { updatedAt: 3 } : field === 'autoSummaryState' ? { lastAttemptedThroughMessageId: 'm8' }
      : { ...session.settings, autoSummaryEnabled: false } };
    await putMagicTeaPartySession(concurrent);
    expect(await patch()).toBeNull();
    expect(await getMagicTeaPartySession(session.id)).toEqual(concurrent);
  });
  it('allows only one tab to claim a frozen source watermark', async () => {
    const args = { sessionId: session.id, expectedSnapshot: captureMagicTeaPartySummarySnapshot(session),
      patch: { autoSummaryState: { lastAttemptedThroughMessageId: 'm8' } } };
    const results = await Promise.all([compareAndPatchMagicTeaPartySummary(args), compareAndPatchMagicTeaPartySummary(args)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('abandoned owners and aborted writes make no changes', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await compareAndPatchMagicTeaPartySummary({ sessionId: session.id, expectedSnapshot: captureMagicTeaPartySummarySnapshot(session),
      patch: { summary: '过时' }, signal: controller.signal })).toBeNull();
    expect(await compareAndPatchMagicTeaPartySummary({ sessionId: session.id, expectedSnapshot: captureMagicTeaPartySummarySnapshot(session),
      patch: { summary: '过时' }, isCurrent: () => false })).toBeNull();
    expect(await getMagicTeaPartySession(session.id)).toEqual(session);
  });
  it('an explicit opt-in update preserves all latest cross-tab summary and unrelated fields', async () => {
    const latest = { ...session, summary: '新手改', draft: '新草稿', summaryMeta: { updatedAt: 9 } };
    await putMagicTeaPartySession(latest);
    const result = await setMagicTeaPartyAutoSummaryEnabled(session.id, false);
    expect(result).toMatchObject({ summary: '新手改', draft: '新草稿', summaryMeta: { updatedAt: 9 }, settings: { autoSummaryEnabled: false } });
  });

  it('never resurrects a session deleted during the original turn', async () => {
    await deleteMagicTeaPartySession(session.id);
    await expect(putMagicTeaPartySessionKeepingSummary(session)).rejects.toThrow('会话已删除');
    expect(await getMagicTeaPartySession(session.id)).toBeNull();
  });
  it('original-turn bookkeeping cannot resurrect an in-flight other-tab summary or opt-in', async () => {
    await putMagicTeaPartySession({ ...session, summary: '跨tab手改', summaryMeta: { updatedAt: 4 },
      settings: { ...session.settings, autoSummaryEnabled: false }, autoSummaryState: { lastAttemptedThroughMessageId: 'kept' } });
    const original = await putMagicTeaPartySessionKeepingSummary({ ...session, title: '本回合标题' });
    expect(original.summary).toBe('跨tab手改');
    const stored = await putMagicTeaPartySessionKeepingSummary({ ...session, title: '本回合标题',
      protocolShadow: { updatedAt: 9, drafts: [{ characterName: '旅人', currentStateSummary: '新状态' }], source: 'stream' } });
    expect(stored).toMatchObject({ title: '本回合标题', summary: '跨tab手改', summaryMeta: { updatedAt: 4 },
      settings: { autoSummaryEnabled: false }, autoSummaryState: { lastAttemptedThroughMessageId: 'kept' },
      protocolShadow: { source: 'stream', drafts: [{ characterName: '旅人', currentStateSummary: '新状态' }] } });
    expect(await patch()).toBeNull();
  });
});
