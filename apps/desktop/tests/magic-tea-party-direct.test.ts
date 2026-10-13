import { describe, expect, it, vi } from 'vitest';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { applyMagicTeaPartyMessageLimits, buildMagicTeaPartyHistory, buildMagicTeaPartyMainPrompt, estimateMagicTeaPartyTokens, resolveMagicTeaPartyMessageCharLimit, resolveMagicTeaPartyTokenBudget, trimMagicTeaPartyHistory } from '@mahoshojo/ai-core/magic-tea-party';
import type { TeaReadRequest, TeaReadResponse } from '@mahoshojo/contracts/desktop-magic-tea-party';
import type { ResolvedDesktopAiTarget } from '../src/features/ai-config/desktop-ai-config';
import { desktopTeaSettings, executeTeaDirect, prepareTeaDirectRequest, teaSessionView, teaTerminalMessage, type TeaRecord } from '../src/features/magic-tea-party/direct';
import type { TeaNativePort } from '../src/platform/magic-tea-party-native';

export const target: ResolvedDesktopAiTarget = { location: 'client', providerTarget: { kind: 'custom', profileId: 'tea-loopback' }, profile: null,
  mode: 'direct-local', modelId: 'synthetic', availableModelIds: ['synthetic'], generationOverrides: undefined, unavailableReason: null };
const record = (): TeaRecord => ({ instance: 'a'.repeat(32), revision: 1, session: { id: 'tea', title: '星光', createdAt: 1, updatedAt: 1, roles: [],
  settings: { providerId: 'openai', modelId: 'synthetic', maxContextMessages: 3, contextWindowTokens: 8192 } } });
const rows = [1, 2, 3, 4].map(id => ({ ordinal: id, message: { id: `m${id}`, sessionId: 'tea', createdAt: id, role: 'user' as const, content: id === 3 ? '中😀'.repeat(20000) : `row-${id}` } }));
const paged = (source = rows) => {
  const read = vi.fn(async (input: TeaReadRequest): Promise<TeaReadResponse> => {
    if (input.request.action !== 'messages') throw new Error('unexpected');
    const index = input.request.cursor?.ordinal ?? 0; const page = source.slice(index, index + 2);
    const last = page.at(-1);
    return { version: 1, result: { action: 'messages', catalogRevision: 1, sessionId: 'tea', instance: 'a'.repeat(32), revision: 1, rows: page,
      nextCursor: last && index + page.length < source.length ? { ordinal: last.ordinal, id: last.message.id } : null } };
  });
  return { read, mutate: vi.fn() } satisfies TeaNativePort;
};
describe('Desktop Tea actual shared prompt and Direct bridge', () => {
  it('constructs the same Web history pipeline through two bounded revision-fenced passes', async () => {
    const value = record(); const port = paged();
    const input = { id: 'new', sessionId: 'tea', createdAt: 5, role: 'user' as const, content: '继续喝茶' };
    const request = await prepareTeaDirectRequest(port, value, target, input, 'request', () => true);
    const session = teaSessionView(value.session); const base = { session, roles: [], messages: [], worldbookText: '', stylePrompt: '', requestChoices: false };
    const budget = resolveMagicTeaPartyTokenBudget(session.settings, 'openai');
    const history = buildMagicTeaPartyHistory([...rows.map(row => row.message), input], { includeEmptyContent: false });
    const selected = trimMagicTeaPartyHistory(history, { maxMessages: budget.maxContextMessages,
      tokenBudget: Math.max(0, budget.historyBudgetTokens - estimateMagicTeaPartyTokens(buildMagicTeaPartyMainPrompt(base), 'openai')), providerId: 'openai', userDisplayName: '旅人', minKeep: 2 });
    const limited = applyMagicTeaPartyMessageLimits(selected, resolveMagicTeaPartyMessageCharLimit(budget.contextWindowTokens));
    const expected = buildMagicTeaPartyMainPrompt({ ...base, messages: limited.messages.map(message => ({ ...message, sessionId: 'tea', createdAt: 0 })) });
    expect(request.messages).toEqual([{ role: 'user', content: expected }]);
    expect(port.read).toHaveBeenCalledTimes(4);
    for (const [call] of port.read.mock.calls) expect(call.request).toMatchObject({ instance: value.instance, expectedRevision: 1 });
    expect(/[\uD800-\uDFFF]/u.test(expected)).toBe(false);
    expect(value.session.settings.maxContextMessages).toBe(3);
  });
  it('abandons all partial history on second-pass revision failure before any model invocation', async () => {
    const port = paged(); const original = port.read.getMockImplementation()!; let calls = 0;
    port.read.mockImplementation(async input => { if (++calls === 3) throw new Error('tea-conflict'); return original(input); });
    await expect(prepareTeaDirectRequest(port, record(), target, null, 'request', () => true)).rejects.toThrow('tea-conflict');
    expect(port.mutate).not.toHaveBeenCalled();
  });
  it('does not apply an 800k whole-session gate or silently clamp an extreme history setting', async () => {
    const value = record(); value.session.settings.maxContextMessages = 1;
    const huge = [{ ordinal: 1, message: { ...rows[0]!.message, content: '中'.repeat(900000) } }];
    const request = await prepareTeaDirectRequest(paged(huge), value, target, null, 'request', () => true);
    expect(request.messages[0]!.content.length).toBeLessThan(20000);
    value.session.settings.maxContextMessages = 10001;
    await expect(prepareTeaDirectRequest(paged(), value, target, null, 'request', () => true)).rejects.toThrow('10000');
    expect(value.session.settings.maxContextMessages).toBe(10001);
  });
  it('projects unknown settings away without changing the archive and suppresses unsupported side-channel calls', () => {
    const value = { providerId: 'openai', modelId: 'm', injectedEndpoint: 'https://invalid.example', outputPlan: { choices: 'on', summary: 'on', updates: 'on', unknown: 'leave in archive' }, enableSummary: true };
    const original = JSON.stringify(value); const projected = desktopTeaSettings(value);
    expect(projected).not.toHaveProperty('injectedEndpoint');
    expect(projected.outputPlan).toEqual({ choices: 'on', summary: 'off', updates: 'off' });
    expect(JSON.stringify(value)).toBe(original);
  });
  it('uses the actual Native stream adapter and retains accepted Unicode prefixes after protocol failure', async () => {
    const request = { requestId: 'request', contractVersion: 1 as const, mode: 'direct-local' as const, messages: [{ role: 'user' as const, content: 'synthetic' }] };
    const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onEvent as { onmessage: (_event: AiStreamEvent) => void };
      channel.onmessage({ ...identity, sequence: 0, type: 'started' });
      channel.onmessage({ ...identity, sequence: 1, type: 'text-delta', delta: '中😀' });
      channel.onmessage({ ...identity, sequence: 7, type: 'text-delta', delta: '不可接受' });
    });
    const progress = vi.fn();
    const outcome = await executeTeaDirect({ invoke, profileId: 'tea-loopback', createChannel: () => ({}) }, request, new AbortController().signal, progress);
    expect(outcome).toMatchObject({ completion: 'failed', rawText: '中😀' });
    const message = teaTerminalMessage({ id: 'a', sessionId: 'tea', role: 'assistant', content: '', createdAt: 1, status: 'streaming' }, outcome, 'markdown');
    expect(message).toMatchObject({ status: 'error', content: '中😀', meta: { rawOutput: '中😀', completion: 'failed' } });
  });
});
