import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildHarness, classifyRequest, runAcceptance, startHarnessServer } from '../scripts/verify-web-arena-report.mjs';
import { BODY, GENERATION_ID, GUIDANCE_A, MODEL, REPAIR_PATCH, SCENARIO_A, USAGE, makeReport, reportText } from '../apps/web/tests/browser/arena-report-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..');
const requireWeb = createRequire(path.join(root, 'apps/web/package.json'));
const { JSDOM, VirtualConsole } = requireWeb('jsdom');
const origin = 'http://127.0.0.1:43127';
const staticPaths = new Set(['/', '/app.js', '/app.css', '/arena-white.svg', '/__web-package__/runner']);
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000, interval: 20 });
const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
const rawGet = (origin: string, requestPath: string, headers: Record<string, string>) => new Promise<number | undefined>((resolve, reject) => {
  const request = httpRequest(origin, { path: requestPath, headers }, (response) => {
    response.resume();
    response.once('end', () => resolve(response.statusCode));
    response.once('error', reject);
  });
  request.once('error', reject);
  request.end();
});
let directory: string;
let files: Awaited<ReturnType<typeof buildHarness>>;

beforeAll(async () => {
  const output = path.join(root, '.local/web-harness-tests');
  await mkdir(output, { recursive: true });
  directory = await mkdtemp(path.join(output, 'build-'));
  files = await buildHarness(directory);
}, 60_000);

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('合成 Web 验收网络边界', () => {
  it.each([
    ['/?generation=stream&format=markdown&metadata=missing', 'GET', 'static'],
    ['/app.js', 'GET', 'static'],
    ['/app.css', 'GET', 'static'],
    ['/__web-package__/runner?instance=synthetic', 'GET', 'static'],
    ['/api/generate-battle-story', 'POST', 'fixture'],
    ['/api/arena/generate-stream?harnessFormat=web&fixture=partial-failure', 'POST', 'fixture'],
    ['/api/arena/repair-combatant-meta', 'POST', 'fixture'],
    ['/api/verify-origin', 'POST', 'fixture'],
  ])('允许精确本地路径和方法：%s %s', (url, method, expected) => {
    expect(classifyRequest(url, method, origin, staticPaths)).toBe(expected);
  });

  it.each([
    ['http://127.0.0.1:43128/app.js', 'GET'],
    ['http://localhost:43127/app.js', 'GET'],
    ['https://127.0.0.1:43127/app.js', 'GET'],
    ['https://example.invalid/app.js', 'GET'],
    ['//example.invalid/api/arena/generate-stream', 'POST'],
    ['http://synthetic:credential@127.0.0.1:43127/app.js', 'GET'],
    ['ws://127.0.0.1:43127/app.js', 'GET'],
    ['wss://example.invalid/socket', 'GET'],
    ['/api/media-proxy?url=https://example.invalid/image.png', 'GET'],
    ['/api/not-a-fixture', 'POST'],
    ['/api/arena/generate-stream', 'GET'],
    ['/api/arena/generate-stream', 'PUT'],
    ['/api/arena/generate-stream/', 'POST'],
    ['/api/arena/generate-stream?url=https://example.invalid', 'POST'],
    ['/app.js', 'POST'],
    ['/app.js', 'HEAD'],
    ['/app.js?unexpected=1', 'GET'],
    ['/?redirect=https://example.invalid', 'GET'],
    ['/__web-package__/runner?url=https://example.invalid', 'GET'],
    ['http://[', 'GET'],
  ])('拒绝越界 origin、端口、方法或路径：%s %s', (url, method) => {
    expect(classifyRequest(url, method, origin, staticPaths)).toBe('denied');
  });

  it('真实 HTTP 正控可返回报告；未知 API 和凭据头均拒绝', async () => {
    const server = await startHarnessServer(files);
    try {
      expect(new URL(server.origin).hostname).toBe('127.0.0.1');
      const page = await fetch(server.origin);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await page.text()).toContain('src="/app.js"');
      const script = await fetch(server.origin + '/app.js');
      expect(script.headers.get('content-type')).toBe('text/javascript');
      expect(Buffer.from(await script.arrayBuffer()).equals(Buffer.from(files.get('/app.js').body))).toBe(true);

      const generated = fetch(server.origin + '/api/generate-battle-story', post);
      await waitFor(() => expect(server.pendingCount).toBe(1));
      expect(server.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/generate-battle-story', kind: 'fixture', body: {} });
      server.advance();
      const response = await generated;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ report: makeReport(), generationId: GENERATION_ID, updatedCombatants: [] });
      expect(server.pendingCount).toBe(0);

      for (const [route, init] of [
        ['/api/not-a-fixture', post],
        ['/api/media-proxy?url=https://example.invalid/image.png', {}],
        ['/api/generate-battle-story', { ...post, method: 'PUT' }],
        ['/api/generate-battle-story', { ...post, headers: { Authorization: 'Bearer synthetic-test-only' } }],
        ['/app.js', { headers: { Cookie: 'synthetic=test-only' } }],
      ] as const) {
        const denied = await fetch(server.origin + route, init);
        expect(denied.status).toBe(403);
        expect(await denied.text()).toBe('Synthetic harness denied request');
        expect(server.requests.at(-1).kind).toBe('denied');
      }
      expect(await rawGet(server.origin, '/', { Host: new URL(server.origin).host, Origin: server.origin })).toBe(200);
      for (const [requestPath, headers] of [
        ['/', { Host: 'example.invalid' }],
        ['/', { Origin: 'https://example.invalid' }],
        ['//[', {}],
      ] as const) {
        expect(await rawGet(server.origin, requestPath, headers)).toBe(403);
        expect(server.requests.at(-1).kind).toBe('denied');
      }
      expect(server.pendingCount).toBe(0);
    } finally { await server.close(); }
  });

  it('真实 HTTP 流按推理、正文、终态三次推进并带权威元数据', async () => {
    const server = await startHarnessServer(files);
    try {
      const response = await fetch(server.origin + '/api/arena/generate-stream', post);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('x-mahoshojo-generation-id')).toBe(GENERATION_ID);
      expect(server.pendingCount).toBe(3);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      server.advance();
      expect(decoder.decode((await reader.read()).value)).toContain('event: reasoning\n');
      expect(server.pendingCount).toBe(2);
      server.advance();
      const markdown = decoder.decode((await reader.read()).value);
      expect(markdown).toContain('event: markdown\n');
      expect(markdown).toContain(JSON.stringify({ chunk: reportText() }));
      server.advance();
      let terminal = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        terminal += decoder.decode(chunk.value, { stream: true });
      }
      terminal += decoder.decode();
      expect(terminal).toContain('event: snapshot\n');
      expect(terminal).toContain(JSON.stringify({ aiModel: MODEL, usage: USAGE }));
      expect(terminal).toContain('event: done\ndata: {"status":"completed","ok":true}');
      expect(server.pendingCount).toBe(0);
    } finally { await server.close(); }
  });
});

describe('无浏览器构建与真实组件 DOM smoke', () => {
  it('prepare-only 构建真实 bundle、样式和依赖清单，不运行浏览器或读取 Next/env 配置', async () => {
    const prepared = await runAcceptance({ prepareOnly: true });
    try {
      expect(prepared.status).toBe('prepared-browser-not-run');
      expect(prepared.cases).toEqual([]);
      expect(prepared).not.toHaveProperty('browserVersion');
      const script = await readFile(path.join(prepared.outputDir, 'app.js'));
      const style = await readFile(path.join(prepared.outputDir, 'app.css'), 'utf8');
      const inputs: string[] = JSON.parse(await readFile(path.join(prepared.outputDir, 'build-inputs.json'), 'utf8'));
      expect(script.byteLength).toBeGreaterThan(0);
      expect(style).toContain('.result-card');
      expect(style).toContain('.error-message');
      for (const entry of ['useBattleEngine.ts', 'useCombatantRepair.ts', 'BattleResult.tsx']) {
        expect(inputs.some(input => input.endsWith('/' + entry))).toBe(true);
      }
      expect(inputs.filter(input => /(?:^|\/)next\.config\.|(?:^|\/)\.env(?:\.|$)/u.test(input))).toEqual([]);
    } finally { await rm(prepared.outputDir, { recursive: true, force: true }); }
  }, 60_000);

  it('launch 故障保留原异常、写入失败报告并关闭实际 HTTP 服务', async () => {
    const launchError = new Error('Synthetic browser launch unavailable');
    let outputDir = '';
    let closeCalls = 0;
    let closed = false;
    let server: Awaited<ReturnType<typeof startHarnessServer>> | undefined;
    try {
      await expect(runAcceptance({}, {
        async buildHarness(directory: string) { outputDir = directory; return files; },
        async startHarnessServer(input: typeof files) {
          expect(input).toBe(files);
          server = await startHarnessServer(input);
          const close = server.close.bind(server);
          server.close = async () => { closeCalls++; await close(); closed = true; };
          return server;
        },
        async launchBrowser() {
          expect(await rawGet(server!.origin, '/', {})).toBe(200);
          throw launchError;
        },
      })).rejects.toBe(launchError);
      expect(closeCalls).toBe(1);
      expect(closed).toBe(true);
      const report = JSON.parse(await readFile(path.join(outputDir, 'report.json'), 'utf8'));
      expect(report).toMatchObject({ status: 'failed', cases: [] });
      expect(report.error).toBe(launchError.stack);
      expect(report).not.toHaveProperty('browserVersion');
      await expect(fetch(server!.origin, { signal: AbortSignal.timeout(2_000) }))
        .rejects.toMatchObject({ name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
    } finally {
      if (!closed) await server?.close();
      if (outputDir) await rm(outputDir, { recursive: true, force: true });
    }
  });

  it.each([
    { generation: 'stream', metadata: 'present', fixture: 'complete' },
    { generation: 'non-stream', metadata: 'present', fixture: 'complete' },
    { generation: 'stream', metadata: 'missing', fixture: 'complete' },
    { generation: 'stream', metadata: 'present', fixture: 'partial-failure' },
  ])('已构建 $generation/$metadata/$fixture 报告保留真实终态与生成上下文', async (configuration) => {
    const { generation, metadata, fixture } = configuration;
    const server = await startHarnessServer(files);
    const errors: string[] = [];
    const denied: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error: Error) => errors.push(String(error)));
    virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
    // No resource loader: jsdom cannot issue image/iframe/script requests independently.
    // Layout-only APIs are inert; engine, rendering, repair and HTTP remain the real bundle.
    const dom = new JSDOM(Buffer.from(files.get('/').body).toString(), {
      url: `${server.origin}/?${new URLSearchParams({ ...configuration, format: 'markdown' })}`,
      runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
    });
    const window = dom.window;
    const closeWindow = window.close.bind(window);
    const failures: unknown[] = [];
    Object.assign(window, {
      TextEncoder, TextDecoder, Headers, Request, Response, ReadableStream,
      AbortController, AbortSignal, structuredClone,
      scrollTo: () => undefined,
      fetch: (input: string | Request, init: RequestInit = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, server.origin);
        const method = init.method ?? (typeof input === 'string' ? 'GET' : input.method);
        const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers));
        if (classifyRequest(url.href, method, server.origin, new Set(files.keys())) === 'denied'
          || headers.has('Authorization') || headers.has('Cookie')) {
          denied.push(`${method} ${url.href}`);
          return Promise.reject(new Error('DOM smoke denied network request'));
        }
        return fetch(url, { ...init, method, headers, credentials: 'omit' });
      },
    });
    window.HTMLElement.prototype.scrollIntoView = () => undefined;
    for (const name of ['WebSocket', 'EventSource', 'XMLHttpRequest']) {
      window[name] = class { constructor() { denied.push(name); throw new Error(`${name} is unavailable in this smoke`); } };
    }
    const observation = () => JSON.parse(window.document.querySelector('[data-testid="harness-observation"]')!.textContent);
    const button = (label: string) => {
      const match = [...window.document.querySelectorAll('button')].find((element: HTMLButtonElement) => element.textContent?.includes(label));
      expect(match, `Missing button: ${label}`).toBeDefined();
      expect(match.disabled).toBe(false);
      return match;
    };
    const card = () => window.document.querySelector('.result-card')?.textContent ?? '';
    try {
      // The browser loads this self-contained bundle as a module. Preserve its local
      // scope in jsdom too, so dependency identifiers cannot overwrite Window APIs.
      window.eval(`(() => { "use strict";\n${Buffer.from(files.get('/app.js').body).toString()}\n})();`);
      await waitFor(() => expect(window.document.querySelector('[data-testid="harness-observation"]')).not.toBeNull());
      button('生成合成报告 A').click();
      await waitFor(() => expect(server.pendingCount).toBe(generation === 'stream' ? 3 : 1));
      expect(observation().isGenerating).toBe(true);
      if (generation === 'stream') {
        expect(window.document.querySelector('iframe')).toBeNull();
        server.advance();
        await waitFor(() => expect(window.document.querySelector('.ai-reasoning-panel')).not.toBeNull());
        server.advance();
        await waitFor(() => expect(card()).toContain(BODY));
        expect(observation().isGenerating).toBe(true);
      }
      server.advance();
      await waitFor(() => expect(observation().isGenerating).toBe(false));
      await waitFor(() => expect(card()).toContain(BODY));
      if (metadata === 'missing') {
        expect(card()).toContain('模型：未提供');
        expect(card()).toContain('输入 未提供');
        expect(card()).toContain('推理 未提供');
        expect(card()).toContain('输出 未提供');
        expect(card()).not.toContain(MODEL);
      } else {
        await waitFor(() => expect(card()).toContain(MODEL));
        expect(card()).toContain('输入 123');
      }
      expect(card()).not.toContain('selection-model-A');
      if (fixture === 'partial-failure') {
        expect(observation().error).toBe('生成未成功完成，当前内容仅供普通显示。');
        expect(observation().resultWebReady).toBe(false);
        expect(window.document.querySelector('[data-testid="generation-error"]').textContent).toContain(observation().error);
      } else expect(observation().error).toBeNull();
      const before = observation();
      expect(before.lastGenerationId).toBe(GENERATION_ID);
      expect(before.resultContext).toMatchObject({ generationMode: generation, battleMode: 'scenario', scenarioDisplayName: SCENARIO_A.content.title });

      button('修改下一场设置').click();
      await waitFor(() => expect(observation().currentSettings.battleMode).toBe('daily'));
      expect(observation().currentSettings).toMatchObject({ selectedModel: 'selection-model-B', userGuidance: '下一场指导 B', reportFormat: 'web' });
      expect(observation().resultContext).toEqual(before.resultContext);
      expect(card()).toContain(BODY);
      expect(card()).toContain(SCENARIO_A.content.title);
      expect(card()).not.toContain('下一场情景 B');
      expect(card()).not.toContain('selection-model-B');

      if (fixture !== 'partial-failure') {
        button('自定义修复本次角色变化').click();
        await waitFor(() => { button('AI 重新生成修复草稿'); });
        button('AI 重新生成修复草稿').click();
        await waitFor(() => expect([...window.document.querySelectorAll('textarea')].some((element: HTMLTextAreaElement) => element.value.includes('用户修复影响'))).toBe(true));
        const draft = [...window.document.querySelectorAll('textarea')].find((element: HTMLTextAreaElement) => element.value.includes('用户修复影响'));
        expect(JSON.parse(draft.value)).toEqual(REPAIR_PATCH);
        const repair = server.requests.find(request => request.path === '/api/arena/repair-combatant-meta');
        expect(repair.body).toMatchObject({ generationId: GENERATION_ID, mode: 'scenario', userGuidance: GUIDANCE_A, scenario: { title: SCENARIO_A.content.title } });
      }
      expect(observation().roster).toEqual(before.roster);
      expect(observation().updatedCombatants).toEqual(before.updatedCombatants);
      expect(observation().repairAppliedGenerationId).toBe(before.repairAppliedGenerationId);
      expect(server.requests.filter(request => ['/api/generate-battle-story', '/api/arena/generate-stream'].includes(request.path))).toHaveLength(1);
      expect(errors).toEqual([]);
      expect(denied).toEqual([]);
      // PNG capture is intentionally not clicked: jsdom has no real canvas/layout pixels.
    } catch (error) { failures.push(error); }
    finally {
      try { closeWindow(); } catch (error) { failures.push(error); }
      try { await server.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'DOM smoke 与清理均发生错误');
  });
});
