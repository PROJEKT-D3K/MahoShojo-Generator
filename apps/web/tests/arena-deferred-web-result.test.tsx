// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => { resolve = done; });
  return { ready, resolve, fail: true, download: vi.fn() };
});
vi.mock('@/components/stream/StreamingBattleReportCard', async () => {
  await fixture.ready;
  return { default: ({ reportContent, additionalActions }: { reportContent?: React.ReactNode; additionalActions?: React.ReactNode }) => {
    if (fixture.fail) throw new Error('renderer unavailable');
    return <section>{reportContent}{additionalActions}</section>;
  } };
});
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: fixture.download }));
import { BattleResultPresentation } from '@/components/arena/components/BattleResultPresentation';

const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};

test('卡片pending/失败/重试仍保留Web同意和导出；仅成功后创建一次iframe', async () => {
  localStorage.clear();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const createElement = vi.spyOn(document, 'createElement');
  const source = '<!doctype html><html><body>已生成的网页</body></html>';
  try {
    await act(async () => root.render(<BattleResultPresentation report={{
      format: 'stream-web', content: source, webReady: true, webConsentScope: 'deferred-web-test',
    }} />));
    expect(document.body.textContent).toContain('启用 Web 战报');
    expect(container.querySelector('iframe')).toBeNull();
    await click('继续使用 Web');
    expect(container.textContent).toContain('网页预览将在卡片加载完成后显示');
    await click('下载 HTML');
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(container.querySelector('iframe')).toBeNull();
    await act(async () => { fixture.resolve(); await vi.dynamicImportSettled(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('加载失败');
    expect(container.querySelector('iframe')).toBeNull();
    await click('下载 HTML');
    expect(fixture.download).toHaveBeenCalledTimes(2);
    fixture.fail = false;
    await click('重试加载');
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(createElement.mock.calls.filter(([name]) => name === 'iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
  } finally {
    await act(async () => root.unmount()); container.remove(); errorLog.mockRestore(); createElement.mockRestore();
  }
});
