// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingBattleReportCard } from '@mahoshojo/ui-web/arena-report';
import { DesktopWebReport } from '../src/features/arena/DesktopWebReport';
import { DesktopWebReportExecution, type DesktopWebReportSource } from '../src/features/arena/web-execution';
import type { StructuredInvokeFn } from '../src/platform/local-archive-bridge';

const source: DesktopWebReportSource = { content: '<!doctype html><html><body><script>window.neverInMain = 1</script><p>作品原文</p></body></html>', title: '作品', ready: true };
let root: Root, container: HTMLDivElement;
let owner: DesktopWebReportExecution, invoke: ReturnType<typeof vi.fn<StructuredInvokeFn>>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  invoke = vi.fn(async (command, args) => {
    if (command === 'begin_web_package_instance') return { instanceId: 'wpk-1' };
    if (command === 'open_web_package_instance') return { label: 'webpkg-wpk-1' };
    const request = args?.request as { action: string; fullscreen?: boolean };
    return request.action === 'close' ? { instanceId: 'wpk-1', status: 'closed' }
      : { instanceId: 'wpk-1', status: 'open', fullscreen: request.fullscreen === true };
  });
  owner = new DesktopWebReportExecution({ available: true, invoke,
    rawInvoke: async (_command, bytes, options) => ({ receivedByteLength: Number(options.headers['x-webpkg-offset']) + bytes.byteLength }) });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const render = async (disabled = false, value = source) => act(async () => root.render(<DesktopWebReport source={value} disabled={disabled} execution={owner}>
  {(content, actions, showingWeb) => <StreamingBattleReportCard content={value.content} reportContent={content} additionalActions={actions} disableExport={showingWeb} />}
</DesktopWebReport>));
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
const click = async (label: string) => { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); };
const opens = () => invoke.mock.calls.filter(([command]) => command === 'open_web_package_instance');
const closes = () => invoke.mock.calls.filter(([command, args]) => command === 'control_web_package_instance' && (args?.request as { action: string }).action === 'close');

describe('Desktop shared Web display controls', () => {
  it('keeps one ordinary card and requires explicit consent before opening an independent window', async () => {
    await render();
    expect(container.querySelectorAll('.result-card')).toHaveLength(1);
    expect(container.querySelector('iframe,script,webview')).toBeNull();
    expect(container.textContent).toContain(source.content);
    await click('Web 显示'); expect(document.body.textContent).toContain('启用 Web 战报'); expect(invoke).not.toHaveBeenCalled();
    await click('取消'); expect(invoke).not.toHaveBeenCalled(); expect(button('普通显示').getAttribute('aria-pressed')).toBe('true');
    await click('Web 显示'); await click('继续使用 Web'); expect(opens()).toHaveLength(1);
    expect(button('Web 显示').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('iframe,script,webview')).toBeNull();
    expect(container.querySelector('[aria-label="独立 Web 作品窗口"] [role="status"]')?.textContent).toBe(owner.getSnapshot().message);
    await click('聚焦作品窗口');
    expect(invoke.mock.calls.at(-1)).toEqual(['control_web_package_instance', { request: { instanceId: 'wpk-1', action: 'focus' } }]);
    await click('重新加载');
    expect(invoke.mock.calls.at(-1)).toEqual(['control_web_package_instance', { request: { instanceId: 'wpk-1', action: 'reload' } }]);
    await click('沉浸体验'); expect(button('退出沉浸')).toBeTruthy(); expect(opens()).toHaveLength(1);
    await click('普通显示'); expect(closes()).toHaveLength(1); expect(button('普通显示').getAttribute('aria-pressed')).toBe('true');
    await click('Web 显示'); expect(opens()).toHaveLength(1); expect(document.body.textContent).toContain('启用 Web 战报');
  });

  it('does not close or rebuild a running work when unrelated action admission changes', async () => {
    await render(); await click('Web 显示'); await click('继续使用 Web');
    await render(true); expect(button('Web 显示').disabled).toBe(true); expect(closes()).toHaveLength(0);
    await render(false); expect(closes()).toHaveLength(0); expect(opens()).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(invoke.mock.calls.at(-1)).toEqual(['control_web_package_instance', { request: { instanceId: 'wpk-1', action: 'status' } }]);
  });

  it('disables both display choices while open is pending and preserves the unknown-result fence', async () => {
    let reject!: (reason: unknown) => void;
    invoke.mockImplementation(async command => command === 'begin_web_package_instance' ? { instanceId: 'wpk-1' }
      : new Promise((_resolve, fail) => { reject = fail; }));
    await render(); await click('Web 显示'); await click('继续使用 Web');
    expect(button('普通显示').disabled).toBe(true); expect(button('Web 显示').disabled).toBe(true);
    await act(async () => reject(new Error('lost open')));
    expect(container.textContent).toContain('打开结果尚未确认');
    await render(true); await render(false);
    expect(owner.getSnapshot().phase).toBe('uncertain'); expect(opens()).toHaveLength(1);
  });

  it('keeps Web disabled for partial output and a package without a verified replay instance', async () => {
    for (const value of [{ ...source, ready: false }, { ...source, instance: null }]) {
      await render(false, value); expect(button('Web 显示').disabled).toBe(true);
      expect(button('普通显示').disabled).toBe(false); expect(button('运行 Web 战报').disabled).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
