import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const requireWeb = createRequire(path.join(root, 'apps/web/package.json'));
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const { JSDOM } = requireWeb('jsdom');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

type FeedbackProps = { message: string; appearance: 'full' | 'lite'; generation?: boolean };
let hosts: Record<string, (props: FeedbackProps) => unknown>;

beforeAll(async () => {
  // 编译真实宿主装配；只替换框架导航运行时，展示、分类和百科规则保持生产实现。
  const bundle = await build({
    stdin: { contents: `
      export { ArenaFeedbackMessage as Web } from './apps/web/components/arena/shared/ArenaFeedbackMessage';
      export { DesktopArenaFeedbackMessage as Desktop, DesktopArenaErrorMessage as SavedError } from './apps/desktop/src/features/arena/error-message';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    loader: { '.css': 'empty' },
    plugins: [{
      name: 'host-navigation-only',
      setup(builder) {
        builder.onResolve({ filter: /^(next\/link|@tanstack\/react-router)$/ }, ({ path: id }) => ({ path: id, namespace: 'navigation' }));
        builder.onLoad({ filter: /.*/, namespace: 'navigation' }, ({ path: id }) => ({
          contents: id === 'next/link'
            ? `import { createElement } from 'react'; export default props => createElement('a', props, props.children);`
            : 'export const useRouter = () => ({ navigate: () => Promise.resolve() });',
          loader: 'js',
        }));
      },
    }],
  });
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: requireWeb, console });
  hosts = module.exports;
}, 30_000);

const render = (host: string, props: FeedbackProps) => {
  const html = renderToStaticMarkup(createElement(hosts[host], props));
  return new JSDOM(html).window.document;
};

describe('Arena 双端真实反馈装配', () => {
  for (const appearance of ['full', 'lite'] as const) {
    it.each([
      ['❌ 数据卡 JSON 解析失败\n原输入保留', 'error'],
      ['⚠️ 冷却中，请稍候', 'warning'],
      ['未知提示', 'warning'],
      ['✨ 魔法失效了！网络连接中断', 'warning'],
      ['战报已生成，但角色更新失败', 'warning'],
    ])(`${appearance} 同消息产生相同变体：%s`, (message, tone) => {
      const web = render('Web', { message, appearance });
      const desktop = render('Desktop', { message, appearance });
      const webAlert = web.querySelector('[role=alert]')!;
      const desktopAlert = desktop.querySelector('[role=alert]')!;
      expect(webAlert.className).toBe(desktopAlert.className);
      expect(webAlert.classList.contains(`arena-feedback--${tone}`)).toBe(true);
      expect(webAlert.classList.contains(`arena-feedback--${appearance}`)).toBe(true);
      expect(webAlert.querySelector('.whitespace-pre-wrap')?.textContent).toBe(message);
      expect(desktopAlert.querySelector('.whitespace-pre-wrap')?.textContent).toBe(message);
      const help = webAlert.querySelector('a');
      expect(desktopAlert.querySelector('a')?.textContent).toBe(help?.textContent);
      expect(desktopAlert.querySelector('a')?.getAttribute('href')).toBe(help ? `#${help.getAttribute('href')}` : undefined);
    });

    it(`${appearance} 生成失败只保留宿主既有文案包装，不按 failed 重染色`, () => {
      const message = '网络连接中断\n已收到正文仍保留';
      const web = render('Web', { message: `✨ 魔法失效了！${message}`, appearance });
      const desktop = render('Desktop', { message, appearance, generation: true });
      expect(desktop.querySelector('[role=alert]')?.className).toBe(web.querySelector('[role=alert]')?.className);
      expect(desktop.querySelector('.whitespace-pre-wrap')?.textContent).toBe(`✨ 魔法失效了！${message}`);
      const alreadyWrapped = render('Desktop', { message: `✨ 魔法失效了！${message}`, appearance, generation: true });
      expect(alreadyWrapped.body.innerHTML).toBe(desktop.body.innerHTML);
    });
  }

  it('保存错误仍使用原通用框；实际页面显式选择 full/lite', () => {
    expect(render('SavedError', { message: '保存失败', appearance: 'full' }).querySelector('.error-message')).not.toBeNull();
    expect(read('apps/web/components/arena/ArenaPage.tsx')).toContain('<ArenaFeedbackMessage message={error} appearance="full"');
    expect(read('apps/web/components/arena-lite/BattleLitePage.tsx')).toContain('<ArenaFeedbackMessage message={error} appearance="lite"');
    const desktop = read('apps/desktop/src/app/battle-page.tsx');
    expect(desktop).toContain('<DesktopArenaErrorMessage message={state.saveError}');
    expect(desktop.match(/<DesktopArenaFeedbackMessage[^>]+appearance=\{product === 'battle' \? 'lite' : 'full'\}/g)).toHaveLength(2);
  });
});
