import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseArenaHostedDetails } from '../src/features/arena/hosted';
const readyRanking = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/arena-generation-ranking.json', import.meta.url), 'utf8'));
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { LocalCardRecordV1 } from '@mahoshojo/local-library/record';
import type { DesktopArenaHostedChannelEvent, DesktopArenaHostedOperation } from '@mahoshojo/contracts/desktop-arena-hosted';
import { DesktopArenaSession, createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { ARENA_HOSTED_RECOVERY_KEYS } from '../src/features/arena/hosted-recovery';

const generationId = `arena_${'b'.repeat(64)}`;
const now = '2026-10-10T05:00:00.000Z';
const intent = { mode: 'hosted' as const, generationMode: 'stream' as const, modelId: 'default', systemConfig: {} };
const actor = { kind: 'anonymous' as const };
const body = '# 服务器故事\n\n完整正文';
const draft = (): ArenaDraft => ({ ...createInitialArenaDraft(), generationMode: 'stream', battleMode: 'daily',
  combatants: [{ type: 'general-character', filename: '甲.json', isValid: false, isPreset: false, data: { name: '甲', content: '源设定', signature: 'source-authority', adjudicationEvents: [{ type: 'binary', description: '源判定', probability: 50 }] } }],
  settings: { ...createInitialArenaDraft().settings, writeNarrativeHistory: true, writeArenaHistory: false, writeCurrentState: false } });
function storage() {
  const data = new Map<string, string>(); let fail = false;
  return { data, fail: () => { fail = true; }, recover: () => { fail = false; }, getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (fail) throw new Error('disk failed'); data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function fixture(product: 'battle' | 'arena' = 'battle', saved = storage(), feedback: { ranking?: unknown; nativeEvents?: DesktopArenaHostedChannelEvent[]; rejectAfterDone?: boolean; omitDone?: boolean; lateRanking?: unknown; failureCode?: string; duplicateCursor?: boolean } = {}) {
  const records = new Map<string, LocalCardRecordV1>(); let failSave = false, hold = false, release: (() => void) | undefined;
  const repository = { get: async (id: string) => records.get(id) ?? null, putIfAbsent: vi.fn(async (record: LocalCardRecordV1) => {
    if (failSave) throw new Error('disk failed'); if (records.has(record.id)) return { alreadyPresent: true }; records.set(record.id, record); return { written: true };
  }) } as unknown as CardRepository;
  const random = vi.fn(() => 0);
  const session = new DesktopArenaSession({ product, repository, storage: saved, now: () => now, requestId: () => feedback.nativeEvents?.[0]?.requestId ?? 'hosted-session-1', random,
    hostedTestPorts: { createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 } }); session.setScope('actor-A:target-A');
  const operations: DesktopArenaHostedOperation[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'arena_hosted_detach') { release?.(); return; }
    const request = args!.request as DesktopArenaHostedOperation; operations.push(request);
    if (request.operation === 'lookup-request' || request.operation === 'stop') return { status: request.operation === 'stop' ? 202 : 200,
      recoveryCredentialState: 'stored', body: { generationId, generationRequestId: request.requestId, status: request.operation === 'stop' ? 'cancelling' : 'completed' } };
    if (request.operation !== 'create-stream' && request.operation !== 'resume') throw new Error('unexpected command');
    const channel = args!.onEvent as { onmessage(event: DesktopArenaHostedChannelEvent): void }; let sequence = 0;
    if (feedback.nativeEvents) { for (const event of feedback.nativeEvents) channel.onmessage(event); return; }
    const send = (value: Record<string, unknown>) => channel.onmessage({ requestId: request.requestId, sequence: sequence++, ...value } as DesktopArenaHostedChannelEvent);
    send({ kind: 'response', status: 200, generationId, generationRequestId: request.requestId, metadataState: 'missing', recoveryCredentialState: 'stored' });
    send({ kind: 'sse-fragment', final: true, text: `id: 1-0\nevent: snapshot\ndata: ${JSON.stringify({ markdown: body, reasoning: '独立推理', status: hold ? 'running' : 'completed', telemetry: null, lastEventId: '1-0', updatedAt: now })}\n\n` });
    if (feedback.duplicateCursor) send({ kind: 'sse-fragment', final: true, text: 'id: 1-0\nevent: markdown\ndata: {"chunk":"rejected duplicate"}\n\n' });
    if ('ranking' in feedback) send({ kind: 'sse-fragment', final: true, text: `id: 1-1\nevent: ranking\ndata: ${JSON.stringify(feedback.ranking)}\n\n` });
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    if ('lateRanking' in feedback) send({ kind: 'sse-fragment', final: true, text: `id: 1-2\nevent: ranking\ndata: ${JSON.stringify(feedback.lateRanking)}\n\n` });
    if (feedback.omitDone) { send({ kind: 'stream-end' }); return; }
    send({ kind: 'sse-fragment', final: true, text: feedback.failureCode
      ? `id: 2-0\nevent: error\ndata: ${JSON.stringify({ status: 'failed', code: feedback.failureCode })}\n\n`
      : 'id: 2-0\nevent: done\ndata: {"status":"completed","ok":true}\n\n' }); send({ kind: 'stream-end' });
    if (feedback.rejectAfterDone) throw new Error('late-native-secret-canary');
  });
  return { session, saved, records, repository, invoke, operations, random, setHold: () => { hold = true; }, failSave: () => { failSave = true; }, recoverSave: () => { failSave = false; } };
}

describe('same Arena session with Hosted completion ownership', () => {
  it.each(['AI_OUTPUT_TRUNCATED', 'AI_STREAM_INCOMPLETE', 'AI_UPSTREAM_REQUEST_FAILED', 'AI_UPSTREAM_TIMEOUT'])(
    'retains %s only after the real C0/bridge/Native failure seal without completion effects', async failureCode => {
      const f = fixture('battle', storage(), { failureCode }); const source = draft(); f.session.updateDraft(source);
      await f.session.generateHosted({ invoke: f.invoke }, source, intent, actor);
      const state = f.session.getSnapshot(); expect(state.phase).toBe('failed');
      expect(state.draft.narrativeDrafts).toHaveLength(1); expect(state.narrativeDraftStatus).toBe('stored');
      expect(state.draft.narrativeDrafts?.[0]).toMatchObject({ requestId: 'hosted-session-1', markdown: body, source: 'hosted', completion: { kind: 'server-failed', code: failureCode } });
      expect(state.draft.narrativeHistoryEntries).toEqual([]); expect(state.draft.combatants).toEqual(source.combatants);
      expect(state.roleUpdates.items).toEqual([]); expect(state.candidates).toBeNull(); expect(f.records.size).toBe(0);
      const archive = f.session.exportNarrativeDrafts(); expect(archive).not.toContain('独立推理'); expect(archive).not.toContain('source-authority');
      f.session.dispose(); const reopened = fixture('battle', f.saved); reopened.session.restoreDraft();
      expect(reopened.session.getSnapshot().draft.narrativeDrafts).toEqual(state.draft.narrativeDrafts); reopened.session.dispose();
    },
  );
  it.each(['AI_OUTPUT_FILTERED', 'CONTENT_POLICY', 'UNKNOWN'])( 'does not retain rejected %s failures', async failureCode => {
    const f = fixture('battle', storage(), { failureCode }); f.session.updateDraft(draft());
    await f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
    expect(f.session.getSnapshot().draft.narrativeDrafts).toBeUndefined(); expect(f.session.getSnapshot().narrativeDraftCandidate).toBeNull(); f.session.dispose();
  });
  it('a genuine failed terminal cannot hide a later Native rejection from the session', async () => {
    const f = fixture('battle', storage(), { failureCode: 'AI_STREAM_INCOMPLETE', rejectAfterDone: true }); f.session.updateDraft(draft());
    await f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
    expect(f.session.getSnapshot().draft.narrativeDrafts).toBeUndefined(); expect(f.session.getSnapshot().narrativeDraftCandidate).toBeNull(); f.session.dispose();
  });
  it('C0忽略的重复SSE cursor仍会阻断failure seal，不能成为可存草稿', async () => {
    const f = fixture('battle', storage(), { failureCode: 'AI_STREAM_INCOMPLETE', duplicateCursor: true }); f.session.updateDraft(draft());
    await f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
    expect(f.session.getSnapshot().rawText).toBe(body); expect(f.session.getSnapshot().narrativeDraftCandidate).toBeNull();
    expect(f.session.getSnapshot().draft.narrativeDrafts).toBeUndefined(); f.session.dispose();
  });
  it.each(['battle', 'arena'] as const)('%s preserves source cards and Direct preferences; history appends once then explicitly saves', async (product) => {
    const f = fixture(product), source = draft(); f.session.updateDraft(source);
    const run = f.session.generateHosted({ invoke: f.invoke }, source, intent, actor);
    await f.session.generateHosted({ invoke: f.invoke }, source, intent, actor); await run;
    const state = f.session.getSnapshot(); expect(state.phase).toBe('completed'); expect(f.random).not.toHaveBeenCalled();
    expect(state.draft.combatants).toEqual(source.combatants); expect(state.draft.settings).toEqual(source.settings); expect(state.candidates).toBeNull();
    expect(f.operations.filter((op) => op.operation === 'create-stream')).toHaveLength(1);
    const request = f.operations.find((op) => op.operation === 'create-stream')!;
    if (request.operation !== 'create-stream') throw new Error('fixture');
    expect(request.body).toMatchObject({ writeArenaHistory: false, writeCurrentState: false }); expect(request.body).not.toHaveProperty('adjudicationResults');
    expect(state.report?.officialReport.winner).toBe(''); expect(state.draft.narrativeHistoryEntries).toHaveLength(1);
    expect(state.draft.narrativeHistoryEntries[0]).toMatchObject({ id: `arena-generation:${generationId}`, content: body, hostedSource: { metadataState: 'missing', signedCharacterUpdates: false } });
    expect(f.records.size).toBe(0); f.session.appendHostedHistory(); expect(state.draft.narrativeHistoryEntries).toHaveLength(1);
    expect(await f.session.save('characters')).toBe(false); expect(await f.session.save('history')).toBe(true); expect(await f.session.save('history')).toBe(true); expect(f.records.size).toBe(1);
    expect(JSON.parse(f.session.exportDocument()).result).toMatchObject({ rawText: body, reasoning: '独立推理', hostedGenerationId: generationId }); f.session.dispose();
  });
  it('requires input and execution delivery to match rather than silently translating JSON into streaming', async () => {
    const f = fixture(), input = { ...draft(), generationMode: 'non-stream' as const };
    await f.session.generateHosted({ invoke: f.invoke }, input, intent, actor); expect(f.invoke).not.toHaveBeenCalled(); expect(f.session.getSnapshot().message).toContain('输出方式'); f.session.dispose();
  });
  it('a failed prewritten pointer means no Native create or local roll', async () => {
    const f = fixture(); f.saved.fail(); await f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.random).not.toHaveBeenCalled(); expect(f.session.getSnapshot().phase).toBe('failed'); f.session.dispose();
  });
  it('stop accepts only cancellation state and keeps partial text without history or character effects', async () => {
    const f = fixture(); f.session.updateDraft(draft()); f.setHold();
    const run = f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor); await vi.waitFor(() => expect(f.session.getSnapshot().markdown).toBe(body));
    f.session.cancel(); await run; expect(f.session.getSnapshot()).toMatchObject({ phase: 'cancelled', rawText: body, candidates: null, hosted: { connectionState: 'cancelled' } });
    expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0); expect(f.records.size).toBe(0);
    expect(f.operations.filter((op) => op.operation === 'stop')).toHaveLength(1); f.session.dispose();
  });
  it('scope change detaches without server stop and does not accept a late terminal or write the old pointer', async () => {
    const f = fixture(); f.session.updateDraft(draft()); f.setHold();
    const run = f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor); await vi.waitFor(() => expect(f.session.getSnapshot().markdown).toBe(body));
    const pointer = f.saved.data.get(ARENA_HOSTED_RECOVERY_KEYS.battle); f.session.setScope('account-B:target-B'); await run;
    expect(f.session.getSnapshot().phase).toBe('cancelled'); expect(f.operations.some((op) => op.operation === 'stop')).toBe(false);
    expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0); expect(f.saved.data.get(ARENA_HOSTED_RECOVERY_KEYS.battle)).toBe(pointer); f.session.dispose();
  });
  it('explicit restart recovery reuses the same actor and only appends history on a separate action', async () => {
    const first = fixture(); const input = { ...draft(), settings: { ...draft().settings, writeNarrativeHistory: false } }; first.session.updateDraft(input);
    await first.session.generateHosted({ invoke: first.invoke }, input, intent, actor); first.session.dispose();
    const next = fixture('battle', first.saved); next.session.restoreDraft(); await next.session.restoreHosted({ invoke: next.invoke }, 'hosted-session-1');
    expect(next.operations.map((op) => op.operation)).toEqual(['lookup-request', 'resume']); expect(next.operations[0]).toMatchObject({ actor, restoreSession: true });
    expect(next.operations[1]).not.toHaveProperty('after'); expect(next.operations[1]).not.toHaveProperty('presetConfig');
    expect(next.session.getSnapshot().phase).toBe('completed'); expect(next.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0);
    next.session.appendHostedHistory(); next.session.appendHostedHistory(); expect(next.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1); next.session.dispose();
  });
  it('save failure preserves full output and retries the same unsigned history document', async () => {
    const f = fixture(); f.session.updateDraft(draft()); await f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
    f.failSave(); expect(await f.session.save('history')).toBe(false); expect(f.session.getSnapshot().saveError).toContain('完整原文仍在内存');
    expect(JSON.parse(f.session.exportDocument()).result.rawText).toBe(body); f.recoverSave(); expect(await f.session.save('history')).toBe(true); expect(f.records.size).toBe(1); f.session.dispose();
  });
  it('changing account after completion cannot append the previous active result', async () => {
    const f = fixture(), input = { ...draft(), settings: { ...draft().settings, writeNarrativeHistory: false } }; f.session.updateDraft(input);
    await f.session.generateHosted({ invoke: f.invoke }, input, intent, actor); f.session.setScope('account-B'); f.session.setScope('actor-A:target-A'); f.session.appendHostedHistory();
    expect(f.session.canAppendHostedHistory()).toBe(false); expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0); f.session.dispose();
  });
});

it.each(['cancel', 'detach', 'scope'] as const)('clears the transient soft warning immediately on %s without fabricating server termination', async action => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const f = fixture(); f.setHold();
  const run = f.session.generateHosted({ invoke: f.invoke }, draft(), intent, actor);
  try {
    await vi.waitFor(() => expect(f.session.getSnapshot().markdown).toBe(body));
    await vi.advanceTimersByTimeAsync(300_000); expect(f.session.getSnapshot().hosted?.softTimeoutWarning).toContain('300 秒');
    if (action === 'scope') f.session.setScope('actor-B:target-B'); else f.session[action]();
    expect(f.session.getSnapshot().hosted?.softTimeoutWarning).toBeNull(); await run;
    expect(f.session.getSnapshot().phase).toBe('cancelled');
    expect(f.operations.filter(op => op.operation === 'stop')).toHaveLength(action === 'cancel' ? 1 : 0);
  } finally { f.session.detach(); await run; f.session.dispose(); vi.useRealTimers(); }
});


describe('Hosted ranking is feedback, never owner authority', () => {
  const ranking = { ...readyRanking, generationId };
  it('freezes generation feedback, keeps old drafts readable and never retries local effects', async () => {
    const f = fixture('battle', storage(), { ranking }); const input = draft();
    f.session.updateDraft(input); await f.session.generateHosted({ invoke: f.invoke }, input, intent, actor);
    expect(f.session.getSnapshot()).toMatchObject({ phase: 'completed', hosted: { ranking } });
    expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1);
    f.session.updateDraft({ ...f.session.getSnapshot().draft, combatants: [] });
    expect(f.session.getSnapshot().hosted?.ranking).toEqual(ranking);
    f.session.appendHostedHistory(); expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1);
    expect(f.operations.map(op => op.operation)).toEqual(['create-stream']); expect(f.records.size).toBe(0);
    const details = f.session.getSnapshot().hosted!;
    expect(parseArenaHostedDetails({ ...details, ranking: undefined }, generationId)?.ranking).toBeNull();
    expect(parseArenaHostedDetails(details, readyRanking.generationId)?.ranking).toBeNull();
    expect(parseArenaHostedDetails(details, generationId)?.ranking).toEqual(ranking);
    f.session.retryDraftSave(); f.session.dispose();
    const restored = fixture('battle', f.saved); restored.session.restoreDraft();
    expect(restored.session.getSnapshot().hosted?.ranking).toEqual(ranking);
    expect(restored.operations).toHaveLength(0); expect(restored.records.size).toBe(0); restored.session.dispose();
  });
  it.each(['missing-done', 'late-native-rejection'] as const)('ranking cannot authorize completion/history/save after %s', async fault => {
    const f = fixture('battle', storage(), { ranking, omitDone: fault === 'missing-done', rejectAfterDone: fault === 'late-native-rejection' });
    const input = draft(); f.session.updateDraft(input); await f.session.generateHosted({ invoke: f.invoke }, input, intent, actor);
    expect(f.session.getSnapshot().phase).toBe('failed'); expect(f.session.getSnapshot().hosted?.ranking).toEqual(ranking);
    expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0);
    expect(await f.session.save('history')).toBe(false); expect(await f.session.save('characters')).toBe(false);
    expect(f.records.size).toBe(0); expect(f.operations.map(op => op.operation)).toEqual(['create-stream']); f.session.dispose();
  });
  it.each(['cancel', 'scope', 'dispose'] as const)('late feedback cannot cross %s or trigger effects', async action => {
    const f = fixture('battle', storage(), { ranking, lateRanking: { success: false, generationId, error: 'late ranking' } }); f.setHold();
    const input = draft(); f.session.updateDraft(input); const run = f.session.generateHosted({ invoke: f.invoke }, input, intent, actor);
    await vi.waitFor(() => expect(f.session.getSnapshot().hosted?.ranking).toEqual(ranking));
    if (action === 'scope') f.session.setScope('other-account'); else if (action === 'dispose') f.session.dispose(); else f.session.cancel();
    await run; expect(f.session.getSnapshot().hosted?.ranking).toEqual(ranking);
    expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(0); expect(f.records.size).toBe(0); f.session.dispose();
  });
});

const nativeRankingFixture = process.env.ARENA_NATIVE_RANKING_EVENTS_OUTPUT;
it.skipIf(!nativeRankingFixture)('consumes real runtime → Native loopback → unchanged Channel through the completion owner', async () => {
  const nativeEvents = JSON.parse(readFileSync(nativeRankingFixture!, 'utf8')) as DesktopArenaHostedChannelEvent[];
  const f = fixture('battle', storage(), { nativeEvents }); const input = draft(); f.session.updateDraft(input);
  await f.session.generateHosted({ invoke: f.invoke }, input, intent, actor);
  expect(f.session.getSnapshot()).toMatchObject({ phase: 'completed', hostedGenerationId: readyRanking.generationId, hosted: { ranking: readyRanking } });
  expect(f.session.getSnapshot().markdown).toContain('合成战报');
  expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1);
  expect(f.operations.map(op => op.operation)).toEqual(['create-stream']); expect(f.records.size).toBe(0);
  f.session.appendHostedHistory(); expect(f.session.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1); f.session.dispose();
});
