import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';
import { strictCheck } from '../packages/domain/src/sensitive-word-filter';

const root = path.resolve(import.meta.dirname, '..');

describe('敏感词 browser-safe 子出口', () => {
  test('真实 bundle 无宿主/Node/network 依赖且仅靠 Web 标准 API 运行', async () => {
    const bundle = await build({
      absWorkingDir: root,
      stdin: {
        contents: "export { strictCheck } from '@mahoshojo/domain/sensitive-word-filter';",
        resolveDir: path.join(root, 'packages/domain'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'localSafety',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(bundle.metafile!.inputs);
    expect(inputs.some((input) => input.endsWith('pinyin-pro/dist/index.mjs'))).toBe(true);
    expect(inputs.some((input) => input.includes('ToolGood.Words.WordsSearch.mjs'))).toBe(true);
    expect(inputs.join('\n')).not.toMatch(/(?:hosted-runtime|apps\/|node:)/);
    expect(Object.values(bundle.metafile!.outputs).flatMap((output) => output.imports)).toEqual([]);
    const code = bundle.outputFiles[0].text;
    expect(code).not.toMatch(/\b(?:process|require|Buffer|fetch|XMLHttpRequest|WebSocket)\b/);
    const context = { atob, TextDecoder, console: { log: vi.fn(), error: vi.fn() } };
    runInNewContext(code, context);
    const api = (context as unknown as { localSafety: { strictCheck: typeof strictCheck } }).localSafety;
    for (const text of ['普通文本', '大陆官方', '中-华-帝-国', 'zhong hua di guo', 'YouPorn']) {
      expect(JSON.stringify(await api.strictCheck(text))).toBe(JSON.stringify(await strictCheck(text)));
    }
  });
});
