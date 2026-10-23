import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { createHarnessBoundaryPlugin } from '../scripts/verify-web-arena-report.mjs';
import { MOCK_MODULE_PATHS } from '../scripts/fixtures/web-arena-report.mjs';

it('只注册精确文件加载替换，不跨 JS 重复解析整个依赖图', () => {
  const loads: { filter: RegExp; namespace: string }[] = [];
  const appRoot = path.join(path.parse(process.cwd()).root, 'synthetic', 'app.with+[metacharacters]');
  createHarnessBoundaryPlugin(appRoot).setup({
    onLoad(options: { filter: RegExp; namespace: string }) { loads.push(options); },
    onResolve() { throw new Error('Must use native resolution'); },
  });
  expect(loads).toHaveLength(1);
  expect(loads[0].namespace).toBe('file');
  for (const name of MOCK_MODULE_PATHS) {
    expect(loads[0].filter.test(path.join(appRoot, name))).toBe(true);
    expect(loads[0].filter.test(path.join(appRoot, name) + '.extra')).toBe(false);
    expect(loads[0].filter.test(path.join(path.dirname(appRoot), 'appXwith+[metacharacters]', name))).toBe(false);
  }
});

it('原生别名、相对和绝对导入共享 ports 的默认/具名导出与副作用，不读取被替换生产模块', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-boundaries-'));
  try {
    const put = async (name: string, content: string) => {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    };
    for (const name of MOCK_MODULE_PATHS) await put(name, 'THIS IS INVALID PRODUCTION SOURCE');
    await put('tests/browser/state.ts', 'export const state: { count: number } = { count: 0 };');
    await put('tests/browser/arena-report-ports.tsx', "import { state } from './state'; state.count++; export { state }; export default state;");
    await put('other/auth.ts', 'export const real = "real non-target";');
    const result = await build({
      absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs',
      tsconfigRaw: { compilerOptions: { baseUrl: root, paths: { '@/*': ['./*'] } } },
      stdin: { resolveDir: root, contents: `
        import first, { state } from '@/lib/auth';
        import second from './lib/cooldown';
        import third from ${JSON.stringify(path.join(root, 'lib/useAuth.ts'))};
        import { real } from './other/auth';
        export const observation = { same: first === second && second === third && third === state, count: state.count, real };
      ` },
      plugins: [createHarnessBoundaryPlugin(root)],
    });
    const module = { exports: {} as { observation?: unknown } };
    new Function('exports', 'module', result.outputFiles[0].text)(module.exports, module);
    expect(module.exports.observation).toEqual({ same: true, count: 1, real: 'real non-target' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
