import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import {
  classifyDesktopTavernStreamFailure,
  DesktopTavernStreamErrorSchema,
  type DesktopHostedGenerateRequest,
  type HostedGenerationEvent,
} from '@mahoshojo/contracts/desktop-cloud';
import {
  streamHostedAi,
  type HostedAiChannel,
  type InvokeFn,
} from '../src/platform/cloud-bridge';

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-hosted-tavern-stream.json', import.meta.url), 'utf8')) as {
  path: string;
  capability: { path: string; header: string };
  validDone: unknown[];
  preDispatchCodes: string[];
  rateLimited: { body: unknown; retryAfterHeader: string; expected: unknown };
};

type Observed = { method: string; path: string; headers: string; body: Record<string, unknown> | null };
type Reply = { error: { code: string; message: string } | null; events: HostedGenerationEvent[]; observed: Observed[] };
type ResponsePlan = { responseBody: string; responseStatus?: number; responseVersion?: string; capabilityVersion?: string; retryAfter?: string };
const TEST = 'cloud::tests::tavern_stream_tests::real_tavern_hosted_stream_pipe';
const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const markdown = event('markdown', { chunk: '正文🌸' });
const completed = event('done', fixture.validDone[0]);

const openNativePipe = () => {
  const binary = process.env.MAHO_TAVERN_HOSTED_STREAM_BINARY;
  if (!binary) throw new Error('Set MAHO_TAVERN_HOSTED_STREAM_BINARY to the compiled Rust test binary. Explicit acceptance requires a real Native binary.');
  const child = spawn(binary, ['--ignored', '--exact', TEST, '--nocapture', '--quiet', '--test-threads=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let readySeen = false;
  let pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  let outputBytes = 0;
  let stderr = '';
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    rejectReady(error);
    pending?.reject(error);
    pending = undefined;
    child.kill();
  };
  const timer = setTimeout(() => fail(new Error('Native Tavern stream pipe timed out')), 20_000);
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 64 * 1024) fail(new Error('Native Tavern stream diagnostic budget exceeded'));
  });
  lines.on('line', line => {
    outputBytes += Buffer.byteLength(line);
    if (outputBytes > 2 * 1024 * 1024) { fail(new Error('Native Tavern stream output budget exceeded')); return; }
    if (line === 'TAVERN_HOSTED_STREAM_READY') { readySeen = true; resolveReady(); return; }
    if (!line.startsWith('TAVERN_HOSTED_STREAM_RESULT ')) return;
    try {
      if (!pending) throw new Error('Unexpected Native Tavern stream reply');
      const reply = JSON.parse(line.slice('TAVERN_HOSTED_STREAM_RESULT '.length)) as Reply;
      const owner = pending;
      pending = undefined;
      owner.resolve(reply);
    } catch (error) { fail(error instanceof Error ? error : new Error('Invalid Native Tavern stream pipe reply')); }
  });
  const closed = new Promise<number | null>(resolve => child.once('close', code => {
    if (!readySeen || pending || code !== 0) fail(new Error(`Native Tavern stream runner exited ${code} without completing the requested test: ${stderr.slice(-2000)}`));
    resolve(code);
  }));
  return {
    ready,
    async request(request: unknown, response: ResponsePlan): Promise<Reply> {
      if (failure) throw failure;
      if (pending) throw new Error('Native pipe requests must be sequential');
      const result = new Promise<Reply>((resolve, reject) => { pending = { resolve, reject }; });
      child.stdin.write(`${JSON.stringify({ request, ...response })}\n`);
      return result;
    },
    async finish() { child.stdin.end(); expect(await closed).toBe(0); if (failure) throw failure; },
    dispose() { clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); },
  };
};

const requestFor = (template: 'general' | 'general-scenario' | 'scenario' | 'magical-girl' | 'canshou', preset = false): DesktopHostedGenerateRequest => ({
  requestId: `native-stream-${template}-${preset ? 'preset' : 'system'}`,
  routeId: 'tavern-convert-stream',
  body: { template, language: 'zh-CN', sourceName: 'Alice', attachments: [{ name: 'source.txt', content: '{{user}} 对 {{char}} 说话' }] },
  ...(preset ? { presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } } : { systemConfig: { modelId: 'test-system-model' } }),
});

// Ordinary desktop tests do not require Rust; acceptance must explicitly set this binary.
describe.skipIf(!process.env.MAHO_TAVERN_HOSTED_STREAM_BINARY)('Tavern stream bridge through real Rust HTTP and Channel serialization', () => {
  it('proves fixed handshake, canonical templates, strict terminal evidence, and failure phase across the real pipe', async () => {
    const pipe = openNativePipe();
    try {
      await pipe.ready;
      const run = async (request: DesktopHostedGenerateRequest, response: ResponsePlan) => {
        let reply: Reply | undefined;
        const events: HostedGenerationEvent[] = [];
        const channel: HostedAiChannel = {};
        const invoke: InvokeFn = async (command, args) => {
          expect(command).toBe('stream_hosted_ai');
          expect(args?.onEvent).toBe(channel);
          reply = await pipe.request(args?.request, response);
          for (const event of reply.events) channel.onmessage?.(event);
          if (reply.error) throw reply.error;
          return undefined;
        };
        let rejection: unknown;
        await streamHostedAi(invoke, request, value => events.push(value), { createChannel: () => channel }).catch(error => { rejection = error; });
        expect(reply, 'the bridge must actually invoke the Rust pipe').toBeDefined();
        return { reply: reply!, events, rejection };
      };
      for (const [index, template] of (['general', 'general-scenario', 'scenario', 'magical-girl', 'canshou'] as const).entries()) {
        for (const preset of [false, true]) {
          const terminal = fixture.validDone[index]!;
          const result = await run(requestFor(template, preset), {
            responseBody: event('reasoning', { source: 'sdk', status: 'thinking', chunk: '思考' })
              + 'event: future-extension\ndata: not-json\n\n' + markdown + event('done', terminal),
          });
          expect(result.rejection).toBeUndefined();
          expect(result.events.filter(value => value.event === 'markdown')).toEqual([{ event: 'markdown', data: { chunk: '正文🌸' } }]);
          expect(result.events.at(-1)).toEqual({ event: 'done', data: terminal });
          expect(result.reply.observed.map(value => [value.method, value.path])).toEqual([
            ['GET', '/api/hosted/dr-readiness'], ['GET', fixture.capability.path], ['POST', fixture.path],
          ]);
          const probe = result.reply.observed[1]!;
          const posted = result.reply.observed[2]!;
          expect(probe.body).toBeNull();
          for (const request of [probe, posted]) {
            expect(request.headers.toLowerCase()).toContain(`${fixture.capability.header}: v1`);
            expect(request.headers).not.toContain('fake-tavern-stream-key');
          }
          expect(posted.headers.toLowerCase()).toContain('accept: text/event-stream');
          expect(posted.body).toMatchObject({ template, customProvider: { providerId: preset ? 'deepseek' : 'system', modelId: preset ? 'deepseek-chat' : 'test-system-model', apiKey: preset ? 'fake-tavern-stream-key' : '' } });
          expect(posted.body).not.toHaveProperty('raw');
          expect(posted.body).not.toHaveProperty('preference');
        }
      }

      const incompatible = await run(requestFor('general'), { responseBody: completed, capabilityVersion: 'v2' });
      expect(incompatible.rejection).toMatchObject({ code: 'protocol-mismatch', phase: 'pre-dispatch' });
      expect(incompatible.events).toEqual([]);
      expect(incompatible.reply.observed.map(value => value.method)).toEqual(['GET', 'GET']);

      const invalidBody = await pipe.request({ ...requestFor('general'), body: { ...(requestFor('general').body as Record<string, unknown>), customProvider: { apiKey: 'renderer-injection' } } }, { responseBody: completed });
      expect(invalidBody.error).toMatchObject({ code: 'invalid-request' });
      expect(invalidBody.events).toEqual([]);
      expect(invalidBody.observed).toEqual([]);

      for (const response of [
        { responseBody: completed, responseVersion: 'v2' },
        { responseBody: markdown + 'event: markdown\ndata: {bad}\n\n' },
        { responseBody: markdown + event('done', { ok: true }) },
        { responseBody: markdown },
        { responseBody: event('error', { ok: false, error: 'upstream rejected', code: 'invalid-request' }) },
      ]) {
        const result = await run(requestFor('general'), response);
        expect(result.rejection).toBeUndefined();
        expect(result.events.filter(value => value.event === 'done' || value.event === 'error')).toHaveLength(1);
        const terminal = result.events.at(-1)!;
        expect(terminal.event).toBe('error');
        const error = DesktopTavernStreamErrorSchema.parse(terminal.data);
        expect(fixture.preDispatchCodes).not.toContain(error.code);
        expect(classifyDesktopTavernStreamFailure({ source: 'stream-event', observedEvent: true, code: error.code })).toBe('possible-dispatch');
        expect(result.reply.observed.filter(value => value.method === 'POST')).toHaveLength(1);
        if (response.responseBody.startsWith(markdown)) expect(result.events[0]).toEqual({ event: 'markdown', data: { chunk: '正文🌸' } });
      }

      const limited = await run(requestFor('general'), { responseStatus: 429, responseBody: JSON.stringify(fixture.rateLimited.body), retryAfter: fixture.rateLimited.retryAfterHeader });
      expect(limited.rejection).toBeUndefined();
      expect(limited.events).toEqual([{ event: 'error', data: fixture.rateLimited.expected }]);
      const byok = await run(requestFor('general', true), { responseStatus: 429, responseBody: JSON.stringify({ error: 'private provider diagnostics fake-tavern-stream-key', retryAfterSeconds: 7 }), retryAfter: '11' });
      expect(DesktopTavernStreamErrorSchema.parse(byok.events.at(-1)?.data).retryAfterSeconds).toBe(11);
      expect(JSON.stringify(byok.events)).not.toContain('private provider');
      expect(JSON.stringify(byok.events)).not.toContain('fake-tavern-stream-key');

      const terminalWins = await run(requestFor('general'), { responseBody: markdown + completed + 'event: markdown\ndata: {bad}\n\n' });
      expect(terminalWins.rejection).toBeUndefined();
      expect(terminalWins.events).toEqual([{ event: 'markdown', data: { chunk: '正文🌸' } }, { event: 'done', data: fixture.validDone[0] }]);
      await pipe.finish();
    } finally { pipe.dispose(); }
  }, 25_000);
});

// Native HTTP/SSE parsing is real here; the pipe relays buffered events and does not
// emulate Tauri registration/cancel timing (covered separately by deferred Channel tests).
describe.skipIf(!process.env.MAHO_TAVERN_HOSTED_STREAM_BINARY)('Tavern Hosted owner through the real Native pipe', () => {
  it('accepts only a safe stop and preserves rejected or uncertain output without replay', async () => {
    const { executeTavernGeneration } = await import('../src/features/tavern/generation');
    const { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE } = await import('@mahoshojo/domain/tavern-card');
    const pipe = openNativePipe();
    try {
      await pipe.ready;
      const cases = [
        { response: { responseBody: event('markdown', { chunk: '# 情景\n完整正文 VPN' }) + completed }, status: 'completed', raw: '# 情景\n完整正文 VPN', posts: 1 },
        { response: { responseBody: markdown + event('done', { ok: true, tavernCompletion: { version: 1, finishReason: 'length' } }) }, status: 'invalid-output', raw: '正文🌸', posts: 1 },
        { response: { responseBody: completed, capabilityVersion: 'v2' }, status: 'failed', raw: '', posts: 0 },
        { response: { responseBody: markdown + completed, responseVersion: 'v2' }, status: 'uncertain', raw: '', posts: 1 },
        { response: { responseBody: markdown }, status: 'uncertain', raw: '正文🌸', posts: 1 },
        { response: { responseStatus: 429, responseBody: JSON.stringify({ error: '请稍后再试', retryAfterSeconds: 7 }) }, status: 'failed', raw: '', posts: 1 },
      ];
      for (const [index, scenario] of cases.entries()) {
        let reply: Reply | undefined; let invokeCount = 0; const cooldown: (number | undefined)[] = [];
        const invoke: InvokeFn = async (command, args) => {
          expect(command).toBe('stream_hosted_ai'); invokeCount++;
          const channel = args?.onEvent as HostedAiChannel;
          expect(channel.onmessage).toBeTypeOf('function');
          reply = await pipe.request(args?.request, scenario.response);
          for (const event of reply.events) channel.onmessage?.(event);
          if (reply.error) throw reply.error;
        };
        const raw = { name: '原件', description: '保留原始设定', custom: { keep: true } };
        const outcome = await executeTavernGeneration({ invoke, profileId: '', providerTarget: { kind: 'system' }, createChannel: () => ({}), onHostedDispatchSettled: seconds => { cooldown.push(seconds); } },
          { raw, template: 'scenario', language: 'zh-CN', preference: DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE },
          { requestId: `owner-pipe-${index}`, mode: 'hosted-stream', generationMode: 'stream' }, new AbortController().signal);
        expect(outcome).toMatchObject({ status: scenario.status, rawText: scenario.raw }); expect(invokeCount).toBe(1);
        expect(reply!.observed.filter(value => value.method === 'POST')).toHaveLength(scenario.posts);
        expect(cooldown).toHaveLength(scenario.posts);
        if (outcome.status === 'completed') expect(outcome).toMatchObject({ cardKind: 'general-scenario', card: { content: '# 情景\n完整正文 ❀❀❀', _tavern: { raw } } });
        if (index === 5) { expect(outcome).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 7 }); expect(cooldown).toEqual([7]); }
      }
      await pipe.finish();
    } finally { pipe.dispose(); }
  }, 25_000);
});
