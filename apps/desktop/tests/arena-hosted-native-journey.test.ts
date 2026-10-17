import { withFixtureStreamReceipt } from './helpers/stream-receipt-fixture';
/** Opt-in integration: Renderer adapter/settle -> real Rust HTTP pipe -> real companion/runtime.
 * Auth, safety, service persistence, provider output and finalization are synthetic. The pipe
 * synthesizes IPC receipts; actual Tauri command macros are tested separately. No WebView or public AI. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { executeArenaHosted, type ArenaHostedContext } from '../src/features/arena/hosted';
import { createInitialArenaDraft, buildDesktopArenaInput } from '../src/features/arena/session';
import { DesktopArenaHostedRecovery } from '../src/features/arena/hosted-recovery';
import type { InvokeFn } from '../src/platform/cloud-bridge';
import { createArenaHostedNativeSettle } from '../src/platform/arena-hosted-settle';
import { createArenaCompanionService } from '@mahoshojo/hosted-runtime/arena-companion';
import { createArenaGenerationRuntime, ARENA_GENERATION_MATERIALIZATION_VERSION, buildArenaGenerationPrompt } from '@mahoshojo/hosted-runtime/arena-generation';
import type { ArenaGenerationService, GenerationStreamEvent } from '@mahoshojo/hosted-api/arena-generation/service';

const binary = process.env.MAHO_ARENA_JOURNEY_BINARY;
const generationId = `arena_${'a'.repeat(64)}`;
const report = { headline: '闭环战报', article: { body: '合成服务正文', analysis: '点评' }, officialReport: { winner: '甲', conclusion: '结论' }, impacts: [] };
const capability = { ok: true, contractVersion: 'g25e1-v1', placement: 'hono-primary', databaseProvider: 'hono-d1-primary', consistency: 'replica-ok', arenaHosted: { contractVersion: 'arena-hosted-sse-v1', expectedUserIdAssertion: 'v1', stream: 'sse-v1' } };
const headers = { 'x-mahoshojo-arena-companion-protocol': 'arena-companion-v1', 'x-mahoshojo-arena-reconciliation-protocol': 'arena-reconciliation-v1' };
async function fixture(failure?: { status: number; code: string; unboundTerminal?: boolean }, executable = binary, commandArgs = ['--ignored', '--exact', 'arena_hosted::tests::json_tests::real_arena_hosted_journey_pipe', '--nocapture', '--quiet', '--test-threads=1']) {
  const requests: Array<{ path: string; method: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  let generated = 0;
  const runtime = createArenaGenerationRuntime({
    preparePayload: async ({ request, payload }) => ({ ...payload, __arenaServerContextV1: {
      deliveryMode: request.url.includes('generate-battle-story') ? 'non-stream' : 'stream',
      endpoint: request.url.includes('generate-battle-story') ? 'api/generate-battle-story' : 'api/arena/generate-stream',
      fundingMode: payload.customProvider ? 'hosted-byok' : 'hosted-system',
    } }),
    checkSafety: async () => null, buildPrompt: buildArenaGenerationPrompt,
    generate: async ({ payload }) => {
      generated++;
      const mode = (payload.__arenaServerContextV1 as { deliveryMode: string }).deliveryMode;
      const source = payload.reportFormat === 'web' ? '<!doctype html><html><head><title>闭环战报</title></head><body>合成服务正文</body></html>\n<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"闭环战报","winner":"甲"},"impacts":[]} -->'
        : mode === 'non-stream' ? JSON.stringify(report) : '# 闭环战报\n\n合成服务正文\n<!-- MAHOSHOJO_ARENA_META {"version":1,"report":{"headline":"闭环战报","winner":"甲"},"impacts":[]} -->';
      return { body: new Response(source).body!, telemetry: { model: 'synthetic-model', usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 } }, finishReason: 'stop' };
    },
    finalize: async () => ({ resultRef: null, ranking: null }),
  });
  const forbidden = async (): Promise<Response> => { throw new Error('unexpected synthetic service operation'); };
  const createParsedSubscription: NonNullable<ArenaGenerationService['createParsedSubscription']> = async (request, command) => {
    if (failure) return Response.json({ code: failure.code, error: 'synthetic-private-diagnostic', ...(failure.unboundTerminal ? { generationId, status: 'failed' } : {}) }, { status: failure.status, ...(failure.unboundTerminal ? { headers: { 'x-mahoshojo-generation-id': generationId } } : {}) });
    const input = { request, actorKey: 'user:123', generationRequestId: command.generationRequestId, payload: command.payload };
    const preflight = await runtime.preflight!(input);
    if (preflight instanceof Response) return preflight;
    if ('kind' in preflight) return preflight.response;
    const prepared = await runtime.materialize!({ ...input, payload: preflight.materializationPayload, preparationSeed: '11'.repeat(32), preparationVersion: ARENA_GENERATION_MATERIALIZATION_VERSION });
    if (prepared instanceof Response) return prepared;
    if ('kind' in prepared) return prepared.response;
    let sequence = 0;
    return { generationId, generationRequestId: command.generationRequestId,
      headers: { ...prepared.responseHeaders, 'X-Mahoshojo-Generation-Id': generationId, 'X-Mahoshojo-Generation-Request-Id': command.generationRequestId },
      events: new ReadableStream<GenerationStreamEvent>({ async start(controller) {
        try {
          const terminal = await runtime.execute({ ...input, generationId, producerToken: 'synthetic-producer', payloadHash: 'a'.repeat(64), payload: prepared.executionPayload,
            signal: request.signal, emit: async event => { controller.enqueue({ ...event, id: `1-${sequence++}` }); }, claimFinalization: async () => ({ kind: 'claimed' }) });
          controller.enqueue({ id: `1-${sequence++}`, type: terminal.status === 'completed' ? 'done' : 'error', data: { ...terminal, ok: terminal.status === 'completed' } }); controller.close();
        } catch (error) { controller.error(error); }
      } }) };
  };
  const service: ArenaGenerationService = { createParsedSubscription, createSubscription: forbidden, create: forbidden, cancelRequest: forbidden, lookup: forbidden, resume: forbidden, status: forbidden, cancel: forbidden };
  const companion = createArenaCompanionService({ generationService: service, projectUpdatedCombatants: async () => { throw new Error('legacy write must not run'); } });
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const requestHeaders = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) requestHeaders.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const path = req.url!; const body = raw ? JSON.parse(raw) : null;
      requests.push({ path, method: req.method!, headers: requestHeaders, body });
      let response: Response;
      if (req.method === 'GET') {
        expect(requestHeaders.has('cookie')).toBe(false);
        response = Response.json(path === '/api/hosted/dr-readiness' ? capability : { ok: true, contractVersion: 'arena-reconciliation-v1', expectedUserIdAssertion: 'v1', ownership: 'generation-actor', effects: 'frozen-manifest-v1' }, { headers });
      } else {
        expect(requestHeaders.get('cookie')).toBe('better-auth.session_token=SYNTHETIC-COOKIE-CANARY');
        expect(requestHeaders.get('x-mahoshojo-arena-expected-user-id')).toBe('v1:123');
        const request = new Request(`http://127.0.0.1${path}`, { method: 'POST', headers: requestHeaders, body: raw });
        if (path === '/api/generate-battle-story') response = await companion.generate(request, 'generate-battle-story');
        else {
          expect(path).toBe('/api/arena/generate-stream?format=sse');
          const { generationRequestId, ...payload } = body;
          const subscription = await createParsedSubscription(request, { generationRequestId, payload, bodyBytes: Buffer.byteLength(raw) });
          if (subscription instanceof Response) response = subscription;
          else {
            let wire = ''; const reader = subscription.events.getReader();
            while (true) { const next = await reader.read(); if (next.done) break; const event = next.value; wire += `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`; }
            response = new Response(wire, { headers: { ...subscription.headers, 'Content-Type': 'text/event-stream' } });
          }
        }
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { serverError = error; res.writeHead(500); res.end('synthetic test handler failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(executable!, commandArgs, {
    env: { ...process.env, MAHO_ARENA_JOURNEY_ORIGIN: origin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let serial = 0, stderr = '', exited = false, readySeen = false, readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no; });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; channel?: { onmessage: (value: unknown) => void } }>();
  let fatalError: Error | undefined;
  const fail = (error: unknown) => {
    fatalError ??= error instanceof Error ? error : new Error('Native journey failed');
    readyReject(fatalError);
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(fatalError); }
    pending.clear();
    if (!exited) child.kill('SIGKILL');
  };
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.startsWith('{') || fatalError) return;
    try {
      const frame = JSON.parse(line);
      if (!frame || typeof frame !== 'object' || !Number.isSafeInteger(frame.id) || frame.id < 0) throw new Error('invalid frame');
      if (frame.id === 0) {
        if (readySeen || frame.ok !== true || frame.value !== 'arena-hosted-journey-ready') throw new Error('invalid ready frame');
        readySeen = true; readyResolve(); return;
      }
      const operation = pending.get(frame.id);
      if (!operation) throw new Error('unexpected response identity');
      if ('event' in frame) {
        if (!operation.channel) throw new Error('unexpected channel event');
        operation.channel.onmessage(frame.event);
      } else {
        if (typeof frame.ok !== 'boolean') throw new Error('invalid result frame');
        clearTimeout(operation.timer); pending.delete(frame.id);
        if (frame.ok) operation.resolve(frame.value); else operation.reject(frame.error);
      }
    } catch { fail(new Error('Native journey emitted an invalid frame')); }
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', fail);
    child.on('close', code => {
      exited = true;
      if (fatalError || code !== 0 || pending.size || !readySeen) {
        const error = fatalError ?? new Error(`Native journey exit ${code}: ${stderr}`);
        fail(error); reject(error);
      } else resolve();
    });
  });
  void closed.catch(() => undefined);
  // The Rust pipe bypasses the Tauri command wrapper; add only the fixture IPC receipt.
  const invoke: InvokeFn = withFixtureStreamReceipt((command: string, args?: Record<string, unknown>) => new Promise((resolve, reject) => {
    if (fatalError || exited) { reject(fatalError ?? new Error('Native journey already exited')); return; }
    const id = ++serial, frame = JSON.stringify({ id, command, request: args?.request });
    const timer = setTimeout(() => fail(new Error('Native journey command timed out')), 5000);
    pending.set(id, { resolve, reject, timer, channel: args?.onEvent as { onmessage: (value: unknown) => void } });
    child.stdin.write(frame + '\n');
  }));
  child.stdin.on('error', fail);
  const timer = setTimeout(() => fail(new Error('Native journey ready timed out')), 10000);
  const stopServer = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try { await ready; } catch (error) { fail(error); await closed.catch(() => undefined); lines.close(); await stopServer(); throw error; } finally { clearTimeout(timer); }
  return { invoke, requests, generated: () => generated, close: async () => {
    // A close acknowledgement does not prove the child process has exited.
    const deadline = setTimeout(() => fail(new Error('Native journey close timed out')), 5000);
    try { if (!exited) await invoke('close'); child.stdin.end(); await closed; }
    finally { clearTimeout(deadline); if (!exited) child.kill('SIGKILL'); await closed.catch(() => undefined); lines.close(); await stopServer(); }
    if (serverError) throw serverError;
  } };
}
function context(product: 'battle' | 'arena'): ArenaHostedContext {
  const values = new Map<string, string>();
  return { product, scopeKey: 'synthetic-scope', actor: { kind: 'account', expectedUserId: 123 },
    recovery: new DesktopArenaHostedRecovery({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, product),
    createChannel: () => ({ onmessage: () => undefined }), wait: async () => undefined, maxReconnectAttempts: 0 };
}
function input(reportFormat: 'markdown' | 'web' = 'markdown') {
  const draft = createInitialArenaDraft();
  return buildDesktopArenaInput({ ...draft, reportFormat, combatants: ['甲', '乙'].map(name => ({ type: 'general-character', data: { name, content: '合成角色' }, isValid: false, isPreset: false, filename: `${name}.json` })) });
}
describe('Native hosted journey harness failures', () => {
  it('fails closed and cleans up when the configured binary cannot start', async () => {
    await expect(fixture(undefined, '/nonexistent/maho-synthetic-binary')).rejects.toThrow();
  });
  it('rejects malformed child frames and still closes the server', async () => {
    const f = await fixture(undefined, process.execPath, ['-e', `
      console.log(JSON.stringify({ id: 0, ok: true, value: 'arena-hosted-journey-ready' }));
      require('node:readline').createInterface({ input: process.stdin }).on('line', () => console.log('{invalid-json}'));
    `]);
    try { await expect(f.invoke('malformed')).rejects.toThrow('invalid frame'); }
    finally { await expect(f.close()).rejects.toThrow('invalid frame'); }
  });
  it('kills an acknowledged close that never exits and closes the server', async () => {
    const f = await fixture(undefined, process.execPath, ['-e', `
      console.log(JSON.stringify({ id: 0, ok: true, value: 'arena-hosted-journey-ready' }));
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const frame = JSON.parse(line);
        console.log(JSON.stringify({ id: frame.id, ok: true, value: null }));
      });
      setInterval(() => {}, 1000);
    `]);
    await expect(f.close()).rejects.toThrow('close timed out');
  });
});
describe.skipIf(!binary)('real Native hosted battle journey', () => {
  it('keeps a terminal with only generation identity unknown until the original request is explicitly bound', async () => {
    const f = await fixture({ status: 502, code: 'GENERATION_FAILED', unboundTerminal: true }), host = context('battle');
    try {
      const result = await executeArenaHosted({ invoke: f.invoke }, input(), { requestId: 'synthetic-unbound-terminal', mode: 'hosted', generationMode: 'non-stream', modelId: 'default', systemConfig: {} }, host, new AbortController().signal);
      expect(result.status).toBe('failed'); expect(result.hosted.companion?.body).toMatchObject({ generationId, status: 'failed' });
      expect(host.recovery.getSnapshot().pointer?.state).toBe('unknown');
      // An independent renderer with no public pointer must still be stopped by Native.
      await executeArenaHosted({ invoke: f.invoke }, input(), { requestId: 'synthetic-unbound-replacement', mode: 'hosted', generationMode: 'non-stream', modelId: 'default', systemConfig: {} }, context('battle'), new AbortController().signal);
      expect(f.generated()).toBe(0); expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { await f.close(); }
  });

  for (const product of ['battle', 'arena'] as const) for (const generationMode of ['non-stream', 'stream'] as const) for (const funding of ['system', 'preset'] as const) {
    it(`${product} ${generationMode} ${funding} preserves the actual request and verified result`, async () => {
      const f = await fixture(), host = context(product), native = createArenaHostedNativeSettle(f.invoke);
      const controller = new AbortController();
      try {
        const result = await executeArenaHosted({ invoke: native.invoke }, input(), { requestId: 'synthetic-native-journey', mode: 'hosted', generationMode, modelId: funding === 'system' ? 'default' : 'deepseek-chat',
          ...(funding === 'system' ? { systemConfig: {} } : { presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } }) }, host, controller.signal);
        expect(await native.settle(controller.signal)).toEqual({ status: 'succeeded' });
        expect(result.status, JSON.stringify(result)).toBe('completed'); expect(result.markdown).toContain('合成服务正文');
        expect(host.recovery.getSnapshot().pointer?.state).toBe('completed');
        expect(f.generated()).toBe(1);
        const posts = f.requests.filter(request => request.method === 'POST'); expect(posts).toHaveLength(1);
        expect(posts[0].body).toMatchObject({ generationRequestId: 'synthetic-native-journey', mode: 'classic', writeArenaHistory: true, writeCurrentState: true });
        expect(posts[0].body?.customProvider).toEqual(funding === 'system' ? undefined : { providerId: 'deepseek', apiKey: 'SYNTHETIC-PROVIDER-KEY-CANARY', modelId: 'deepseek-chat' });
        if (generationMode === 'non-stream') expect(result.hosted.companionState).toBe('complete');
      } finally { await f.close(); }
    });
  }
  it.each(['system', 'preset'] as const)('completes free-Web streaming through real Native and runtime using %s funding', async funding => {
    const f = await fixture(), host = context('battle'), native = createArenaHostedNativeSettle(f.invoke);
    const controller = new AbortController();
    try {
      const result = await executeArenaHosted({ invoke: native.invoke }, input('web'), {
        requestId: 'synthetic-web-native', mode: 'hosted', generationMode: 'stream', modelId: funding === 'system' ? 'default' : 'deepseek-chat',
        ...(funding === 'system' ? { systemConfig: {} } : { presetConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } }),
      }, host, controller.signal);
      expect(await native.settle(controller.signal)).toEqual({ status: 'succeeded' });
      expect(result).toMatchObject({ status: 'completed', renderSnapshot: { version: 1, reportFormat: 'web' },
        hosted: { responseStatus: 200, outputValidation: 'valid', serverStatus: 'completed' } });
      expect(result.markdown).toContain('<!doctype html>'); expect(result.markdown).toContain('合成服务正文');
      expect(result.markdown).not.toContain('MAHOSHOJO_ARENA_META');
      expect(host.recovery.getSnapshot().pointer).toMatchObject({ state: 'completed', format: 'web' });
      const posts = f.requests.filter(request => request.method === 'POST'); expect(posts).toHaveLength(1);
      expect(posts[0].body).toMatchObject({ reportFormat: 'web', writeArenaHistory: true, writeCurrentState: true });
      expect(posts[0].body?.customProvider).toEqual(funding === 'system' ? undefined : { providerId: 'deepseek', apiKey: 'SYNTHETIC-PROVIDER-KEY-CANARY', modelId: 'deepseek-chat' });
      expect(posts[0].body).not.toHaveProperty('webPackageRef'); expect(f.generated()).toBe(1);
    } finally { await f.close(); }
  });

  it.each([[401, 'UNAUTHORIZED'], [429, 'RATE_LIMITED'], [502, 'ARENA_PROVIDER_UNAVAILABLE'], [502, 'ACCOUNT_PRIVATE_CANARY_123']])('shows checked HTTP %s / %s without exposing server diagnostics or retrying', async (status, code) => {
    const f = await fixture({ status: status as number, code: code as string }), host = context('battle');
    try {
      const result = await executeArenaHosted({ invoke: f.invoke }, input(), { requestId: 'synthetic-native-rejection', mode: 'hosted', generationMode: 'non-stream', modelId: 'default', systemConfig: {} }, host, new AbortController().signal);
      expect(result.status).toBe('failed'); if (result.status !== 'failed') throw new Error('expected safe rejection');
      expect(result.message).toContain(`HTTP ${status}`); expect(result.message).toContain(code === 'ACCOUNT_PRIVATE_CANARY_123' ? 'UNRECOGNIZED_ERROR' : code); expect(result.message).not.toContain('synthetic-private');
      expect(result.message).not.toContain('ACCOUNT_PRIVATE_CANARY_123');
      expect(f.generated()).toBe(0); expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(host.recovery.getSnapshot().pointer?.state).toBe('unknown');
    } finally { await f.close(); }
  });
});
