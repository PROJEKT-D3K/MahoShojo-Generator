import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
// Use the exact webpack shipped with this Next dependency, rather than a mock import cache.
const { webpack } = require('next/dist/compiled/webpack/webpack');
const directory = mkdtempSync(path.join(tmpdir(), 'maho-deferred-webpack-'));

beforeAll(async () => {
  const source = readFileSync(path.resolve(__dirname, '../lib/client/loadDeferredModule.ts'), 'utf8');
  writeFileSync(path.join(directory, 'loader.js'), transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText);
  writeFileSync(path.join(directory, 'feature.js'), 'export const result = "loaded";');
  writeFileSync(path.join(directory, 'entry.js'), `
    import { createDeferredModuleLoader } from './loader.js';
    self.loadFeature = createDeferredModuleLoader(() => import('./feature.js'));
  `);
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack({
      mode: 'development', target: 'web', devtool: false,
      entry: path.join(directory, 'entry.js'),
      output: { path: path.join(directory, 'dist'), filename: 'main.js', chunkFilename: '[id].[contenthash].js', publicPath: 'https://maho.test/_next/static/chunks/' },
    });
    compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
      compiler.close((closeError: Error | null) => {
        if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats.toString()));
        else resolve();
      });
    });
  });
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function createBrowser(shouldFail: (attempt: number) => boolean) {
  const browser = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://maho.test/arena', runScripts: 'outside-only',
  });
  const requests: string[] = [];
  const head = browser.window.document.head;
  const append = head.appendChild.bind(head);
  head.appendChild = ((node: Node) => {
    const result = append(node);
    if (node.nodeName === 'SCRIPT') {
      const script = node as HTMLScriptElement;
      requests.push(script.src);
      queueMicrotask(() => {
        if (shouldFail(requests.length)) script.dispatchEvent(new browser.window.Event('error'));
        else {
          browser.window.eval(readFileSync(path.join(directory, 'dist', path.basename(new URL(script.src).pathname)), 'utf8'));
          script.dispatchEvent(new browser.window.Event('load'));
        }
      });
    }
    return result;
  }) as typeof head.appendChild;
  browser.window.eval(readFileSync(path.join(directory, 'dist/main.js'), 'utf8'));
  const load = (browser.window as unknown as { loadFeature: () => Promise<{ result: string }> }).loadFeature;
  return { browser, requests, load };
}

test('Next实际webpack runtime会为瞬时失败重发相同hash URL，并共享并发加载', async () => {
  const { browser, requests, load } = createBrowser((attempt) => attempt === 1);
  try {
    const first = load();
    expect(load()).toBe(first);
    await expect(first).resolves.toMatchObject({ result: 'loaded' });
    expect(requests).toHaveLength(2);
    expect(new Set(requests).size).toBe(1);
    expect(browser.window.document.querySelectorAll('script')).toHaveLength(0);
  } finally { browser.window.close(); }
});

test('Next实际webpack旧URL永久缺失会有限终止；显式重试不能更新旧manifest', async () => {
  let missing = true;
  const { browser, requests, load } = createBrowser(() => missing);
  const confirm = vi.spyOn(browser.window, 'confirm');
  try {
    await expect(load()).rejects.toMatchObject({ name: 'ChunkLoadError', type: 'error' });
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
    expect(browser.window.document.querySelectorAll('script')).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
    missing = false;
    await expect(load()).resolves.toMatchObject({ result: 'loaded' });
    expect(requests).toHaveLength(4);
    expect(new Set(requests).size).toBe(1);
  } finally { confirm.mockRestore(); browser.window.close(); }
});
