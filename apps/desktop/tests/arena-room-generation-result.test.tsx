// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATTLE_STORY_CONTENT_PREVIEW_CHARACTERS } from '@mahoshojo/ui-web/arena-story-session';
import { DesktopRoomGenerationResult, type DesktopRoomGenerationResultProps } from '../src/features/arena/room-generation-result';
import { ExternalLinksProvider } from '../src/features/external-links/external-links-provider';

const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download }));
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
      reportPorts: { saveImage, downloadMarkdown, generatedBy: <span>本机用户署名</span> },
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
    await render({ ...generation, phase: 'completed', markdown: source, finalAuthoritative: true, generationRecordId: 'record-1', result: { version: 1, format: 'stream-web', mode: 'daily' } });
    expect(container.querySelector('[data-testid="arena-web-result"] pre')?.textContent).toBe(source);
    expect(container.querySelector('iframe, script, webview, img[src^="https:"]')).toBeNull();
    expect(button('运行 Web 战报')?.disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await click('导出安全源码文本');
    expect(mocks.download).toHaveBeenCalledWith('房间战报源码.txt', source, 'text/plain;charset=utf-8');
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
