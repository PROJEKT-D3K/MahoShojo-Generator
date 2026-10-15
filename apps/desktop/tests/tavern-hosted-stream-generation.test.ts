import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } from '@mahoshojo/domain/tavern-card';
import * as cardSchemas from '@mahoshojo/domain/data-card-schemas';
import * as safety from '@mahoshojo/domain/sensitive-word-filter';
import * as shield from '@mahoshojo/domain/shield-word-filter';
import type { HostedGenerationEvent } from '@mahoshojo/contracts/desktop-cloud';
import { executeTavernGeneration, type TavernGenerationInput, type TavernGenerationIntent } from '../src/features/tavern/generation';
import { CANCEL_HOSTED_AI_COMMAND, STREAM_HOSTED_AI_COMMAND, type HostedAiChannel } from '../src/platform/cloud-bridge';

const input: TavernGenerationInput = { raw: { name: 'Alice', description: '{{user}} 原件', custom: { keep: true } }, template: 'general', language: 'zh-CN', preference: { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } };
const intent: TavernGenerationIntent = { requestId: 'tavern-hosted', mode: 'hosted-stream', generationMode: 'stream', modelId: 'test-model' };
const done = (finishReason: unknown = 'stop') => ({ event: 'done', data: { ok: true, tavernCompletion: { version: 1, finishReason } } });
const text = (chunk: string) => ({ event: 'markdown', data: { chunk } });
const failure = (code: string, retryAfterSeconds?: number) => ({ event: 'error', data: { ok: false, error: '无法生成', code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } });
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(run: (emit: (event: unknown) => void) => Promise<void> | void = emit => { emit(text('# 标题\n完整正文')); emit(done()); }) {
  const started = deferred();
  const channel: HostedAiChannel = {};
  const invoke = vi.fn(async (command: string) => {
    if (command === CANCEL_HOSTED_AI_COMMAND) return false;
    expect(command).toBe(STREAM_HOSTED_AI_COMMAND);
    started.resolve();
    await run(event => channel.onmessage?.(event as HostedGenerationEvent));
  });
  const cooldown = vi.fn();
  return { invoke, started: started.promise, options: { invoke, profileId: '', providerTarget: { kind: 'system' as const }, createChannel: () => channel, onHostedDispatchSettled: cooldown }, cooldown };
}
afterEach(() => vi.restoreAllMocks());

describe('Tavern Hosted completion owner', () => {
  it.each(['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const)('accepts %s for system/preset only after original safety, shield and projection', async template => {
    for (const target of [{ kind: 'system' as const }, { kind: 'preset' as const, providerId: 'deepseek' }]) {
      const rawText = '# 整理结果\n完整正文 VPN';
      const native = harness(emit => { emit({ event: 'reasoning', data: { chunk: '不作正文' } }); emit(text(rawText)); emit(done()); });
      const check = vi.spyOn(safety, 'strictCheck'); const mask = vi.spyOn(shield, 'applyShieldWordsStrict');
      const outcome = await executeTavernGeneration({ ...native.options, providerTarget: target }, { ...input, template }, intent, new AbortController().signal);
      const cardKind = template === 'scenario' || template === 'general-scenario' ? 'general-scenario' : 'general';
      expect(outcome).toMatchObject({ status: 'completed', mode: 'hosted-stream', cardKind, rawText, card: { content: '# 整理结果\n完整正文 ❀❀❀', _tavern: { raw: input.raw } }, reasoning: { text: '不作正文' } });
      expect(check.mock.calls).toEqual([[''], [rawText]]); expect(mask.mock.calls).toEqual([[''], [rawText]]);
      expect(check.mock.invocationCallOrder[1]).toBeLessThan(mask.mock.invocationCallOrder[1]!);
      expect(native.invoke).toHaveBeenCalledTimes(1); expect(native.cooldown).toHaveBeenCalledExactlyOnceWith(undefined);
      vi.restoreAllMocks();
    }
  });
  it('freezes source, template and provider config before asynchronous readiness', async () => {
    const ready = deferred<Awaited<ReturnType<typeof safety.strictCheck>>>();
    const actual = safety.strictCheck; vi.spyOn(safety, 'strictCheck').mockImplementationOnce(() => ready.promise);
    const native = harness(); const source = structuredClone(input); const selected = structuredClone(intent);
    const pending = executeTavernGeneration(native.options, source, selected, new AbortController().signal);
    source.raw = { name: 'replacement' }; source.template = 'scenario'; selected.modelId = 'changed';
    ready.resolve(await actual('')); const result = await pending;
    expect(result).toMatchObject({ status: 'completed', cardKind: 'general', card: { _tavern: { raw: input.raw } } });
    expect(native.invoke.mock.calls[0]).toEqual([STREAM_HOSTED_AI_COMMAND, expect.objectContaining({ request: expect.objectContaining({ systemConfig: { modelId: 'test-model' }, body: expect.objectContaining({ template: 'general', sourceName: 'Alice' }) }) })]);
  });
  it.each(['input', 'request', 'sensitive-readiness', 'shield-readiness', 'cancel-readiness'] as const)('preflight %s performs zero invoke and no cooldown', async kind => {
    const native = harness(); const controller = new AbortController();
    const source = kind === 'input' ? { ...input, language: '' } : input;
    const selected = kind === 'request' ? { ...intent, requestId: '' } : intent;
    if (kind === 'sensitive-readiness') vi.spyOn(safety, 'strictCheck').mockRejectedValueOnce(new Error('本地敏感词检查失败'));
    if (kind === 'shield-readiness') vi.spyOn(shield, 'applyShieldWordsStrict').mockImplementationOnce(() => { throw new Error('本地屏蔽词处理失败'); });
    if (kind === 'cancel-readiness') vi.spyOn(safety, 'strictCheck').mockImplementationOnce(async () => { controller.abort(); return { hasSensitiveWords: false } as Awaited<ReturnType<typeof safety.strictCheck>>; });
    expect(await executeTavernGeneration(native.options, source, selected, controller.signal)).toMatchObject({ status: kind === 'cancel-readiness' ? 'cancelled' : 'failed' });
    expect(native.invoke).not.toHaveBeenCalled(); expect(native.cooldown).not.toHaveBeenCalled();
  });
  it.each(['length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown', null])('does not complete provider terminal %s', async reason => {
    const native = harness(emit => { emit(text('保留正文')); emit(done(reason)); });
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: '保留正文' });
  });
  it.each(['', ' \n\t', '{}', '[]', 'null', 'undefined'])('rejects empty body even with reasoning and stop', async body => {
    const native = harness(emit => { emit({ event: 'reasoning', data: { chunk: '推理正文' } }); emit(text(body)); emit(done()); });
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: body });
  });
  it('scans across chunks before shield and preserves the unshielded text on rejection', async () => {
    const native = harness(emit => { emit(text('po')); emit(text('rn')); emit(done()); });
    const mask = vi.spyOn(shield, 'applyShieldWordsStrict');
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: 'porn' });
    expect(mask.mock.calls).toEqual([['']]);
  });
  it.each(['sensitive', 'shield', 'empty-shield', 'domain'] as const)('rejects final %s failure after successful transport', async stage => {
    if (stage === 'sensitive') { const actual = safety.strictCheck; vi.spyOn(safety, 'strictCheck').mockImplementation(value => value ? Promise.reject(new Error('本地敏感词检查失败')) : actual(value)); }
    if (stage === 'shield' || stage === 'empty-shield') { const actual = shield.applyShieldWordsStrict; vi.spyOn(shield, 'applyShieldWordsStrict').mockImplementation(value => { if (!value) return actual(value); if (stage === 'shield') throw new Error('本地屏蔽词处理失败'); return { ...actual(value), filteredText: '' }; }); }
    if (stage === 'domain') vi.spyOn(cardSchemas, 'parseDataCardByTemplate').mockImplementationOnce(() => { throw new Error('domain rejected'); });
    const native = harness();
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'invalid-output', rawText: '# 标题\n完整正文' });
  });
  it.each(['legacy', 'eof', 'bad-ipc', 'post-version', 'cancel-event', 'late-reject', 'same-code-event'] as const)('keeps %s uncertain without replay', async kind => {
    const native = harness(emit => {
      emit(text('保留前缀'));
      if (kind === 'legacy') emit({ event: 'done', data: { ok: true } });
      if (kind === 'bad-ipc') emit({ event: 'markdown', data: { chunk: 5 } });
      if (kind === 'post-version') emit(failure('invalid-response'));
      if (kind === 'cancel-event') emit(failure('cancelled'));
      if (kind === 'same-code-event') emit(failure('invalid-request'));
      if (kind === 'late-reject') { emit(done()); throw { code: 'invalid-request', message: 'late rejection' }; }
    });
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'uncertain', rawText: '保留前缀' });
    expect(native.invoke).toHaveBeenCalledOnce(); expect(native.cooldown).toHaveBeenCalledOnce();
  });
  it.each(['protocol-mismatch', 'cancelled-before-dispatch'])('trusts bridge pre-dispatch phase for %s without cooldown', async code => {
    const native = harness(() => { throw { code, message: 'preparation rejected' }; });
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: code === 'protocol-mismatch' ? 'failed' : 'cancelled', rawText: '' });
    expect(native.cooldown).not.toHaveBeenCalled();
  });
  it.each(['rate-limited', 'server-rejected'])('preserves known %s failure and notifies cooldown once', async code => {
    const native = harness(emit => { emit(text('保留')); emit(failure(code, code === 'rate-limited' ? 7 : undefined)); });
    expect(await executeTavernGeneration(native.options, input, intent, new AbortController().signal)).toMatchObject({ status: 'failed', rawText: '保留', code, retryAfterSeconds: code === 'rate-limited' ? 7 : undefined });
    expect(native.cooldown).toHaveBeenCalledExactlyOnceWith(code === 'rate-limited' ? 7 : undefined);
  });
  it('retries early cancel once on the first nonterminal event even while the first cancel is unresolved', async () => {
    const gate = deferred(); const cancelReply = deferred<boolean>(); let emit!: (event: unknown) => void;
    const native = harness(async send => { emit = send; await gate.promise; });
    const base = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((command: string, ...args: unknown[]) => command === CANCEL_HOSTED_AI_COMMAND ? cancelReply.promise : base(command, ...args));
    const controller = new AbortController(); const pending = executeTavernGeneration(native.options, input, intent, controller.signal);
    await native.started; controller.abort();
    expect(native.invoke.mock.calls.filter(([command]) => command === CANCEL_HOSTED_AI_COMMAND)).toHaveLength(1);
    emit(text('迟到前缀')); emit(text('仍保留')); emit(done());
    expect(native.invoke.mock.calls.filter(([command]) => command === CANCEL_HOSTED_AI_COMMAND)).toHaveLength(2);
    let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    gate.resolve(); expect(await pending).toMatchObject({ status: 'uncertain', rawText: '迟到前缀仍保留' }); cancelReply.resolve(false);
    expect(native.cooldown).toHaveBeenCalledOnce();
    for (const call of native.invoke.mock.calls.filter(([command]) => command === CANCEL_HOSTED_AI_COMMAND)) expect(call[1]).toEqual({ requestId: intent.requestId });
  });
});
