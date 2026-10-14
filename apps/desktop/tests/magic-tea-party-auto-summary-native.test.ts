import { describe, expect, it, vi } from 'vitest';
import type { TeaWriteRequest } from '@mahoshojo/contracts/desktop-magic-tea-party';
import type { ResolvedDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
import { DesktopTeaSession } from '../src/features/magic-tea-party/session';
import { teaSessionView } from '../src/features/magic-tea-party/direct';
import { createIpcTeaNativePort } from '../src/platform/magic-tea-party-native';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

const target: ResolvedDesktopAiTarget = { location: 'client', providerTarget: { kind: 'custom', profileId: 'tea-loopback' },
  profile: null, mode: 'direct-local', modelId: 'synthetic', availableModelIds: [], generationOverrides: undefined, unavailableReason: null };
const open = async (fault?: 'auto-begin' | 'auto-finish' | 'auto-stop') => {
  const probe = await startMagicTeaPartyJourneyProbe(); let sequence = 0; let armed = true; let requests = 0;
  const invoke: NonNullable<typeof probe.invoke> = async (command, args) => {
    if (command === 'mutate_magic_tea_party') {
      const write = (args?.request as TeaWriteRequest).request;
      if (armed && 'session' in write && write.session.autoSummaryState
        && (fault === 'auto-begin' && write.action === 'begin-generation' || fault === 'auto-finish' && write.action === 'finish-generation')) {
        armed = false; await probe.control('drop-next-write-reply', { action: write.action });
      }
    }
    if (command === 'stream_direct_ai' && ++requests === 2 && fault === 'auto-stop') {
      await probe.control('checkpoint', { action: 'model', chunks: ['自动摘要前缀😀', '不能迟到保存'], deferred: true });
    }
    return probe.invoke!(command, args);
  };
  const owner = new DesktopTeaSession(createIpcTeaNativePort(invoke), () => `auto-native-${++sequence}`, () => 900);
  try {
    await owner.importText(JSON.stringify({ schema: 'magic-tea-party.session.v1',
      session: { id: 'source', title: '自动摘要原生旅程', createdAt: 1, updatedAt: 1, roles: [], summary: '保留旧摘要',
        settings: { providerId: 'openai', modelId: 'synthetic', autoSummaryEnabled: true } },
      messages: Array.from({ length: 8 }, (_, index) => ({ id: `source-${index}`, sessionId: 'source', role: 'user', content: `原文${index}😀`, createdAt: index, status: 'done' })),
      roles: [], tachieAssets: [] }), 'json', () => true);
    const id = owner.getSnapshot().directory[0]!.id; await owner.select(id);
    expect(owner.getSnapshot().record!.session.settings.autoSummaryEnabled).toBe(false);
    expect(await probe.control('requestCount')).toMatchObject({ count: 0 });
    await owner.updateSettings({ autoSummaryEnabled: true, outputFormat: 'markdown', maxContextMessages: 2, summaryMinGapMessages: 8 });
    await probe.control('checkpoint', { action: 'model', chunks: ['正常剧情与摘要😀'], deferred: false });
    return { probe, owner, id, aiOptions: { ...probe.aiOptions, invoke } };
  } catch (error) {
    owner.dispose();
    await probe.close();
    throw error;
  }
};

// These are real Rust/SQLite and Direct loopback journeys, not renderer-only IPC mocks.
// The established binary environment gate is explicit; a configured invalid binary fails.
describe.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('real Native automatic summary journey', () => {
  it('persists one automatic attempt and exact archive messages across SQLite reopen without resuming a request', async () => {
    const { probe, owner, id, aiOptions } = await open(); const source = JSON.stringify(owner.getSnapshot().messages);
    try {
      await owner.start(target, aiOptions, () => true, { kind: 'continue' });
      const saved = owner.getSnapshot(); const through = saved.messages.at(-2)!.id;
      expect(await probe.control('requestCount')).toMatchObject({ count: 2 });
      expect(JSON.stringify(saved.messages.slice(0, 8))).toBe(source);
      expect(saved.record!.session).toMatchObject({ summary: '正常剧情与摘要😀', autoSummaryState: { lastAttemptedThroughMessageId: through },
        summaryMeta: { toMessageId: through, coverage: { sourceMessageCount: 9, omittedMessageCount: 7 } } });
      expect(teaSessionView(saved.record!.session).summaryMeta!.coverage!.selectedMessageIds).not.toContain(saved.messages.at(-1)!.id);
      await probe.control('reopen'); await owner.select(id);
      expect(await probe.control('requestCount')).toMatchObject({ count: 2 });
      expect(owner.getSnapshot().record!.session.autoSummaryState).toEqual({ lastAttemptedThroughMessageId: through });
      await owner.start(target, aiOptions, () => true, { kind: 'continue' });
      expect(await probe.control('requestCount')).toMatchObject({ count: 3 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
  it.each(['auto-begin', 'auto-finish'] as const)('resolves an unknown %s without a new model dispatch', async fault => {
    const { probe, owner, id, aiOptions } = await open(fault);
    try {
      const running = owner.start(target, aiOptions, () => true, { kind: 'continue' });
      await vi.waitFor(() => expect(owner.getSnapshot().pending).toBe('unknown'), { timeout: 5000 });
      const expectedCount = fault === 'auto-begin' ? 1 : 2;
      expect(await probe.control('requestCount')).toMatchObject({ count: expectedCount });
      await owner.resolvePending(); await running;
      expect(await probe.control('requestCount')).toMatchObject({ count: expectedCount });
      expect(owner.getSnapshot().record!.session.summary).toBe(fault === 'auto-begin' ? '保留旧摘要' : '正常剧情与摘要😀');
      await probe.control('reopen'); await owner.select(id);
      expect(await probe.control('requestCount')).toMatchObject({ count: expectedCount });
      expect(owner.getSnapshot().messages.at(-1)?.meta?.kind).toBe('summary');
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
  it('keeps the old SQLite summary and the new hand-edited draft after stopping automatic output', async () => {
    const { probe, owner, id, aiOptions } = await open('auto-stop');
    try {
      const running = owner.start(target, aiOptions, () => true, { kind: 'continue' });
      await vi.waitFor(() => expect(owner.getSnapshot().rawUnsaved).toBe('自动摘要前缀😀'), { timeout: 5000 });
      owner.stageSummary('用户保留手稿😀'); await running;
      expect(owner.getSnapshot().summaryDraft).toBe('用户保留手稿😀');
      expect(owner.getSnapshot().record!.session.summary).toBe('保留旧摘要');
      expect(owner.getSnapshot().messages.at(-1)).toMatchObject({ status: 'error', meta: { kind: 'summary', completion: 'stopped', rawOutput: '自动摘要前缀😀' } });
      await probe.control('checkpoint', { action: 'release' });
      await owner.saveDraft(); await probe.control('reopen'); await owner.select(id);
      expect(owner.getSnapshot().record!.session.summary).toBe('用户保留手稿😀');
      expect(await probe.control('requestCount')).toMatchObject({ count: 2 });
    } finally { owner.dispose(); await probe.close(); }
  }, 30000);
});
