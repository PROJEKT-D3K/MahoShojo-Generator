// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/public-ranking.json';
import { EntityRatingHistorySchema } from '@mahoshojo/contracts/public-ranking';
import { BasicCardDetailsModal } from '../src/card-details';
import { EntityRatingHistoryButton, type PublicRankingReader } from '../src/ranking';
const data = EntityRatingHistorySchema.parse(fixture.responses.ratingHistory);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const read = vi.fn();
let root: Root; let container: HTMLDivElement;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)!;
const click = (text: string) => act(async () => button(text).click());
const escape = () => act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const render = (id = 'public-card') => act(async () => root.render(<EntityRatingHistoryButton entityType="data_card" entityId={id} readRanking={read as PublicRankingReader} />));
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; read.mockReset(); read.mockResolvedValue(data); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('shared recent strict history lifecycle', () => {
  it('loads on click only, presents public facts, and never renders internal IDs', async () => {
    await render(); expect(read).not.toHaveBeenCalled(); await click('最近严格排位');
    expect(read).toHaveBeenCalledWith({ kind: 'ratingHistory', entityType: 'data_card', entityId: 'public-card' }, expect.any(AbortSignal));
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const text of ['历史对手甲', '历史对手乙', '未知角色', '未知用户', '公开用户名', '+18', '-14', '赛后 -10', '不按当前所选赛季筛选']) expect(dialog.textContent).toContain(text);
    for (const secret of ['public-card', 'generation-a', 'legacy-opponent.json', 'DROP']) expect(dialog.textContent).not.toContain(secret);
  });
  it('distinguishes error from empty and retries without keeping the previous list', async () => {
    read.mockRejectedValueOnce(new Error('HTTP 429')); await render(); await click('最近严格排位');
    expect(document.body.textContent).toContain('无法加载最近严格排位记录'); expect(document.body.textContent).not.toContain('暂无严格排位记录');
    const pending = deferred<typeof data>(); read.mockReturnValueOnce(pending.promise); await click('重试'); expect(document.body.textContent).toContain('正在加载');
    await act(async () => pending.resolve({ ...data, items: [] })); expect(document.body.textContent).toContain('暂无严格排位记录');
  });
  it('two retry callbacks supersede in-flight reads and ignore out-of-order completion', async () => {
    read.mockRejectedValueOnce(new Error('初始失败')); await render(); await click('最近严格排位');
    const old = deferred<typeof data>(); const current = deferred<typeof data>(); read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const retry = button('重试'); await act(async () => { retry.click(); retry.click(); });
    expect(read).toHaveBeenCalledTimes(3); expect((read.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
    await act(async () => current.resolve(data));
    await act(async () => old.resolve({ ...data, items: [] }));
    expect(document.body.textContent).toContain('历史对手甲'); expect(document.body.textContent).not.toContain('暂无严格排位记录');
  });
  it.each(['resolve', 'reject'] as const)('close and rapid reopen ignore old %s even if transport ignores abort', async (outcome) => {
    const old = deferred<typeof data>(); read.mockReturnValueOnce(old.promise); await render(); await click('最近严格排位');
    const signal = read.mock.calls[0]![1] as AbortSignal; await escape(); expect(signal.aborted).toBe(true);
    await click('最近严格排位'); expect(read).toHaveBeenCalledTimes(2);
    await act(async () => outcome === 'resolve' ? old.resolve({ ...data, items: [{ ...data.items[0]!, opponent: { ...data.items[0]!.opponent, displayName: '旧响应' } }] }) : old.reject(new Error('旧错误')));
    expect(document.body.textContent).toContain('历史对手甲'); expect(document.body.textContent).not.toContain('旧响应'); expect(document.body.textContent).not.toContain('旧错误');
  });
  it('changing target destroys the old list and requires another explicit click; unmount ignores pending results', async () => {
    const old = deferred<typeof data>(); read.mockReturnValueOnce(old.promise); await render('A'); await click('最近严格排位');
    await render('B'); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    await act(async () => old.resolve(data)); expect(document.body.textContent).not.toContain('历史对手甲');
    const next = deferred<typeof data>(); read.mockReturnValueOnce(next.promise); await click('最近严格排位'); expect(read.mock.lastCall?.[0].entityId).toBe('B');
    await act(async () => root.render(null)); await act(async () => next.resolve(data)); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
  });
  it('nested dialogs share scroll/Escape/focus and obscure the parent until the history closes', async () => {
    const oldOverflow = document.body.style.overflow;
    function Details() {
      const [open, setOpen] = useState(true); const [obscured, setObscured] = useState(false);
      return open ? <BasicCardDetailsModal isOpen onClose={() => setOpen(false)} card={{ id: 'a', name: '详情', description: '', data: '{}', type: 'character', isPublic: false }} source={{ kind: 'preset' }} renderMarkdown={(text) => text} obscured={obscured}
        metadata={<EntityRatingHistoryButton entityType="preset" entityId="preset.json" readRanking={read as PublicRankingReader} onOpenChange={setObscured} />} /> : null;
    }
    await act(async () => root.render(<Details />)); const parent = document.querySelector('[role="dialog"]')!;
    const opener = button('最近严格排位'); opener.focus(); await click('最近严格排位');
    expect(parent.getAttribute('aria-hidden')).toBe('true'); expect(parent.hasAttribute('aria-modal')).toBe(false); expect(document.body.style.overflow).toBe('hidden');
    const top = document.querySelectorAll('[role="dialog"]')[1]!; expect(top.contains(document.activeElement)).toBe(true);
    await act(async () => { const region = top.querySelector<HTMLElement>('[role="region"]')!; region.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(top.contains(document.activeElement)).toBe(true);
    await escape(); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1); expect(parent.hasAttribute('aria-hidden')).toBe(false); expect(document.activeElement).toBe(opener); expect(document.body.style.overflow).toBe('hidden');
    await escape(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.style.overflow).toBe(oldOverflow);
  });
});
