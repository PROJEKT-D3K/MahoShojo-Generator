import { describe, expect, it, vi } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { AiExecutionRequest, AiExecutionErrorCode } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { executeArenaDirect } from '../src/features/arena/direct';
import { DesktopArenaSession, createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import { startMagicTeaPartyJourneyProbe } from './helpers/magic-tea-party-journey-probe';

const storage = () => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const draft = (battleMode: ArenaDraft['battleMode'], generationMode: ArenaDraft['generationMode']): ArenaDraft => ({
  ...createInitialArenaDraft(), battleMode, generationMode,
  combatants: ['甲', '乙'].map(name => ({
    type: 'general-character', data: { templateId: '通用角色', name, content: `${name}的完整角色设定`, signature: 'source-signature-only' },
    isPreset: false, isValid: false, filename: `${name}.json`,
  })),
  scenario: { content: battleMode === 'scenario' ? { title: '重逢', content: '两位角色在车站重逢。' } : null, fileName: null },
  settings: { ...createInitialArenaDraft().settings, writeNarrativeHistory: true },
});

const response = (generationMode: ArenaDraft['generationMode'], body: string) => generationMode === 'stream'
  ? `# 新旅途\n\n${body}\n<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"新旅途","winner":"甲"},"impacts":[{"characterName":"甲","impact":"互相信任","currentStateSummary":"平静"}]} -->`
  : JSON.stringify({ headline: '新旅途', article: { body, analysis: '彼此理解' }, officialReport: { winner: '甲', conclusion: '合作' },
    impacts: [{ characterName: '甲', impact: '互相信任', currentStateSummary: '平静' }] });

// The owner, prompt adapter, Rust Profile/HTTP/SSE implementation and TS terminal
// collector are real. Only the model is synthetic. This does not exercise Tauri
// WebView delivery, a trusted Preset endpoint, or an external provider.
describe('Arena page owners through real Native Direct loopback', () => {
  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY).each(['battle', 'arena'] as const)(
    '%s completes all four modes with structured and streaming output on the same owner', async product => {
      const probe = await startMagicTeaPartyJourneyProbe();
      const disk = storage();
      let serial = 0;
      const owner = new DesktopArenaSession({ product, storage: disk, repository: {} as CardRepository,
        requestId: () => `arena-native-${product}-${++serial}` });
      owner.setScope(`local:${product}`);
      let lastRaw = '';
      try {
        for (const battleMode of ['classic', 'kizuna', 'daily', 'scenario'] as const) {
          for (const generationMode of ['non-stream', 'stream'] as const) {
            const input = draft(battleMode, generationMode);
            const body = `${product}/${battleMode}/${generationMode}：两位角色共同踏上旅途🌸。`;
            lastRaw = response(generationMode, body);
            owner.updateDraft(input);
            await probe.control('checkpoint', { action: 'model', chunks: [lastRaw.slice(0, 11), lastRaw.slice(11)], deferred: false });
            await owner.generate(probe.aiOptions, input, {
              mode: 'direct-local', generationMode, modelId: 'synthetic-arena', temperature: 0.5, maxOutputTokens: 2048,
            });
            expect(owner.getSnapshot()).toMatchObject({ phase: 'completed', rawText: lastRaw, activeGenerationMode: generationMode,
              usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 }, report: { headline: '新旅途', mode: battleMode,
                article: { body: generationMode === 'stream' ? `# 新旅途\n\n${body}` : body }, aiModel: 'synthetic-arena' } });
            expect(owner.getSnapshot().markdown).toContain(body);
            expect(owner.getSnapshot().markdown).not.toContain('MAHOSHOJO');
            expect(owner.getSnapshot().draft.narrativeHistoryEntries).toHaveLength(1);
            expect(owner.getSnapshot().draft.narrativeHistoryEntries[0]?.content).toBe(owner.getSnapshot().markdown);
            expect(owner.getSnapshot().candidates?.characterEffects).not.toHaveLength(0);

            const observations = await probe.control('requestCount') as { count: number; active: number; requests: Array<Record<string, unknown>> };
            expect(observations.count).toBe(serial);
            expect(observations.active).toBe(0);
            const sent = observations.requests.at(-1)!;
            expect(sent).toMatchObject({ model: 'synthetic-arena', stream: true, stream_options: { include_usage: true }, temperature: 0.5, max_tokens: 2048 });
            expect(sent).not.toHaveProperty('response_format');
            expect(sent).not.toHaveProperty('arenaInputJson');
            expect(JSON.stringify(sent)).not.toContain('source-signature-only');
            const messages = sent.messages as Array<{ role: string; content: string }>;
            expect(messages.at(-1)).toMatchObject({ role: 'user' });
            expect(messages.at(-1)?.content).toContain('甲的完整角色设定');
            if (generationMode === 'non-stream') {
              expect(messages[0]?.role).toBe('system');
              expect(messages[0]?.content).toContain('officialReport');
            } else expect(messages.at(-1)?.content).toContain('MAHOSHOJO_ARENA_META');
            const terminal = probe.events.filter(event => event.type === 'result');
            expect(terminal).toHaveLength(serial);
            expect(terminal.at(-1)).toMatchObject({ type: 'result', result: { status: 'completed', finishReason: 'stop', output: { text: lastRaw } } });
          }
        }
        expect(probe.trace.filter(row => row.command === 'stream_direct_ai')).toHaveLength(8);
        owner.dispose();
        const reopened = new DesktopArenaSession({ product, storage: disk, repository: {} as CardRepository });
        try {
          reopened.restoreDraft();
          expect(reopened.getSnapshot()).toMatchObject({ phase: 'completed', restored: true, rawText: lastRaw, activeGenerationMode: 'stream' });
          expect(await probe.control('requestCount')).toMatchObject({ count: 8, active: 0 });
        } finally { reopened.dispose(); }
      } finally { owner.dispose(); await probe.close(); }
    }, 30_000,
  );

  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('retains invalid structured output and can generate again without replaying it', async () => {
    const probe = await startMagicTeaPartyJourneyProbe();
    let serial = 0;
    const owner = new DesktopArenaSession({ storage: storage(), repository: {} as CardRepository, requestId: () => `arena-invalid-${++serial}` });
    owner.setScope('local:battle');
    try {
      const input = draft('classic', 'non-stream');
      owner.updateDraft(input);
      const invalid = '本次只有正文，没有结构化报告。';
      await probe.control('checkpoint', { action: 'model', chunks: [invalid], deferred: false });
      await owner.generate(probe.aiOptions, input, { mode: 'direct-local', generationMode: 'non-stream', modelId: 'synthetic-arena' });
      expect(owner.getSnapshot()).toMatchObject({ phase: 'failed', rawText: invalid, candidates: null, draft: { narrativeHistoryEntries: [] } });
      expect(await probe.control('requestCount')).toMatchObject({ count: 1, active: 0 });
      const valid = response('non-stream', '下一次明确请求完成。');
      await probe.control('checkpoint', { action: 'model', chunks: [valid], deferred: false });
      await owner.generate(probe.aiOptions, input, { mode: 'direct-local', generationMode: 'non-stream', modelId: 'synthetic-arena' });
      expect(owner.getSnapshot()).toMatchObject({ phase: 'completed', rawText: valid });
      expect(await probe.control('requestCount')).toMatchObject({ count: 2, active: 0 });
    } finally { owner.dispose(); await probe.close(); }
  }, 20_000);

  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('cancels the actual HTTP stream and keeps only the accepted prefix', async () => {
    const probe = await startMagicTeaPartyJourneyProbe();
    const owner = new DesktopArenaSession({ storage: storage(), repository: {} as CardRepository });
    owner.setScope('local:battle');
    try {
      const input = draft('daily', 'stream');
      owner.updateDraft(input);
      await probe.control('checkpoint', { action: 'model', chunks: ['# 尚未结束\n\n已收到的正文。', '不能在取消之后追加。'], deferred: true });
      const pending = owner.generate(probe.aiOptions, input, { mode: 'direct-local', generationMode: 'stream', modelId: 'synthetic-arena' });
      await vi.waitFor(() => expect(owner.getSnapshot().rawText).toBe('# 尚未结束\n\n已收到的正文。'), { timeout: 5000 });
      owner.cancel();
      await pending;
      const cancelled = owner.getSnapshot();
      expect(cancelled).toMatchObject({ phase: 'cancelled', rawText: '# 尚未结束\n\n已收到的正文。', candidates: null });
      await vi.waitFor(async () => expect(await probe.control('requestCount')).toMatchObject({ count: 1, disconnected: 1, active: 0 }), { timeout: 5000 });
      await probe.control('checkpoint', { action: 'release' });
      expect(owner.getSnapshot()).toEqual(cancelled);
    } finally { owner.dispose(); await probe.close(); }
  }, 20_000);

  it.skipIf(!process.env.MAHO_TEA_JOURNEY_BINARY)('explains a real Native request rejection before HTTP dispatch', async () => {
    const probe = await startMagicTeaPartyJourneyProbe();
    try {
      const outcome = await executeArenaDirect(probe.aiOptions, draft('classic', 'non-stream'), {
        requestId: 'arena-native-rejected', mode: 'direct-local', generationMode: 'non-stream', modelId: 'x'.repeat(257),
      }, { scopeKey: 'local:battle', reporterInfo: { name: '记者', publication: '速报' }, adjudicationResults: [] }, new AbortController().signal);
      expect(outcome).toMatchObject({ status: 'failed', code: 'unsupported-request', rawText: '', terminal: null });
      if (outcome.status !== 'failed') throw new Error('expected rejected request');
      expect(outcome.message).toContain('检查模型名称和生成参数');
      expect(outcome.message).toContain('unsupported-request');
      expect(outcome.message).not.toContain('x'.repeat(257));
      expect(outcome).not.toHaveProperty('historyCandidate');
      expect(await probe.control('requestCount')).toMatchObject({ count: 0, active: 0 });
    } finally { await probe.close(); }
  }, 20_000);
});

describe('Arena Direct safe failure diagnostics', () => {
  const intent = { requestId: 'safe-error', mode: 'direct-local' as const, generationMode: 'stream' as const, modelId: 'synthetic' };
  const context = { scopeKey: 'local:battle', reporterInfo: { name: '记者', publication: '速报' }, adjudicationResults: [] };

  it.each(['profile-not-found', 'profile-rejected', 'missing-secret', 'unsupported-request', 'upstream-unavailable', 'upstream-rejected', 'stream-protocol', 'failed', 'internal-error'])(
    'preserves the recognized %s code without exposing the Native error message', async code => {
      const invoke = vi.fn(async () => { throw { code, message: 'PRIVATE-UPSTREAM-VALUE', extra: 'PRIVATE-EXTRA' }; });
      const outcome = await executeArenaDirect({ invoke, profileId: 'synthetic', createChannel: () => ({}) }, draft('classic', 'stream'), intent, context, new AbortController().signal);
      expect(outcome).toMatchObject({ status: 'failed', code, rawText: '' });
      if (outcome.status !== 'failed') throw new Error('expected Native failure');
      expect(outcome.message).toContain(code);
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
      expect(outcome).not.toHaveProperty('draftCompletion');
      expect(outcome).not.toHaveProperty('historyCandidate');
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['unrecognized-PRIVATE-code', 'constructor', '__proto__'])('never echoes the unrecognized source code %s', async code => {
    const invoke = vi.fn(async () => { throw { code, message: 'PRIVATE-UPSTREAM-VALUE' }; });
    const outcome = await executeArenaDirect({ invoke, profileId: 'synthetic', createChannel: () => ({}) }, draft('classic', 'stream'), intent, context, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'failed', code: 'invalid-response' });
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
    if (outcome.status !== 'failed') throw new Error('expected Native failure');
    expect(outcome.message).not.toContain(code);
  });

  it.each(['partial', 'terminal', 'invalid-event'] as const)('keeps failure and protocol precedence after %s delivery', async delivery => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = args!.request as AiExecutionRequest;
      const channel = args!.onEvent as { onmessage: (event: AiStreamEvent) => void };
      const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
      channel.onmessage({ ...identity, type: 'started', sequence: 0 });
      channel.onmessage({ ...identity, type: 'text-delta', sequence: 1, delta: '已接受的正文' });
      if (delivery === 'terminal') channel.onmessage({ ...identity, type: 'result', sequence: 2,
        result: { ...identity, status: 'completed', finishReason: 'stop', output: { text: '已接受的正文' } } });
      if (delivery === 'invalid-event') channel.onmessage({ ...identity, type: 'text-delta', sequence: 99, delta: '不得接受' });
      throw { code: 'missing-secret', message: 'PRIVATE-UPSTREAM-VALUE' };
    });
    const outcome = await executeArenaDirect({ invoke, profileId: 'synthetic', createChannel: () => ({}) }, draft('classic', 'stream'), intent, context, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'failed', rawText: '已接受的正文', code: delivery === 'invalid-event' ? 'invalid-response' : 'missing-secret' });
    expect(outcome).not.toHaveProperty('draftCompletion');
    expect(outcome).not.toHaveProperty('historyCandidate');
    expect(JSON.stringify(outcome)).not.toContain('PRIVATE');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each<AiExecutionErrorCode>(['authentication-failed', 'permission-denied', 'rate-limited', 'timeout', 'service-unavailable', 'content-filtered', 'invalid-response', 'output-too-large', 'internal-error'])(
    'explains the validated %s terminal without showing its upstream message or accepting a result', async code => {
      const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
        const request = args!.request as AiExecutionRequest;
        const channel = args!.onEvent as { onmessage: (event: AiStreamEvent) => void };
        const identity = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
        channel.onmessage({ ...identity, type: 'started', sequence: 0 });
        channel.onmessage({ ...identity, type: 'text-delta', sequence: 1, delta: '已接受的正文' });
        channel.onmessage({ ...identity, type: 'result', sequence: 2,
          result: { ...identity, status: 'failed', error: { code, message: 'PRIVATE-UPSTREAM-VALUE' } } });
      });
      const outcome = await executeArenaDirect({ invoke, profileId: 'synthetic', createChannel: () => ({}) }, draft('classic', 'stream'), intent, context, new AbortController().signal);
      expect(outcome).toMatchObject({ status: 'failed', code, rawText: '已接受的正文' });
      if (outcome.status !== 'failed') throw new Error('expected failed terminal');
      expect(outcome.message).toContain(code);
      expect(outcome.message).not.toContain('PRIVATE');
      expect(outcome).not.toHaveProperty('draftCompletion');
      expect(outcome).not.toHaveProperty('historyCandidate');
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
});
