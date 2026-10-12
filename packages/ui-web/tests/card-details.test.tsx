// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasicCardDetailsModal, CardDetailsBody } from '../src/card-details';
import { BaseModal } from '../src/modal';
const card = { id: 'same', name: '通用详情', description: '原简介', type: 'history' as const, data: '{"content":"正文"}', isPublic: false, author: '本机作者', createdAt: '2026-01-01T01:02:00Z', updatedAt: '2026-02-01T01:02:00Z' };
const markdown = (content: string) => <p>{content}</p>;
let root: Root; let container: HTMLDivElement;
const renderHtml = (node: ReactNode) => { act(() => root.render(node)); return container.innerHTML; };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
describe('共源基础详情', () => {
  it.each(['character', 'scenario', 'history', 'questionnaire'] as const)('保留 %s 通用正文、作者日期和显式来源，无宿主动作不造按钮', async (type) => {
    await act(async () => root.render(<BasicCardDetailsModal isOpen onClose={() => {}} card={{ ...card, type }} source={{ kind: 'cache', lastSuccessAt: '2026-03-01T00:00:00Z' }} renderMarkdown={markdown} />));
    expect(container.textContent).toContain('本机作者'); expect(container.textContent).toContain('缓存快照'); expect(container.textContent).toContain('正文'); expect(container.querySelector('[title="2026-01-01T01:02:00Z"]')).not.toBeNull(); expect(container.textContent).not.toContain('下载 JSON'); expect(container.textContent).not.toContain('存到本地库');
  });
  it.each(['oops', 'null', '12', '"text"'])('无效正文 %s 明确报错', (data) => {
    const html = renderHtml(<CardDetailsBody data={data} renderMarkdown={markdown} />);
    expect(html).toContain('role="alert"'); expect(html).not.toContain('暂无详细设定');
  });
  it('隐藏递归内部字段，原型名称不崩溃/不泄露函数，深度有界', () => {
    const html = renderHtml(<CardDetailsBody data='{"name":"可见","nested":{"metadata":"秘密A","userAnswers":"秘密B","_hidden":"秘密C","__proto__":"秘密D","constructor":"秘密E","hasOwnProperty":"正常扩展"}}' renderMarkdown={markdown} />);
    expect(html).toContain('正常扩展'); expect(html).not.toContain('秘密'); expect(html).not.toContain('native code');
    let data: unknown = '终点'; for (let i = 0; i < 100; i++) data = { nested: data };
    expect(renderHtml(<CardDetailsBody data={JSON.stringify(data)} renderMarkdown={markdown} />)).toContain('内容过深');
    expect(renderHtml(<CardDetailsBody data={JSON.stringify(Array.from({ length: 1001 }, () => 'x'))} renderMarkdown={markdown} />)).not.toContain('截断');
    expect(renderHtml(<CardDetailsBody data={JSON.stringify(Array.from({ length: 3000 }, () => 'x'))} renderMarkdown={markdown} />)).toContain('截断');
  });
  it('嵌套详情只消费自己的 Escape', async () => {
    const parent = vi.fn(); const child = vi.fn(); let open = false;
    const render = () => root.render(<BaseModal isOpen title="父层" onClose={parent}><button id="trigger">打开详情</button>{open && <BasicCardDetailsModal isOpen card={card} source={{ kind: 'local' }} onClose={() => { child(); open = false; render(); }} renderMarkdown={markdown} />}</BaseModal>);
    await act(async () => render());
    document.querySelector<HTMLButtonElement>('#trigger')!.focus();
    open = true; await act(async () => render());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭历史详情');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(child).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('trigger');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(parent).toHaveBeenCalledOnce();
  });
});
