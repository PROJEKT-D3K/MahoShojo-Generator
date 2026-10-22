// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATTLE_STORY_CONTENT_PREVIEW_CHARACTERS } from '@mahoshojo/ui-web/arena-story-session';
import { DesktopRoomGenerationResult, type DesktopRoomGenerationResultProps } from '../src/features/arena/room-generation-result';
import { ExternalLinksProvider } from '../src/features/external-links/external-links-provider';
import { createDesktopBattleReportPorts } from '../src/features/arena/report-ports';

const mocks = vi.hoisted(() => ({ download: vi.fn(), downloadBlob: vi.fn(), capture: vi.fn() }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download, downloadBlobFile: mocks.downloadBlob }));
vi.mock('@mahoshojo/ui-web/client', async original => ({ ...await original<object>(), capturePngBlob: mocks.capture }));
const generation: DesktopRoomGenerationResultProps['generation'] = {
  phase: 'running', markdown: '# 共享战报\n\n正文 [内容链接](https://example.com/report)\n\n![图片](https://example.com/private.png)',
  gap: null, finalAuthoritative: false, generationRecordId: null, errorCode: null, recoveryCode: null,
  result: { version: 1, format: 'stream-markdown', mode: 'classic', reporterInfo: { name: '房间记者', publication: '共同日报' },
    ai: { model: 'shared-model', usage: { promptTokens: 12, completionTokens: 8 } },
    sharedGuidance: '本轮故事引导', characterGuidances: [{ combatantKey: 'character:1', displayName: '甲', guidance: '守住车站' }],
    combatantUpdates: [{ combatantKey: 'character:1', displayName: '甲', impact: '共同守住车站' }] },
};
let root: Root, container: HTMLDivElement;
const invoke = vi.fn();
const retry = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks(); invoke.mockResolvedValue(undefined);
  mocks.download.mockReset(); mocks.downloadBlob.mockReset(); mocks.capture.mockReset().mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const render = async (next = generation, props: Partial<DesktopRoomGenerationResultProps> = {}) => {
  await act(async () => root.render(<ExternalLinksProvider invoke={invoke}><DesktopRoomGenerationResult generation={next} generationKey="room:epoch:generation-1" onRetry={retry} {...props} /></ExternalLinksProvider>));
};
const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
const click = async (text: string) => { expect(button(text)).toBeTruthy(); await act(async () => button(text)!.click()); };

describe('Desktop current room report adapter', () => {
  it('uses the shared result shell with the actual report card, metadata and safe summaries', async () => {
    await render();
    expect(container.querySelector('[data-arena-room-generation-report="v1"]')).not.toBeNull();
    expect(container.querySelector('.result-card')).not.toBeNull();
    for (const text of ['房间记者', '共同日报', 'shared-model', '本轮故事引导', '战后角色变化', '当前显示实时预览']) expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain('战报已完成');
    for (const text of ['开始协作生成', '停止生成', '重做角色更新', '应用手动修改', '保存到云端']) expect(button(text)).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });

  it('forwards host image, markdown and attribution ports into the same shared report card', async () => {
    const captured: Array<{ text: string | null; logo: string | undefined; externalImage: boolean }> = [];
    const saveImage = vi.fn(async (element: HTMLElement) => {
      captured.push({ text: element.textContent, logo: element.querySelector<HTMLElement>('.logo-placeholder')?.style.display,
        externalImage: !!element.querySelector('img[src^="https:"]') });
    });
    const downloadMarkdown = vi.fn();
    await render({ ...generation, phase: 'completed', finalAuthoritative: true }, {
      createReportPorts: () => ({ saveImage, downloadMarkdown, generatedBy: <span>本机用户署名</span> }),
    });
    await click('📱 保存为图片');
    expect(saveImage).toHaveBeenCalledOnce();
    expect(saveImage.mock.calls[0]?.[0]).toBe(container.querySelector('.result-card'));
    expect(captured[0]).toMatchObject({ logo: 'flex', externalImage: false });
    expect(captured[0]?.text).toContain('本机用户署名'); expect(captured[0]?.text).toContain('shared-model');
    await click('📄 下载记录'); expect(downloadMarkdown).toHaveBeenCalledOnce();
    expect(downloadMarkdown.mock.calls[0]?.[0]).toContain('# 共享战报');
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });

  it('blocks external media and sends report links through the existing confirmation/native gate', async () => {
    await render();
    expect(container.querySelector('img[src^="https:"]')).toBeNull();
    const link = [...container.querySelectorAll('[role="link"]')].find(node => node.textContent === '内容链接') as HTMLElement;
    expect(link).toBeTruthy(); expect(link.getAttribute('href')).toBeNull();
    await act(async () => link.click());
    expect(document.body.textContent).toContain('打开外部链接？');
    expect(invoke).not.toHaveBeenCalled();
    await click('在系统浏览器打开');
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/report' });
  });

  it.each(['image', 'markdown'] as const)('keeps %s export failure visible beside the room report and permits an explicit retry', async kind => {
    const exporting = vi.fn();
    const createReportPorts: NonNullable<DesktopRoomGenerationResultProps['createReportPorts']> = onError => createDesktopBattleReportPorts({
      onError, onNavigateExternal: vi.fn(), onExportingChange: exporting,
    });
    const error = new Error('本次下载无法创建文件');
    if (kind === 'image') mocks.capture.mockRejectedValueOnce(error);
    else mocks.download.mockImplementationOnce(() => { throw error; });
    await render({ ...generation, phase: 'completed', finalAuthoritative: true }, { createReportPorts });
    const label = kind === 'image' ? '📱 保存为图片' : '📄 下载记录';
    await click(label);
    const alert = container.querySelector('.error-message[role="alert"]');
    expect(alert?.textContent).toContain(kind === 'image' ? '生成图片失败' : error.message);
    expect(alert?.closest('[hidden]')).toBeNull();
    expect(container.querySelector('.result-card')?.textContent).toContain('共享战报');
    expect(container.querySelector<HTMLElement>('.buttons-container')?.style.display).not.toBe('none');
    expect(button(label)?.disabled).toBe(false);
    if (kind === 'image') expect(exporting.mock.calls).toEqual([[true], [false]]);
    await click(label);
    expect(container.querySelector('.error-message[role="alert"]')).toBeNull();
    expect(kind === 'image' ? mocks.downloadBlob : mocks.download).toHaveBeenCalledTimes(kind === 'image' ? 1 : 2);
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });

  it.each(['full-markdown', 'web-source'] as const)('reports failed %s download locally without losing the original', async kind => {
    const web = kind === 'web-source';
    const content = web ? '<html><body>保留完整源码</body></html>' : '# 长正文\n' + '文'.repeat(BATTLE_STORY_CONTENT_PREVIEW_CHARACTERS + 1);
    const next = { ...generation, phase: 'completed' as const, finalAuthoritative: true, markdown: content,
      result: { version: 1 as const, format: web ? 'stream-web' as const : 'stream-markdown' as const, mode: 'daily' as const } };
    mocks.download.mockImplementationOnce(() => { throw new Error('完整原文下载失败'); });
    await render(next);
    const label = web ? '导出安全源码文本' : '导出当前完整正文';
    await click(label);
    expect(container.querySelector('.error-message[role="alert"]')?.textContent).toContain('完整原文下载失败');
    expect(mocks.download.mock.calls[0]?.[1]).toBe(content);
    if (web) expect(container.querySelector('[data-testid="arena-web-result"] pre')?.textContent).toBe(content);
    else expect(container.querySelector('[data-story-content-preview]')).not.toBeNull();
    await click(label);
    expect(container.querySelector('.error-message[role="alert"]')).toBeNull();
    expect(mocks.download.mock.calls[1]?.[1]).toBe(content);
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });

  it('does not let a late old-generation export failure replace current feedback', async () => {
    const failures: Array<(error: unknown) => void> = [];
    const createReportPorts: NonNullable<DesktopRoomGenerationResultProps['createReportPorts']> = onError => {
      failures.push(onError); return {};
    };
    await render(generation, { createReportPorts });
    const oldFailure = failures.at(-1)!;
    await act(async () => oldFailure(new Error('上场失败')));
    expect(container.textContent).toContain('上场失败');
    await render(generation, { createReportPorts, generationKey: 'room:epoch:generation-2' });
    expect(container.textContent).not.toContain('上场失败');
    await act(async () => failures.at(-1)!(new Error('当前失败')));
    await act(async () => oldFailure(new Error('上场迟到失败')));
    expect(container.querySelector('.error-message')?.textContent).toBe('当前失败');
  });

  it('keeps an in-flight image failure visible when the same room generation becomes unknown', async () => {
    let rejectCapture!: (error: unknown) => void;
    mocks.capture.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCapture = reject; }));
    const createReportPorts: NonNullable<DesktopRoomGenerationResultProps['createReportPorts']> = onError => createDesktopBattleReportPorts({
      onError, onNavigateExternal: vi.fn(), onExportingChange: vi.fn(),
    });
    await render({ ...generation, phase: 'completed', finalAuthoritative: true }, { createReportPorts });
    await click('📱 保存为图片');
    await render({ ...generation, phase: 'unknown' }, { createReportPorts });
    await act(async () => rejectCapture(new Error('旧显示状态导出失败')));
    expect(container.querySelector('.error-message[role="alert"]')?.textContent).toContain('生成图片失败');
    expect(container.querySelector('.result-card')).toBeNull();
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });

  it('keeps completion and read recovery distinct, and retries only on an explicit allowed click', async () => {
    const state = { ...generation, phase: 'completed' as const, recoveryCode: 'ROOM_GENERATION_RECOVERY_PROTOCOL', generationRecordId: 'record-1' };
    await render(state);
    expect(container.textContent).toContain('生成已完成');
    expect(container.textContent).not.toContain('战报已完成');
    expect(container.textContent).not.toContain('最终内容已从生成记录恢复并核验');
    expect(retry).not.toHaveBeenCalled(); await click('重新同步战报'); expect(retry).toHaveBeenCalledOnce();
    await render(state, { retryDisabled: true }); expect(button('重新同步战报')).toBeUndefined();
    await render({ ...state, finalAuthoritative: true, recoveryCode: null });
    expect(container.textContent).toContain('战报已完成');
    expect(container.textContent).toContain('最终内容已从生成记录恢复并核验');
    expect(container.textContent).not.toContain('当前显示实时预览');
    expect(retry).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
  });

  it('renders stream-web only as escaped source and never opens an executable surface', async () => {
    const source = '<!doctype html><html><body><script>window.__roomExecuted = true</script><img src="https://example.com/remote.png"></body></html>';
    await render({ ...generation, phase: 'completed', markdown: source, finalAuthoritative: true, generationRecordId: 'record-1', result: { version: 1, format: 'stream-web', mode: 'daily',
      ai: { model: 'room-web-model', usage: { promptTokens: 12, reasoningTokens: 3, completionTokens: 8 } } } });
    expect(container.querySelector('[aria-label="Web 战报源码（安全文本）"]')?.textContent).toContain(source);
    expect(button('普通显示')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('.result-card')).toHaveLength(1);
    expect(container.querySelector('.result-card')?.textContent).toContain('模型：room-web-model');
    expect(container.querySelector('.result-card')?.textContent).toContain('tokens：输入 12｜推理 3｜输出 5');
    expect(container.querySelector('.result-card img[src="/daily-mode.svg"]')).not.toBeNull();
    expect(container.querySelector('iframe, script, webview, img[src^="https:"]')).toBeNull();
    expect(button('运行 Web 战报')?.disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await click('导出安全源码文本');
    expect(mocks.download).toHaveBeenCalledWith('房间战报源码.txt', source, 'text/plain;charset=utf-8');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps missing usage explicit in a recovered Web report', async () => {
    await render({ ...generation, phase: 'completed', markdown: '<html><body>恢复源码</body></html>', finalAuthoritative: true,
      generationRecordId: 'record-recovered', result: { version: 1, format: 'stream-web', mode: 'daily', ai: { model: 'recovered-model' } } });
    const report = container.querySelector('.result-card');
    expect(report?.textContent).toContain('模型：recovered-model');
    expect(report?.textContent).toContain('tokens：输入 未提供｜推理 未提供｜输出 未提供');
    expect(report?.querySelector('img[src="/daily-mode.svg"]')).not.toBeNull();
    expect(container.textContent).toContain('最终内容已从生成记录恢复并核验');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses the existing long-report display budget and exports the full original body', async () => {
    const body = '# 超长报告\n' + '正文'.repeat(BATTLE_STORY_CONTENT_PREVIEW_CHARACTERS / 2) + '\n完整尾部';
    const state = { ...generation, markdown: body, result: null };
    await render(state);
    const guard = container.querySelector('[data-story-content-preview]');
    expect(guard).not.toBeNull(); expect(guard!.querySelector('.result-card')).toBeNull();
    expect(container.textContent).not.toContain('完整尾部');
    await click('导出当前完整正文');
    expect(mocks.download).toHaveBeenCalledWith('房间战报完整正文.md', body, 'text/markdown;charset=utf-8');
    await click('展开全文'); expect(container.textContent).toContain('完整尾部');
    await render(state, { generationKey: 'room:epoch:generation-2' });
    expect(container.querySelector('[data-story-content-preview] .result-card')).toBeNull();
    expect(invoke).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });
});
