/** Local synthetic component acceptance. Never loads Next, .env, accounts or model services. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as fixture from './fixtures/web-arena-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'apps/web');
const requireWeb = createRequire(path.join(APP, 'package.json'));
const ASSETS = ['arena-white.svg', 'logo-white-qrcode.svg', 'scenario-mode.svg', 'daily-mode.svg', 'classic-mode.svg', 'kizuna-mode.svg'];
const API_METHODS = new Map([
  ['/api/generate-battle-story', 'POST'], ['/api/arena/generate-stream', 'POST'],
  ['/api/arena/repair-combatant-meta', 'POST'], ['/api/verify-origin', 'POST'],
]);
const RUNNER_PATH = '/__web-package__/runner';
const QUERY_KEYS = new Set(['format', 'harnessFormat', 'generation', 'metadata', 'fixture']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => JSON.stringify(value, null, 2);
const webArtifacts = new WeakMap();

export function classifyRequest(rawUrl, method, origin, staticPaths) {
  let url;
  try { url = new URL(rawUrl, origin); } catch { return 'denied'; }
  if (url.origin !== origin || url.username || url.password) return 'denied';
  if (API_METHODS.get(url.pathname) === method && [...url.searchParams.keys()].every(key => QUERY_KEYS.has(key))) return 'fixture';
  if (method === 'GET' && staticPaths.has(url.pathname)) {
    if (url.pathname === '/') return [...url.searchParams.keys()].every(key => ['generation', 'format', 'metadata', 'fixture', 'author'].includes(key)) ? 'static' : 'denied';
    if (url.pathname === RUNNER_PATH) return [...url.searchParams.keys()].every(key => key === 'instance') ? 'static' : 'denied';
    return url.search === '' ? 'static' : 'denied';
  }
  return 'denied';
}

export async function buildHarness(outputDir) {
  await mkdir(outputDir, { recursive: true });
  const replacements = new Set(fixture.MOCK_MODULE_PATHS.map(name => path.join(APP, name)));
  const result = await build({
    absWorkingDir: ROOT, entryPoints: [path.join(APP, 'tests/browser/arena-report-harness.tsx')],
    outfile: path.join(outputDir, 'app.js'), bundle: true, write: false, platform: 'browser', format: 'esm',
    jsx: 'automatic', tsconfig: path.join(APP, 'tsconfig.json'), target: ['chrome111'],
    define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' }, metafile: true,
    plugins: [{ name: 'test-only-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData?.resolved) return;
        const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { resolved: true } });
        if (replacements.has(resolved.path)) return { path: path.join(APP, 'tests/browser/arena-report-ports.tsx') };
        return resolved;
      });
    } }],
  });
  const pluginPath = requireWeb.resolve('@tailwindcss/postcss');
  const postcss = createRequire(pluginPath)('postcss');
  const plugin = (await import(pathToFileURL(pluginPath).href)).default;
  const css = await postcss([plugin]).process('@import "./globals.css";\n@import "./blue-theme.css";\n@import "@mahoshojo/ui-web/markdown.css";', { from: path.join(APP, 'styles/arena-harness.css') });
  const files = new Map();
  for (const file of result.outputFiles) files.set('/' + path.basename(file.path), { body: file.contents, type: file.path.endsWith('.css') ? 'text/css' : 'text/javascript' });
  const moduleCss = files.get('/app.css')?.body ?? '';
  files.set('/app.css', { body: css.css + '\n' + Buffer.from(moduleCss).toString(), type: 'text/css' });
  // Compile the real restricted runner document without invoking the Next configuration.
  const runner = await build({ stdin: { contents: "export * from './lib/web-package/runner'; export { createWebPackageOverlay, BUILTIN_ARENA_NEWS_PACKAGE_REF } from '@mahoshojo/web-package';", resolveDir: APP }, bundle: true, platform: 'node', format: 'esm', write: false });
  const runnerModule = await import('data:text/javascript;base64,' + Buffer.from(runner.outputFiles[0].contents).toString('base64'));
  assert.equal(runnerModule.WEB_PACKAGE_RUNNER_PATH, RUNNER_PATH);
  const { generatedContent: _generated, ...artifact } = await runnerModule.createWebPackageOverlay(runnerModule.BUILTIN_ARENA_NEWS_PACKAGE_REF, fixture.reportText('web'));
  webArtifacts.set(files, artifact);
  files.set(RUNNER_PATH, { body: runnerModule.WEB_PACKAGE_RUNNER_HTML, type: 'text/html', headers: Object.fromEntries(runnerModule.WEB_PACKAGE_RUNNER_HEADERS.map(h => [h.key, h.value])) });
  for (const asset of ASSETS) files.set('/' + asset, { body: await readFile(path.join(APP, 'public', asset)), type: 'image/svg+xml' });
  files.set('/favicon.ico', { body: '', type: 'image/x-icon' });
  files.set('/', { body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成 Web 组件验收</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>', type: 'text/html' });
  for (const [name, file] of files) if (name === '/app.js' || name === '/app.css') await writeFile(path.join(outputDir, name.slice(1)), file.body);
  await writeFile(path.join(outputDir, 'build-inputs.json'), json(Object.keys(result.metafile.inputs)));
  assert(!Object.keys(result.metafile.inputs).some(name => /(?:^|\/)next\.config\.|(?:^|\/)\.env(?:\.|$)/u.test(name)), 'Forbidden production configuration input');
  return files;
}

export async function startHarnessServer(files) {
  const requests = [], pending = [];
  let origin;
  const server = createServer(async (request, response) => {
    const observed = { method: request.method, path: request.url ?? '/', kind: 'denied' };
    requests.push(observed);
    let url;
    try {
      if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) throw Error('Foreign host or origin');
      url = new URL(request.url ?? '/', origin);
    } catch { response.writeHead(403).end('Synthetic harness denied malformed or foreign request'); return; }
    const kind = classifyRequest(url.href, request.method, origin, new Set(files.keys()));
    Object.assign(observed, { path: url.pathname, query: url.search, kind });
    if (kind === 'denied' || request.headers.authorization || request.headers.cookie) { observed.kind = 'denied'; response.writeHead(403).end('Synthetic harness denied request'); return; }
    if (kind === 'static') {
      const file = files.get(url.pathname);
      response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'", ...file.headers });
      response.end(file.body); return;
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw Error('Synthetic request too large'); chunks.push(chunk); }
      observed.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const configuration = { format: url.searchParams.get('harnessFormat') === 'web' ? 'web' : 'markdown', metadata: url.searchParams.get('metadata') === 'missing' ? 'missing' : 'present' };
      if (url.pathname === '/api/verify-origin') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(json({ isValid: false })); return; }
      if (url.pathname === '/api/arena/repair-combatant-meta') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(json({ success: true, ...fixture.REPAIR_PATCH })); return; }
      if (url.pathname === '/api/generate-battle-story') {
        pending.push(() => response.writeHead(200, { 'Content-Type': 'application/json' }).end(json({ report: { ...fixture.makeReport(configuration), ...(configuration.format === 'web' && webArtifacts.has(files) ? { webPackage: webArtifacts.get(files) } : {}) }, generationId: fixture.GENERATION_ID, updatedCombatants: [] })));
        return;
      }
      const status = url.searchParams.get('fixture') === 'partial-failure' ? 'failed' : 'completed';
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'x-mahoshojo-generation-id': fixture.GENERATION_ID,
        'x-mahoshojo-stream-meta': encodeURIComponent(JSON.stringify({ outputContract: configuration.format === 'web' ? 'web-document' : 'stream-markdown', reportFormat: configuration.format, mode: 'scenario', scenarioDisplayName: fixture.SCENARIO_A.content.title, userGuidance: fixture.GUIDANCE_A })) });
      response.flushHeaders();
      const stages = [
        () => response.write(fixture.sse('reasoning', { chunk: '合成推理：核对角色与情景，再书写本地报告。', source: 'provider' })),
        () => response.write(fixture.sse('markdown', { chunk: fixture.reportText(configuration.format) })),
        () => { response.write(fixture.sse('meta', { parseOk: true, meta: { version: 1, report: { headline: '完成标题 A', winner: '角色甲' }, impacts: [] } })); response.write(fixture.sse('snapshot', { markdown: fixture.reportText(configuration.format), status,
          ...(configuration.metadata === 'present' ? { telemetry: { aiModel: fixture.MODEL, usage: fixture.USAGE } } : {}) })); response.end(fixture.sse('done', { status, ok: status === 'completed', ...(configuration.format === 'web' && webArtifacts.has(files) ? { webPackage: webArtifacts.get(files) } : {}) })); },
      ];
      pending.push(...stages);
    } catch (error) { observed.error = String(error); response.writeHead(400).end('Invalid synthetic request'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, advance() { assert(pending.length, 'No pending synthetic stage'); pending.shift()(); }, get pendingCount() { return pending.length; },
    async close() { pending.length = 0; server.closeAllConnections?.(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

const waitFor = async (predicate, message) => { for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await sleep(50); } throw Error(message); };
async function collectFonts(page, context) {
  const client = await context.newCDPSession(page); await client.send('DOM.enable'); await client.send('CSS.enable');
  const doc = await client.send('DOM.getDocument'); const samples = [];
  for (const selector of ['.result-card h2', '.result-card p', '.result-card p.text-xs', '.result-card .font-medium', '.result-card strong', '.result-card button', '.ai-reasoning-panel pre', '.error-message']) {
    const nodes = page.locator(selector); const count = Math.min(await nodes.count(), 4);
    for (let i = 0; i < count; i++) {
      const element = nodes.nth(i); if (!await element.isVisible()) continue;
      const nodeIds = (await client.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector })).nodeIds;
      samples.push({ selector, index: i, text: (await element.innerText()).slice(0, 150), computed: await element.evaluate(e => { const s = getComputedStyle(e); return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'].map(key => [key, s[key]])); }), rendered: (await client.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[i] })).fonts });
    }
  }
  await client.detach(); return samples;
}

async function runCase(browser, server, files, configuration, outputDir) {
  const name = Object.values(configuration).join('-'); const directory = path.join(outputDir, name); await mkdir(directory);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: 'block' });
  const denied = [], pageErrors = [], observed = [], dialogs = []; let expectedDialog = null, caseFailure, probingDenial = false;
  const deniedUrl = server.origin + '/api/harness-denied-probe';
  const start = server.requests.length;
  try {
    await context.route('**/*', route => {
      const request = route.request(); const kind = classifyRequest(request.url(), request.method(), server.origin, new Set(files.keys()));
      observed.push({ url: request.url(), method: request.method(), kind });
      if (kind === 'denied') { denied.push(request.url()); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error' && !(probingDenial && message.location().url === deniedUrl)) pageErrors.push(message.text()); });
    page.on('requestfailed', request => { if (!(probingDenial && request.url() === deniedUrl)) pageErrors.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`); });
    await page.addInitScript(() => window.addEventListener('securitypolicyviolation', event => console.error('HARNESS_CSP_VIOLATION', event.violatedDirective, event.blockedURI)));
    page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'confirm' && expectedDialog && /非原生可编辑版本|自定义 effect|缺失.*effect/u.test(dialog.message())) { const action = expectedDialog; expectedDialog = null; await dialog[action](); }
      else { pageErrors.push('Unexpected dialog: ' + dialog.message()); await dialog.dismiss(); }
    });
    await page.goto(server.origin + '/?' + new URLSearchParams(configuration));
    if (configuration.generation === 'stream' && configuration.format === 'markdown' && configuration.author === 'synthetic') {
      const errorColors = {};
      for (const [mode, label] of [['light', '浅色验收'], ['dark', '深色验收']]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.waitForFunction(value => document.documentElement.dataset.colorMode === value, mode);
        errorColors[mode] = {};
        for (const tone of ['red', 'blue']) {
          const sample = page.getByTestId('error-' + tone); const link = sample.getByRole('link');
          await link.focus(); await link.hover();
          errorColors[mode][tone] = await sample.evaluate(element => {
            const box = element.querySelector('.error-message'), anchor = element.querySelector('a');
            return { background: getComputedStyle(box).backgroundImage, fallback: getComputedStyle(box).backgroundColor,
              text: getComputedStyle(box).color, link: getComputedStyle(anchor).color,
              opacity: getComputedStyle(anchor.parentElement).opacity, focused: document.activeElement === anchor };
          });
          assert.equal(errorColors[mode][tone].opacity, '0.95'); assert(errorColors[mode][tone].focused);
          assert.equal(errorColors[mode][tone].text, errorColors[mode][tone].link);
          await sample.screenshot({ path: path.join(directory, `error-${mode}-${tone}.png`) });
        }
      }
      await writeFile(path.join(directory, 'error-colors.json'), json(errorColors));
      await page.getByRole('button', { name: '浅色验收', exact: true }).click();
    }
    await page.getByRole('button', { name: '生成合成报告 A', exact: true }).click();
    await waitFor(() => server.pendingCount > 0, 'Synthetic request was not observed');
    const card = page.locator('.result-card').first();
    if (configuration.generation === 'stream') {
      await card.waitFor(); await card.screenshot({ path: path.join(directory, 'waiting.png') });
      assert.equal(await page.locator('iframe').count(), 0, 'Incomplete Web report must not run');
      server.advance(); await page.locator('.ai-reasoning-panel').waitFor();
      await page.locator('.ai-reasoning-panel button').first().click();
      await card.screenshot({ path: path.join(directory, 'reasoning.png') });
      await writeFile(path.join(directory, 'reasoning-fonts.json'), json(await collectFonts(page, context)));
      server.advance(); await card.getByText(fixture.BODY, { exact: false }).first().waitFor();
      await card.screenshot({ path: path.join(directory, 'streaming.png') }); server.advance();
    } else server.advance();
    await waitFor(async () => !JSON.parse(await page.getByTestId('harness-observation').textContent()).isGenerating, 'Generation did not reach terminal state');
    await card.waitFor();
    if (configuration.fixture === 'partial-failure') {
      const state = JSON.parse(await page.getByTestId('harness-observation').textContent());
      assert(state.error?.includes('生成未成功完成')); assert.equal(state.resultWebReady, false);
      await page.getByTestId('generation-error').getByRole('alert').waitFor();
    } else assert.equal(JSON.parse(await page.getByTestId('harness-observation').textContent()).error, null);
    if (configuration.format === 'web') {
      assert.equal(await page.locator('iframe').count(), 0, 'No execution before explicit consent');
      await page.getByRole('button', { name: '继续使用 Web', exact: true }).click();
      const frame = page.locator('iframe'); await frame.waitFor();
      assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
      await page.frameLocator('iframe').getByText(fixture.BODY, { exact: false }).waitFor();
      await page.screenshot({ path: path.join(directory, 'web-consented.png'), fullPage: true });
      await page.getByRole('button', { name: '普通显示', exact: true }).click();
      assert.equal(await page.locator('iframe').count(), 0);
    }
    await card.getByText(fixture.BODY, { exact: false }).first().waitFor();
    assert((await card.innerText()).includes(fixture.BODY));
    if (configuration.metadata === 'missing') assert((await card.innerText()).includes('模型：未提供'));
    else { assert((await card.innerText()).includes(fixture.MODEL)); assert((await card.innerText()).includes('输入 123')); }
    await page.getByRole('button', { name: '修改下一场设置', exact: true }).click();
    const cardText = await card.innerText();
    if (configuration.author === 'synthetic') assert(cardText.includes('合成验收者小夜'), 'Synthetic display author missing');
    assert(cardText.includes(fixture.BODY)); assert(cardText.includes(fixture.SCENARIO_A.content.title)); assert(!cardText.includes('下一场情景 B')); assert(!cardText.includes('selection-model-B'));
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = image.onerror = resolve; }))); });
    await page.screenshot({ path: path.join(directory, 'page.png'), fullPage: true }); await card.screenshot({ path: path.join(directory, 'completed.png') });
    await writeFile(path.join(directory, 'fonts.json'), json(await collectFonts(page, context)));
    let dimensions = null;
    if (configuration.format === 'web') {
      assert.equal(await card.getByRole('button', { name: /保存为图片/u }).count(), 0, 'Package source view has no PNG export contract');
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ 下载生成目标', exact: true }).click()]);
      const targetPath = path.join(directory, 'generated-target.html'); await download.saveAs(targetPath);
      assert.equal(await readFile(targetPath, 'utf8'), fixture.reportText('web'));
    } else {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), card.getByRole('button', { name: /保存为图片/u }).click()]);
      const pngPath = path.join(directory, 'export.png'); await download.saveAs(pngPath); const png = await readFile(pngPath);
      assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Download is not PNG');
      dimensions = await page.evaluate(async data => { const image = new Image(); image.src = data; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, 'data:image/png;base64,' + png.toString('base64'));
      assert(dimensions.width > 0 && dimensions.height > 0);
    }
    if (configuration.generation === 'stream' && configuration.format === 'markdown' && configuration.metadata === 'present' && !configuration.fixture) {
      const observation = () => page.getByTestId('harness-observation').textContent().then(JSON.parse);
      const before = await observation();
      await page.getByRole('button', { name: '自定义修复本次角色变化', exact: false }).click();
      await page.getByRole('button', { name: 'AI 重新生成修复草稿', exact: false }).click();
      await waitFor(async () => (await page.locator('textarea').last().inputValue()).includes('用户修复影响'), 'Repair draft did not arrive');
      assert.deepEqual((await observation()).roster, before.roster, 'Draft auto-applied');
      const repair = server.requests.slice(start).find(request => request.path === '/api/arena/repair-combatant-meta');
      assert.equal(repair.body.mode, 'scenario'); assert.equal(repair.body.userGuidance, fixture.GUIDANCE_A); assert.equal(repair.body.scenario.title, fixture.SCENARIO_A.content.title);
      expectedDialog = 'dismiss'; await page.getByRole('button', { name: '应用修复', exact: true }).click();
      await waitFor(() => expectedDialog === null, 'Expected repair confirmation did not appear');
      const cancelled = await observation(); assert.deepEqual(cancelled.roster, before.roster); assert.deepEqual(cancelled.updatedCombatants, before.updatedCombatants); assert.equal(cancelled.repairAppliedGenerationId, before.repairAppliedGenerationId);
      expectedDialog = 'accept'; await page.getByRole('button', { name: '应用修复', exact: true }).click();
      await waitFor(async () => (await observation()).repairAppliedGenerationId === fixture.GENERATION_ID, 'Explicit repair did not apply');
      const repaired = (await observation()).roster[0].data;
      assert.equal(repaired.current_state.generation_id, fixture.GENERATION_ID); assert.equal(repaired.current_state.summary, '用户修复状态');
      const history = repaired.arena_history.entries.find(entry => entry.metadata.generation_id === fixture.GENERATION_ID);
      assert.equal(history.impact, '用户修复影响'); assert.equal(history.type, 'scenario');
      assert.equal(history.metadata.scenario_title, fixture.SCENARIO_A.content.title); assert.equal(history.metadata.user_guidance, fixture.GUIDANCE_A);
      await page.screenshot({ path: path.join(directory, 'repair.png'), fullPage: true });
    }
    assert.deepEqual(pageErrors, []); assert.deepEqual(denied, []);
    const creates = server.requests.slice(start).filter(request => ['/api/generate-battle-story', '/api/arena/generate-stream'].includes(request.path));
    assert.equal(creates.length, 1, 'Missing positive request control or unexpected create replay');
    assert.equal(creates[0].path, configuration.generation === 'stream' ? '/api/arena/generate-stream' : '/api/generate-battle-story');
    assert.equal(creates[0].body.reportFormat, configuration.format); assert.equal(creates[0].body.mode, 'scenario');
    assert.equal(creates[0].body.userGuidance, fixture.GUIDANCE_A); assert.equal(creates[0].body.scenario.title, fixture.SCENARIO_A.content.title);
    // Same-origin negative control exercises the actual browser route gate, without contacting any external host.
    probingDenial = true;
    assert.equal(await page.evaluate(async url => { try { await fetch(url); return 'unexpected-success'; } catch { return 'blocked'; } }, deniedUrl), 'blocked');
    assert.deepEqual(denied, [deniedUrl]); await sleep(0); assert.deepEqual(pageErrors, []);
    await writeFile(path.join(directory, 'evidence.json'), json({ configuration, cardText, dimensions, requests: server.requests.slice(start), browserRequests: observed, expectedDeniedProbe: denied, dialogs, pageErrors, pixelContentReview: 'required; PNG decode alone does not prove rendered text/logo/font correctness' }));
    return { name, status: 'passed', dimensions };
  } catch (error) {
    caseFailure = error;
    try { await writeFile(path.join(directory, 'failure.json'), json({ error: String(error?.stack ?? error), configuration, requests: server.requests.slice(start), browserRequests: observed, denied, dialogs, pageErrors })); }
    catch (reportError) { console.error('Could not save case failure evidence:', reportError); }
    throw error;
  } finally {
    try { await context.close(); } catch (cleanupError) { if (!caseFailure) throw cleanupError; console.error('Context cleanup also failed:', cleanupError); }
  }
}

// Runtime injection is only for Node fault tests; the CLI always uses the real builder/server/browser.
export async function runAcceptance({ prepareOnly = false, executablePath } = {}, runtime = {}) {
  await mkdir(path.join(ROOT, '.local/web-arena-acceptance'), { recursive: true });
  const outputDir = await mkdtemp(path.join(ROOT, '.local/web-arena-acceptance/run-'));
  const report = { scope: 'Synthetic production-component browser harness; not Next routing, live API, Tauri or Windows acceptance', status: 'running', outputDir, viewport: { width: 1440, height: 1100, deviceScaleFactor: 1 }, cases: [] };
  let browser, server, failure;
  try {
    report.source = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).trim(), harnessChanges: execFileSync('git', ['status', '--porcelain', '--', 'scripts/verify-web-arena-report.mjs', 'scripts/fixtures/web-arena-report.mjs', 'apps/web/tests/browser', 'tests/web-arena-acceptance.test.ts'], { cwd: ROOT, encoding: 'utf8' }).trim() };
    const files = await (runtime.buildHarness ?? buildHarness)(outputDir);
    if (prepareOnly) { report.status = 'prepared-browser-not-run'; } else {
    server = await (runtime.startHarnessServer ?? startHarnessServer)(files);
    const launch = runtime.launchBrowser ?? (() => requireWeb('playwright').chromium.launch({ headless: true, ...(executablePath ? { executablePath } : process.platform === 'win32' ? { channel: 'msedge' } : {}) }));
    browser = await launch();
    report.browserVersion = browser.version(); report.platform = process.platform;
    const cases = ['stream', 'non-stream'].flatMap(generation => ['markdown', 'web'].map(format => ({ generation, format, metadata: 'present', author: 'synthetic' })));
    cases.push({ generation: 'stream', format: 'markdown', metadata: 'missing' }, { generation: 'stream', format: 'markdown', metadata: 'present', fixture: 'partial-failure' });
    for (const configuration of cases) report.cases.push(await runCase(browser, server, files, configuration, outputDir));
    report.status = 'passed-pixel-review-required';
    }
  } catch (error) { failure = error; report.status = 'failed'; report.error = String(error?.stack ?? error); }
  finally {
    const cleanupErrors = [];
    try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await server?.close(); } catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.status = 'failed'; failure ??= Error(cleanupErrors.join('; ')); }
    try { await writeFile(path.join(outputDir, 'report.json'), json(report)); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const prepareOnly = args.includes('--prepare-only');
  const index = args.indexOf('--browser-executable'); const executablePath = index >= 0 ? args[index + 1] : undefined;
  const known = args.filter((_, i) => i !== index && i !== index + 1 || index < 0).filter(value => value !== '--prepare-only');
  if (known.length || (index >= 0 && !executablePath)) { console.error('Usage: node scripts/verify-web-arena-report.mjs [--prepare-only] [--browser-executable <installed Chromium path>]'); process.exitCode = 1; }
  else runAcceptance({ prepareOnly, executablePath }).then(report => console.log(json(report))).catch(error => { console.error(error); process.exitCode = 1; });
}
