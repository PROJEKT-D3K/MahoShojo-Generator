import { tavernModelResult } from './tavern-character-fixtures';
import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, readTavernLocalDocument, validateTavernRaw } from '@mahoshojo/domain/tavern-card';
import type { AiExecutionRequest } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { CANCEL_DIRECT_AI_COMMAND, STREAM_DIRECT_AI_COMMAND } from '../src/platform/direct-ai-bridge';
import { TavernAiSession, TAVERN_AI_DRAFT_KEY } from '../src/features/tavern/session';
import type { TavernAiTemplate, TavernGenerationInput, TavernGenerationIntent } from '../src/features/tavern/generation';
import { DesktopGenerationSession, type GenerationExecutor } from '../src/features/generation/session';
import type { DesktopGenerationOutcome } from '../src/features/generation/executor';
const input: TavernGenerationInput = { raw: { name: 'Alice', description: '{{user}} 原件' }, template: 'general', language: 'zh-CN', preference: { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } };
const completed: DesktopGenerationOutcome<TavernAiTemplate> = { status: 'completed', mode: 'direct-local', cardKind: 'general', card: { templateId: '通用角色', name: '整理结果', content: '正文', _tavern: { raw: input.raw } }, rawText: '模型原文' };
const storage = () => { const map = new Map<string, string>(); return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; };
const repository = {} as CardRepository;
const options = { invoke: vi.fn(), profileId: 'original' };
const intent = { mode: 'direct-local' as const, generationMode: 'non-stream' as const };
describe('Tavern uses the existing generation owner', () => {
  it('freezes input, blocks repeated requests, retains cancelled raw text and ignores late cards', async () => {
    let finish!: (value: DesktopGenerationOutcome<TavernAiTemplate>) => void; let signal!: AbortSignal;
    const execute = vi.fn<GenerationExecutor<TavernGenerationInput, TavernGenerationIntent, TavernAiTemplate>>(async (_options, _input, _intent, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
    const session = new TavernAiSession({ storage: storage(), repository, execute });
    expect(session).toBeInstanceOf(DesktopGenerationSession);
    session.updateDraft({ language: input.language, input });
    const first = session.generate(options, input, intent);
    await session.generate(options, { ...input, template: 'general-scenario' }, intent);
    session.updateDraft({ language: 'new', input: null }); session.clearOutput();
    expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0]![1]).toEqual(input); expect(execute.mock.calls[0]![1]).not.toBe(input);
    expect(session.getSnapshot().draft.input).toEqual(input);
    session.cancel(); expect(signal.aborted).toBe(true); finish(completed); await first;
    expect(session.getSnapshot()).toMatchObject({ phase: 'cancelled', card: null, rawText: '模型原文' });
  });
  it('restores result and original without replay, then clears old input and output together on explicit replacement', async () => {
    const disk = storage(); const execute = vi.fn(async () => completed);
    const session = new TavernAiSession({ storage: disk, repository, execute }); session.updateDraft({ language: input.language, input });
    await session.generate(options, input, intent); session.dispose();
    const restored = new TavernAiSession({ storage: disk, repository, execute }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ resultRestored: true, draft: { input }, card: completed.card });
    expect(execute).toHaveBeenCalledTimes(1); expect(restored.resultSignatureKind()).toBe('unsigned');
    restored.clearOutput(); restored.updateDraft({ language: 'zh-CN', input: null });
    const again = new TavernAiSession({ storage: disk, repository, execute }); again.restoreDraft(false);
    expect(again.getSnapshot()).toMatchObject({ draft: { input: null }, card: null, rawText: '' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves malformed drafts and protects failed writes', async () => {
    const disk = storage(); disk.map.set(TAVERN_AI_DRAFT_KEY, '{broken');
    const session = new TavernAiSession({ storage: disk, repository }); session.updateDraft({ language: input.language, input });
    expect(session.isDraftBlocked()).toBe(true); expect(session.hasUnsavedDraft()).toBe(true); expect(disk.map.get(TAVERN_AI_DRAFT_KEY)).toBe('{broken');
    const failed = new TavernAiSession({ storage: { ...storage(), setItem: () => { throw new Error('full'); } }, repository, execute: async () => completed });
    await failed.generate(options, input, intent); expect(failed.hasUnsavedDraft()).toBe(true); expect(failed.getSnapshot().card).toEqual(completed.card);
  });
  it.each(['direct-local', 'direct-remote'] as const)('saves unsigned %s provenance and intact original; a failed save retries without generation', async mode => {
    const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ written: true });
    const execute = vi.fn(async () => ({ ...completed, mode, card: { ...completed.card, signature: 'forged', isPreset: true } }));
    const session = new TavernAiSession({ storage: storage(), repository: { putIfAbsent } as unknown as CardRepository, execute });
    session.updateDraft({ language: input.language, input }); await session.generate(options, input, { ...intent, mode });
    expect(await session.saveResult()).toBe(false); expect(session.getSnapshot().card).toEqual(completed.card);
    expect(await session.saveResult()).toBe(true); expect(execute).toHaveBeenCalledTimes(1); expect(putIfAbsent).toHaveBeenCalledTimes(2);
    expect(putIfAbsent.mock.calls[1]![0]).toMatchObject({ storageLocation: 'local', cardType: 'character', title: '整理结果', data: completed.card, provenance: { kind: 'unsigned', execution: mode } });
    expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('signature'); expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('isPreset');
  });

  it.each(['direct-local', 'direct-remote', 'hosted-json'] as const)('restores and saves structured %s as unsigned, retaining raw after save failure', async mode => {
    const disk = storage();
    const selected = { ...input, template: 'scenario' as const, raw: { ...(input.raw as object), extensions: { keep: ['all'] } } };
    const card = { title: '结构情景', scenario_type: '互动', description: '简介', elements: { scene: {}, events: '事件', atmosphere: '轻松', development: [] }, _tavern: { raw: selected.raw } };
    const execute = vi.fn(async () => ({ ...completed, mode, cardKind: 'scenario' as const, card: { ...card, signature: 'forged', isPreset: true, metadata: { signature: 'forged' } } }));
    const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ written: true });
    const repository = { putIfAbsent } as unknown as CardRepository;
    const session = new TavernAiSession({ storage: disk, repository, execute });
    session.updateDraft({ language: selected.language, input: selected }); await session.generate(options, selected, { ...intent, mode });
    const stored = JSON.parse(disk.getItem(TAVERN_AI_DRAFT_KEY)!);
    const appFields = { metadata: { created_at: '2026-01-01T00:00:00Z' }, adjudicationEvents: [{ id: 'event-1', description: '保留判定', type: 'binary', probability: 50 }], creationInputs: { template: 'scenario', freeformBrief: '用户编辑', questionnaires: [], questionnaireAnswers: [], buildRules: [] } };
    Object.assign(stored.output.card, JSON.parse(JSON.stringify(appFields)));
    stored.output.card.signature = 'restored-forged'; stored.output.card.metadata.signature = 'restored-forged';
    disk.setItem(TAVERN_AI_DRAFT_KEY, JSON.stringify(stored)); session.dispose();
    const restored = new TavernAiSession({ storage: disk, repository, execute }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ resultRestored: true, cardKind: 'scenario', card, draft: { input: selected } });
    expect(restored.getSnapshot().card).toMatchObject(appFields);
    expect(restored.resultSignatureKind()).toBe('unsigned'); expect(restored.getSnapshot().card).not.toHaveProperty('metadata.signature');
    expect(await restored.saveResult()).toBe(false); expect(restored.getSnapshot().card).toMatchObject(card);
    expect(await restored.saveResult()).toBe(true); expect(execute).toHaveBeenCalledOnce();
    expect(putIfAbsent.mock.calls[1]![0]).toMatchObject({ cardType: 'scenario', title: card.title, data: card, provenance: { kind: 'unsigned', execution: mode === 'hosted-json' ? 'hosted' : mode } });
    expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('signature');
    expect(putIfAbsent.mock.calls[1]![0].data).not.toHaveProperty('metadata.signature');
    expect(putIfAbsent.mock.calls[1]![0].data).toMatchObject(appFields);
  });

});


it.each(['magical-girl', 'canshou'] as const)('restores and saves %s as an unsigned character without replay or answer loss', async template => {
  const disk = storage(); const selected = { ...input, template };
  const card = { ...tavernModelResult(template), userAnswers: { legacy: { question: '旧问题', value: '旧回答' } }, _custom: { retained: true }, _tavern: { raw: input.raw }, signature: 'old-claim', isPreset: true };
  const execute = vi.fn(async () => ({ ...completed, cardKind: template, card }));
  const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockResolvedValue({ written: true });
  const repo = { putIfAbsent } as unknown as CardRepository;
  const session = new TavernAiSession({ storage: disk, repository: repo, execute });
  session.updateDraft({ language: input.language, input: selected }); await session.generate(options, selected, intent); session.dispose();
  const restored = new TavernAiSession({ storage: disk, repository: repo, execute }); restored.restoreDraft(false);
  expect(restored.getSnapshot()).toMatchObject({ resultRestored: true, cardKind: template, card: { userAnswers: card.userAnswers, _custom: card._custom, _tavern: card._tavern } });
  expect(await restored.saveResult()).toBe(true); expect(execute).toHaveBeenCalledOnce();
  expect(putIfAbsent.mock.calls[0]![0]).toMatchObject({ cardType: 'character', title: template === 'magical-girl' ? '星花' : '雾兽', provenance: { kind: 'unsigned' } });
  expect(putIfAbsent.mock.calls[0]![0].data).not.toHaveProperty('signature');
  expect(putIfAbsent.mock.calls[0]![0].data).not.toHaveProperty('isPreset');
});


// Keep the executor and session real; only replace the Native channel and invocation boundary.
function nativeStream() {
  let request!: AiExecutionRequest; let send!: (event: AiStreamEvent) => void; let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === CANCEL_DIRECT_AI_COMMAND) { finish(); return; }
    expect(command).toBe(STREAM_DIRECT_AI_COMMAND);
    request = args!.request as AiExecutionRequest;
    send = (args!.onEvent as { onmessage: typeof send }).onmessage;
    await done;
  });
  let sequence = 0;
  const identity = () => ({ requestId: request.requestId, contractVersion: 1 as const, mode: request.mode });
  const emit = (event: Record<string, unknown>) => send({ ...identity(), sequence: sequence++, ...event } as AiStreamEvent);
  return { invoke, emit, finish, identity, options: { invoke, profileId: 'profile', createChannel: () => ({}) } };
}

describe('Tavern Markdown owns real generation and recovery', () => {
  const streamIntent = { mode: 'direct-local' as const, generationMode: 'stream' as const };
  const markdown = '# 完整结果\n名字：角色名\n情景名：情景名\n\n正文';
  it('shows accepted body while busy, ignores draft edits and duplicate generation, and never saves a late card after cancel', async () => {
    const disk = storage(); const native = nativeStream(); const putIfAbsent = vi.fn();
    const session = new TavernAiSession({ storage: disk, repository: { putIfAbsent } as unknown as CardRepository, requestId: () => 'tavern-cancel' });
    session.updateDraft({ language: input.language, generationMode: 'stream', input });
    const pending = session.generate(native.options, input, streamIntent);
    native.emit({ type: 'started' }); native.emit({ type: 'text-delta', delta: '# 已收到正文' });
    native.emit({ type: 'reasoning-delta', delta: '不能进入正文' });
    await vi.waitFor(() => expect(session.getSnapshot().rawText).toBe('# 已收到正文'));
    expect(session.getSnapshot()).toMatchObject({ phase: 'generating', activeGenerationMode: 'stream', card: null });
    await session.generate(native.options, { ...input, template: 'scenario' }, streamIntent);
    session.updateDraft({ language: 'changed', generationMode: 'non-stream', input: null }); session.clearOutput();
    expect(session.getSnapshot().draft).toMatchObject({ language: input.language, generationMode: 'stream', input });
    expect(native.invoke).toHaveBeenCalledOnce();
    session.cancel();
    native.emit({ type: 'result', result: { ...native.identity(), status: 'completed', finishReason: 'stop', output: { text: markdown } } });
    native.finish(); await pending;
    expect(session.getSnapshot()).toMatchObject({ phase: 'cancelled', card: null, rawText: '# 已收到正文' });
    expect(await session.saveResult()).toBe(false); expect(putIfAbsent).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith(CANCEL_DIRECT_AI_COMMAND, { requestId: 'tavern-cancel' });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(JSON.parse(disk.getItem(TAVERN_AI_DRAFT_KEY)!).output).toMatchObject({ phase: 'cancelled', rawText: '# 已收到正文', card: null });
    session.dispose();
  });
  it.each(['EOF', 'identity'] as const)('retains accepted body after %s in a recoverable failed draft without dispatch on restore', async failure => {
    const disk = storage(); const native = nativeStream();
    const session = new TavernAiSession({ storage: disk, repository });
    session.updateDraft({ language: input.language, generationMode: 'stream', input });
    const pending = session.generate(native.options, input, streamIntent);
    native.emit({ type: 'started' }); native.emit({ type: 'text-delta', delta: '# 保留的残稿' });
    if (failure === 'identity') native.emit({ type: 'text-delta', requestId: 'foreign-request', delta: '禁止混入' });
    native.finish(); await pending;
    expect(session.getSnapshot()).toMatchObject({ phase: 'failed', card: null, rawText: '# 保留的残稿' });
    session.dispose();
    const restored = new TavernAiSession({ storage: disk, repository }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ draft: { generationMode: 'stream', input }, phase: 'failed', card: null, rawText: '# 保留的残稿', activeGenerationMode: null });
    expect(native.invoke).toHaveBeenCalledOnce(); restored.dispose();
  });
  it.each(['magical-girl', 'scenario'] as const)('restores old JSON and new Markdown %s drafts by actual result kind with intact metadata and original', async template => {
    for (const generationMode of ['non-stream', 'stream'] as const) {
      const disk = storage(); const native = nativeStream(); const selected = { ...input, template };
      const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockResolvedValue({ written: true });
      const repo = { putIfAbsent } as unknown as CardRepository;
      const session = new TavernAiSession({ storage: disk, repository: repo });
      session.updateDraft({ language: input.language, generationMode, input: selected });
      const pending = session.generate(native.options, selected, { ...streamIntent, generationMode });
      const text = generationMode === 'stream' ? markdown : JSON.stringify(tavernModelResult(template));
      native.emit({ type: 'started' }); native.emit({ type: 'text-delta', delta: text });
      native.emit({ type: 'result', result: { ...native.identity(), status: 'completed', finishReason: 'stop', output: { text } } });
      native.finish(); await pending;
      expect(session.getSnapshot().phase).toBe('completed');
      const stored = JSON.parse(disk.getItem(TAVERN_AI_DRAFT_KEY)!);
      if (generationMode === 'non-stream') delete stored.generationMode;
      const appFields = template === 'scenario' || generationMode === 'stream'
        ? { metadata: { created_at: '2026-01-01T00:00:00Z' } } : { current_state: { summary: '保留状态', fields: [] } };
      Object.assign(stored.output.card, appFields);
      stored.output.card._tavern.importLabel = '保留的导入信息';
      stored.output.card._custom = { retained: ['中文', 1] };
      stored.output.card.signature = 'forged'; stored.output.card.isPreset = true;
      disk.setItem(TAVERN_AI_DRAFT_KEY, JSON.stringify(stored)); session.dispose();
      const restored = new TavernAiSession({ storage: disk, repository: repo });
      expect(restored.getSnapshot().pendingRestore).toBe(true); restored.restoreDraft(false);
      const cardKind = generationMode === 'non-stream' ? template : template === 'scenario' ? 'general-scenario' : 'general';
      expect(restored.getSnapshot()).toMatchObject({ resultRestored: true, activeGenerationMode: null, cardKind, rawText: text,
        draft: { generationMode, input: selected }, card: { ...appFields, _custom: { retained: ['中文', 1] }, _tavern: { raw: input.raw, importLabel: '保留的导入信息' } } });
      expect(restored.resultSignatureKind()).toBe('unsigned'); expect(restored.getSnapshot().card).not.toHaveProperty('signature');
      expect(restored.getSnapshot().card).not.toHaveProperty('isPreset');
      expect(restored.resultCardType()).toBe(template === 'scenario' ? 'scenario' : 'character');
      expect(await restored.saveResult()).toBe(true);
      expect(putIfAbsent.mock.calls[0]![0]).toMatchObject({ cardType: template === 'scenario' ? 'scenario' : 'character', data: restored.getSnapshot().card, provenance: { kind: 'unsigned', execution: 'direct-local' } });
      expect(native.invoke).toHaveBeenCalledOnce(); restored.dispose();
    }
  });
  it.each(['oversize', 'write failure'] as const)('keeps a completed Markdown result and exportable original in memory on draft %s', async failure => {
    const disk = storage();
    const failingDisk = failure === 'write failure' ? { ...disk, setItem: () => { throw new Error('disk full'); } } : disk;
    // The original is valid alone; persisting it in both the input and completed card exceeds the draft budget.
    const raw = { ...(input.raw as object), extensions: { source: failure === 'oversize' ? 'x'.repeat(2_200_000) : '保留未知字段' } };
    const selected = { ...input, raw, template: 'scenario' as const }; const native = nativeStream();
    const session = new TavernAiSession({ storage: failingDisk, repository });
    session.updateDraft({ language: input.language, generationMode: 'stream', input: selected });
    const pending = session.generate(native.options, selected, streamIntent);
    native.emit({ type: 'started' }); native.emit({ type: 'text-delta', delta: markdown });
    native.emit({ type: 'result', result: { ...native.identity(), status: 'completed', finishReason: 'stop', output: { text: markdown } } });
    native.finish(); await pending;
    const state = session.getSnapshot();
    expect(state).toMatchObject({ phase: 'completed', draftSaved: false, cardKind: 'general-scenario', rawText: markdown, card: { content: markdown, _tavern: { raw } } });
    expect(state.draftError).toContain('草稿写入失败'); expect(session.hasUnsavedDraft()).toBe(true); expect(session.hasUnsavedResult()).toBe(true);
    const original = validateTavernRaw((state.card!._tavern as { raw: unknown }).raw);
    const exported = new TextEncoder().encode(JSON.stringify(original));
    expect(readTavernLocalDocument(exported, 'json').candidates[0].parsed).toEqual(raw);
    expect(native.invoke).toHaveBeenCalledOnce(); session.dispose();
  });
});

describe('Tavern Hosted stream session acceptance', () => {
  function hostedNative() {
    let send!: (event: unknown) => void; let finish!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const settled = new Promise<void>(resolve => { finish = resolve; });
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'cancel_hosted_ai') return false;
      expect(command).toBe('stream_hosted_ai');
      send = (args!.onEvent as { onmessage: typeof send }).onmessage; started(); await settled;
    });
    return { ready, invoke, emit: (event: unknown) => send(event), finish, options: { invoke, profileId: '', providerTarget: { kind: 'system' as const }, createChannel: () => ({}) } };
  }
  const stream = { mode: 'hosted-stream' as const, generationMode: 'stream' as const };
  const done = { event: 'done', data: { ok: true, tavernCompletion: { version: 1, finishReason: 'stop' } } };
  it('persists an interrupted Hosted stream as uncertain, retains input/body, and restores without generation', async () => {
    const disk = storage(); const native = hostedNative(); const putIfAbsent = vi.fn();
    const session = new TavernAiSession({ storage: disk, repository: { putIfAbsent } as unknown as CardRepository, requestId: () => 'hosted-session' });
    session.updateDraft({ language: input.language, generationMode: 'stream', input });
    const pending = session.generate(native.options, input, stream); await native.ready;
    native.emit({ event: 'markdown', data: { chunk: '已收到前缀' } });
    await session.generate(native.options, { ...input, template: 'scenario' }, stream);
    session.updateDraft({ language: 'new', input: null }); session.clearOutput();
    expect(session.getSnapshot().draft).toMatchObject({ input, generationMode: 'stream' });
    session.cancel();
    expect(JSON.parse(disk.getItem(TAVERN_AI_DRAFT_KEY)!).output).toMatchObject({ phase: 'uncertain', rawText: '已收到前缀', card: null });
    const restored = new TavernAiSession({ storage: disk, repository }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ phase: 'uncertain', rawText: '已收到前缀', card: null });
    expect(native.invoke.mock.calls.filter(([command]) => command === 'stream_hosted_ai')).toHaveLength(1);
    native.emit(done); native.finish(); await pending;
    expect(session.getSnapshot()).toMatchObject({ phase: 'uncertain', card: null, rawText: '已收到前缀' });
    expect(await session.saveResult()).toBe(false); expect(putIfAbsent).not.toHaveBeenCalled(); session.dispose(); restored.dispose();
  });
  it('saves and restores the actual stream kind and retries storage only', async () => {
    const disk = storage(); const native = hostedNative();
    const putIfAbsent = vi.fn<CardRepository['putIfAbsent']>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue({ written: true });
    const repo = { putIfAbsent } as unknown as CardRepository; const selected = { ...input, template: 'scenario' as const };
    const session = new TavernAiSession({ storage: disk, repository: repo });
    session.updateDraft({ language: input.language, generationMode: 'stream', input: selected });
    const pending = session.generate(native.options, selected, stream); await native.ready;
    native.emit({ event: 'markdown', data: { chunk: '# 情景\n完整正文' } }); native.emit(done); native.finish(); await pending;
    expect(session.getSnapshot()).toMatchObject({ phase: 'completed', cardKind: 'general-scenario', card: { content: '# 情景\n完整正文', _tavern: { raw: input.raw } } });
    expect(await session.saveResult()).toBe(false); expect(await session.saveResult()).toBe(true);
    expect(putIfAbsent.mock.calls[1]![0]).toMatchObject({ cardType: 'scenario', provenance: { kind: 'unsigned', execution: 'hosted' } });
    session.dispose(); const restored = new TavernAiSession({ storage: disk, repository: repo }); restored.restoreDraft(false);
    expect(restored.getSnapshot()).toMatchObject({ phase: 'completed', resultRestored: true, cardKind: 'general-scenario', draft: { generationMode: 'stream', input: selected } });
    expect(native.invoke).toHaveBeenCalledOnce(); restored.dispose();
  });
  it.each(['hosted-stream', 'hosted-json'] as const)('treats late abort in %s cooldown as uncertain using the real executor', async mode => {
    const disk = storage(); const native = hostedNative();
    const session = new TavernAiSession({ storage: disk, repository }); session.updateDraft({ language: input.language, input, generationMode: mode === 'hosted-stream' ? 'stream' : 'non-stream' });
    const jsonInvoke = vi.fn(async () => ({ status: 200, body: tavernModelResult('general') }));
    const pending = session.generate({ ...native.options, invoke: mode === 'hosted-stream' ? native.invoke : jsonInvoke, onHostedDispatchSettled: () => session.cancel() } as typeof native.options,
      input, mode === 'hosted-stream' ? stream : { mode, generationMode: 'non-stream' });
    if (mode === 'hosted-stream') { await native.ready; native.emit({ event: 'markdown', data: { chunk: '完整但已取消' } }); native.emit(done); native.finish(); }
    await pending;
    expect(session.getSnapshot()).toMatchObject({ phase: 'uncertain', card: null });
    expect(session.getSnapshot().rawText).not.toBe(''); expect(session.getSnapshot().message).toContain('重复调用与费用');
    expect(JSON.parse(disk.getItem(TAVERN_AI_DRAFT_KEY)!).output.phase).toBe('uncertain'); expect(await session.saveResult()).toBe(false); session.dispose();
  });
});
