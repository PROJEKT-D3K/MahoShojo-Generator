// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NarrativeDraftsPanel, type NarrativeDraftsPanelProps } from '../src/narrative-history';
import { MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS, type NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const draft: NarrativeDraft = { requestId: 'request-one', title: '尚未结束', createdAt: '2026-10-14T00:00:00Z', source: 'hosted', markdown: '<script>unsafe()</script>正文', completion: { kind: 'unconfirmed' } };
const second: NarrativeDraft = { ...draft, requestId: 'request-two', title: '另一个故事', markdown: '第二份正文' };
const third: NarrativeDraft = { ...draft, requestId: 'request-three', title: '后来新增', markdown: '第三份正文' };
const roots: Root[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const mount = async (props: Partial<NarrativeDraftsPanelProps> = {}) => {
  const container = document.createElement('div'), root = createRoot(container);
  roots.push(root);
  let current: NarrativeDraftsPanelProps = { drafts: [draft], status: 'stored', onExport: vi.fn(), ...props };
  const render = async (next: Partial<NarrativeDraftsPanelProps>) => {
    current = { ...current, ...next };
    await act(async () => root.render(<NarrativeDraftsPanel {...current} />));
  };
  await render({});
  const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!;
  const select = (title: string) => container.querySelector<HTMLInputElement>(`input[aria-label="选择草稿：${title}"]`)!;
  const click = async (text: string) => { await act(async () => button(text).click()); };
  return { container, root, render, button, select, click };
};
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

describe('unfinished narrative drafts management', () => {
  it('keeps conflicting candidates separately exportable and names both versions in deletion confirmation', async () => {
    const onExport = vi.fn(), onDelete = vi.fn(() => ({ ok: true as const })), confirmAction = vi.fn((_message: string) => false);
    const candidate = { ...draft, markdown: '当前安全候选' };
    const panel = await mount({ candidate, status: 'memory-only', onExport, onDelete, confirmAction });
    await panel.click('导出当前未保存草稿');
    expect(onExport).toHaveBeenLastCalledWith([candidate]);
    await panel.click('导出未完成草稿');
    expect(onExport).toHaveBeenLastCalledWith([draft]);
    expect(panel.container.querySelectorAll('details')).toHaveLength(2);
    await panel.click('删除草稿及冲突版本');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('全部已保存及未落盘版本都会删除');
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain(draft.markdown);
    expect(panel.container.textContent).toContain(candidate.markdown);
  });

  it('retains explicit saving, inert text, host rendering and collapsed neutral cards', async () => {
    const onSave = vi.fn(), onExport = vi.fn();
    const panel = await mount({ drafts: [], candidate: draft, status: 'memory-only', onSave, onExport });
    expect(panel.container.querySelector('script')).toBeNull();
    expect(panel.container.querySelector('textarea,input')).toBeNull();
    expect(panel.container.querySelector('section')?.className).not.toContain('amber');
    expect(panel.container.querySelector('details')?.open).toBe(false);
    expect(panel.container.textContent).toContain('仅保留在内存');
    expect(panel.container.textContent).toContain('完成状态未确认');
    expect(panel.container.textContent).toContain('正式历史为 0 条也可清空草稿');
    await panel.click('保存未完成草稿'); await panel.click('导出未完成草稿');
    expect(onSave).toHaveBeenCalledOnce(); expect(onExport).toHaveBeenCalledWith([draft]);
    await panel.render({ drafts: [draft], status: 'stored', renderMarkdown: markdown => <span data-markdown>{markdown}</span> });
    expect(panel.container.querySelectorAll('details')).toHaveLength(1);
    expect(panel.container.querySelector('[data-markdown]')?.textContent).toBe(draft.markdown);
    expect(panel.container.textContent).toContain('草稿已保存到本机');
    expect(panel.container.textContent).not.toContain('保存未完成草稿');
  });

  it('does not expose destructive actions without a host confirmation port', async () => {
    const panel = await mount({ onDelete: vi.fn(() => ({ ok: true })) });
    expect(panel.container.textContent).not.toContain('删除此草稿');
    expect(panel.container.textContent).not.toContain('清空当前草稿');
  });

  it('requires confirmation for single deletion and allows cancellation without a write', async () => {
    const confirmAction = vi.fn((_message: string) => false), onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ confirmAction, onDelete });
    await panel.click('删除此草稿');
    expect(confirmAction).toHaveBeenCalledOnce();
    expect(confirmAction.mock.calls[0]?.[0]).toContain('删除后无法恢复');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('不会清除正式历史');
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.button('删除此草稿').disabled).toBe(false);
    expect(panel.container.textContent).not.toContain('草稿已删除');
  });

  it('deletes only the selected IDs after confirmation', async () => {
    const confirmAction = vi.fn(() => true), onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [draft, second, third], confirmAction, onDelete });
    await act(async () => { panel.select(draft.title).click(); panel.select(third.title).click(); });
    await panel.click('删除所选（2）');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([draft.requestId, third.requestId]);
    expect(panel.select(draft.title).checked).toBe(false);
    expect(panel.container.textContent).toContain('草稿已删除');
    // Rendering remains controlled by the host rather than optimistic row removal.
    expect(panel.container.querySelectorAll('details')).toHaveLength(3);
  });

  it('includes an unsaved visible candidate in a clear and does not need formal history entries', async () => {
    const onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [], candidate: second, status: 'available', onDelete, confirmAction: () => true });
    await panel.click('清空当前草稿');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([second.requestId]);
  });

  it('can delete an unchanged memory-only candidate that exceeds the serialized archive budget', async () => {
    const candidate = { ...draft, markdown: '文'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) }, onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [], candidate, status: 'memory-only', onDelete, confirmAction: () => true, renderMarkdown: () => '长篇正文' });
    await panel.click('删除此草稿');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([draft.requestId]);
    expect(panel.container.textContent).toContain('草稿已删除');
    expect(panel.container.textContent).not.toContain('待删除草稿已变化');
  });

  it('can clear an unchanged visible collection over the archive budget', async () => {
    const markdown = '文'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS / 2 + 1);
    const drafts = [{ ...draft, markdown }, { ...second, markdown }], onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts, onDelete, confirmAction: () => true, renderMarkdown: () => '长篇正文' });
    await panel.click('清空当前草稿');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([draft.requestId, second.requestId]);
    expect(panel.container.textContent).toContain('草稿已删除');
  });

  it('freezes the visible clear snapshot and blocks repeated clicks while confirmation or deletion is pending', async () => {
    const confirmation = deferred<boolean>(), deletion = deferred<{ ok: true }>();
    const confirmAction = vi.fn(() => confirmation.promise), onDelete = vi.fn(() => deletion.promise);
    const panel = await mount({ drafts: [draft, second], confirmAction, onDelete });
    await act(async () => { panel.button('清空当前草稿').click(); panel.button('清空当前草稿').click(); });
    expect(confirmAction).toHaveBeenCalledOnce(); expect(onDelete).not.toHaveBeenCalled();
    await panel.render({ drafts: [draft, second, third] });
    await act(async () => confirmation.resolve(true));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([draft.requestId, second.requestId]);
    expect(panel.button('清空当前草稿').disabled).toBe(true);
    await panel.click('清空当前草稿');
    expect(confirmAction).toHaveBeenCalledOnce();
    await act(async () => deletion.resolve({ ok: true }));
    expect(panel.button('清空当前草稿').disabled).toBe(false);
  });

  it('cancels a stale confirmation after a scope change, including returning to the original key', async () => {
    const confirmation = deferred<boolean>(), onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ scopeKey: 'account-a', confirmAction: () => confirmation.promise, onDelete });
    await act(async () => panel.select(draft.title).click());
    await panel.click('清空当前草稿');
    await panel.render({ scopeKey: 'account-b', drafts: [second] });
    await panel.render({ scopeKey: 'account-a' });
    await act(async () => confirmation.resolve(true));
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.button('删除所选（0）').disabled).toBe(true);
    expect(panel.button('清空当前草稿').disabled).toBe(false);
    expect(panel.container.textContent).not.toContain('草稿已删除');
  });

  it('ignores old write feedback after switching scope and keeps the new scope usable', async () => {
    const deletion = deferred<{ ok: false; error: string }>();
    const panel = await mount({ scopeKey: 'a', confirmAction: () => true, onDelete: () => deletion.promise });
    await panel.click('删除此草稿');
    await panel.render({ scopeKey: 'b', drafts: [second] });
    await act(async () => deletion.resolve({ ok: false, error: '旧账号失败' }));
    expect(panel.container.textContent).not.toContain('旧账号失败');
    expect(panel.button('清空当前草稿').disabled).toBe(false);
  });

  it('cancels deletion when the selected version changes during confirmation', async () => {
    const confirmation = deferred<boolean>(), onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ confirmAction: () => confirmation.promise, onDelete });
    await panel.click('删除此草稿');
    await panel.render({ candidate: { ...draft, markdown: '新出现的冲突正文' } });
    await act(async () => confirmation.resolve(true));
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain('待删除草稿已变化');
  });

  it('shows host failure, catches thrown failures and lets the user retry', async () => {
    const onDelete = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: '本机写入失败，请重试' })
      .mockRejectedValueOnce(new Error('private storage details'))
      .mockResolvedValueOnce({ ok: true });
    const panel = await mount({ confirmAction: () => true, onDelete });
    await panel.click('删除此草稿');
    expect(panel.container.textContent).toContain('本机写入失败，请重试');
    expect(panel.container.textContent).not.toContain('草稿已删除');
    expect(panel.container.querySelectorAll('details')).toHaveLength(1);
    await panel.click('删除此草稿');
    expect(panel.container.textContent).toContain('删除失败，请重试');
    expect(panel.container.textContent).not.toContain('private storage details');
    await panel.click('删除此草稿');
    expect(panel.container.textContent).toContain('草稿已删除');
    expect(onDelete).toHaveBeenCalledTimes(3);
  });

  it('handles confirmation failure without a write and permits retry', async () => {
    const onDelete = vi.fn(() => ({ ok: true }));
    const confirmAction = vi.fn().mockRejectedValueOnce(new Error('dialog failed')).mockResolvedValueOnce(true);
    const panel = await mount({ onDelete, confirmAction });
    await panel.click('删除此草稿');
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain('删除失败，请重试');
    await panel.click('删除此草稿');
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('copies exactly one body through the host, blocks duplicate copy and reports clipboard failure', async () => {
    const copying = deferred<void>(), onCopy = vi.fn().mockReturnValueOnce(copying.promise).mockRejectedValueOnce(new Error('denied'));
    const panel = await mount({ onCopy });
    await act(async () => { panel.button('复制正文').click(); panel.button('复制正文').click(); });
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(draft.markdown);
    expect(panel.container.textContent).not.toContain('草稿正文已复制');
    await act(async () => copying.resolve());
    expect(panel.container.textContent).toContain('草稿正文已复制');
    await panel.click('复制正文');
    expect(panel.container.textContent).toContain('复制失败，请重试或导出草稿');
    expect(panel.button('复制正文').disabled).toBe(false);
  });

  it('discards a delayed copy result on a scope switch', async () => {
    const copying = deferred<void>();
    const panel = await mount({ scopeKey: 'a', onCopy: () => copying.promise });
    await panel.click('复制正文');
    await panel.render({ scopeKey: 'b' });
    await act(async () => copying.resolve());
    expect(panel.container.textContent).not.toContain('草稿正文已复制');
    expect(panel.button('复制正文').disabled).toBe(false);
  });

  it('copies conflicting current and archived bodies separately', async () => {
    const candidate = { ...draft, markdown: '保留的当前版本' }, onCopy = vi.fn();
    const panel = await mount({ candidate, status: 'memory-only', onCopy });
    const buttons = [...panel.container.querySelectorAll('button')].filter(button => button.textContent === '复制正文');
    await act(async () => buttons[0]!.click());
    expect(onCopy).toHaveBeenLastCalledWith(candidate.markdown);
    await act(async () => buttons[1]!.click());
    expect(onCopy).toHaveBeenLastCalledWith(draft.markdown);
  });

  it('uses the local Intl date formatter while preserving the original timestamp in title', async () => {
    const format = vi.fn(() => '本地日期 10/14 08:00');
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { return { format } as unknown as Intl.DateTimeFormat; });
    const panel = await mount();
    expect(formatter).toHaveBeenCalledWith(undefined, { dateStyle: 'short', timeStyle: 'short' });
    expect(format).toHaveBeenCalledWith(new Date(draft.createdAt));
    expect(panel.container.querySelector('time')?.textContent).toBe('本地日期 10/14 08:00');
    expect(panel.container.querySelector('time')?.title).toBe(draft.createdAt);
    expect(panel.container.querySelector('time')?.dateTime).toBe(draft.createdAt);
  });

  it('keeps the legacy entry separate from an empty current scope and allows the independent retention preference', async () => {
    const onAutoRetainChange = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [], onAutoRetainChange, renderLegacyAction: () => <button>查看旧设备草稿</button> });
    expect(panel.container.textContent).toContain('未完成叙事草稿 · 0 条');
    expect(panel.container.textContent).toContain('查看旧设备草稿');
    expect(panel.container.textContent).toContain('暂无未完成叙事草稿');
    expect(panel.container.textContent).toContain('与“战报后写入正式历史”独立');
    const input = panel.container.querySelector<HTMLInputElement>('input')!;
    expect(input.checked).toBe(false);
    await act(async () => input.click());
    expect(onAutoRetainChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(input.checked).toBe(false);
    await panel.render({ autoRetain: true });
    expect(input.checked).toBe(true);
  });

  it('does not change a retention preference on failure and ignores old preference feedback after a scope change', async () => {
    const saving = deferred<{ ok: true }>();
    const onAutoRetainChange = vi.fn().mockResolvedValueOnce({ ok: false }).mockReturnValueOnce(saving.promise);
    const panel = await mount({ drafts: [], scopeKey: 'a', onAutoRetainChange });
    await act(async () => panel.container.querySelector<HTMLInputElement>('input')!.click());
    expect(panel.container.textContent).toContain('设置保存失败，请重试');
    expect(panel.container.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    await act(async () => panel.container.querySelector<HTMLInputElement>('input')!.click());
    expect(panel.container.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
    await panel.render({ scopeKey: 'b' });
    await act(async () => saving.resolve({ ok: true }));
    expect(panel.container.textContent).not.toContain('已开启自动保留');
    expect(panel.container.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
  });

  it('explains suspicious content without removing its manual save or export actions', async () => {
    const candidate: NarrativeDraft = { ...draft, source: 'direct-local', markdown: 'Sorry, I cannot assist with that request.', completion: { kind: 'trusted-length' } };
    const panel = await mount({ drafts: [], candidate, status: 'available', onSave: vi.fn() });
    expect(panel.container.textContent).toContain('内容可能是错误或拒绝回复');
    expect(panel.button('保存未完成草稿')).toBeDefined();
    expect(panel.button('导出此草稿')).toBeDefined();
  });

  it('keeps an older unsaved draft warning after the candidate clears or a newer draft is stored', async () => {
    const onRetryUnsaved = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [draft], candidate: null, status: 'idle', unsavedRequestIds: [draft.requestId], onRetryUnsaved });
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机，离开前请重试或导出');
    expect(panel.container.querySelector('summary')?.textContent).toContain('未保存到本机');
    await panel.render({ drafts: [draft, second], candidate: second, status: 'stored' });
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
    expect(panel.container.textContent).not.toContain('草稿已保存到本机');
    expect(panel.button('重试保存未落盘草稿')).toBeDefined();
    await panel.render({ candidate: null });
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
  });

  it('does not hide unsaved warnings on retry failure or before the host confirms durable state', async () => {
    const retry = deferred<{ ok: false; error: string }>();
    const onRetryUnsaved = vi.fn().mockReturnValueOnce(retry.promise).mockRejectedValueOnce(new Error('storage details')).mockResolvedValueOnce({ ok: true });
    const panel = await mount({ candidate: null, status: 'stored', unsavedRequestIds: [draft.requestId], onRetryUnsaved });
    const label = '重试保存未落盘草稿';
    await act(async () => { panel.button(label).click(); panel.button(label).click(); });
    expect(onRetryUnsaved).toHaveBeenCalledOnce();
    expect(panel.button(label).disabled).toBe(true);
    await act(async () => retry.resolve({ ok: false, error: '写入失败，草稿仍在内存' }));
    expect(panel.container.textContent).toContain('写入失败，草稿仍在内存');
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
    await panel.click(label);
    expect(panel.container.textContent).toContain('草稿保存失败，请重试或导出');
    expect(panel.container.textContent).not.toContain('storage details');
    await panel.click(label);
    expect(panel.container.textContent).toContain('已重试保存未落盘草稿');
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
    expect(panel.container.textContent).not.toContain('草稿已保存到本机');
    await panel.render({ unsavedRequestIds: [] });
    expect(panel.container.textContent).not.toContain('尚未保存到本机');
    expect(panel.container.textContent).toContain('草稿已保存到本机');
    expect(panel.button(label)).toBeUndefined();
  });

  it('ignores a previous scope retry result and preserves conflicting unsaved export access', async () => {
    const retry = deferred<{ ok: true }>(), onExport = vi.fn();
    const candidate = { ...draft, markdown: '内存中的冲突版本' };
    const panel = await mount({ scopeKey: 'a', candidate, status: 'stored', unsavedRequestIds: [draft.requestId], onRetryUnsaved: () => retry.promise, onExport });
    expect(panel.container.textContent).toContain('含未落盘版本');
    expect(panel.container.textContent).not.toContain('草稿已保存到本机');
    await panel.click('导出当前未保存草稿');
    expect(onExport).toHaveBeenCalledExactlyOnceWith([candidate]);
    await panel.click('重试保存未落盘草稿');
    await panel.render({ scopeKey: 'b', candidate: null, drafts: [], unsavedRequestIds: [], status: 'idle' });
    await act(async () => retry.resolve({ ok: true }));
    expect(panel.container.textContent).not.toContain('已重试保存未落盘草稿');
    expect(panel.container.textContent).not.toContain('含未落盘版本');
  });

  it('preserves a conflicting unsaved original after the candidate clears without corrupting the bulk export', async () => {
    const unsaved = { ...draft, markdown: '之前保存失败的原文' }, onExport = vi.fn(), onCopy = vi.fn();
    const confirmAction = vi.fn((_message: string) => true), onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ candidate: null, status: 'stored', unsavedDrafts: [unsaved], onExport, onCopy, onDelete, confirmAction });
    expect(panel.container.textContent).toContain('尚未结束 · 未落盘版本');
    expect(panel.container.textContent).toContain('此版本仅保留在内存');
    expect(panel.container.textContent).not.toContain('草稿已保存到本机');
    await panel.click('导出未落盘版本');
    expect(onExport).toHaveBeenLastCalledWith([unsaved]);
    await panel.click('导出未完成草稿');
    expect(onExport).toHaveBeenLastCalledWith([draft]);
    await panel.click('复制正文');
    expect(onCopy).toHaveBeenLastCalledWith(unsaved.markdown);
    await panel.click('删除草稿及冲突版本');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('全部已保存及未落盘版本都会删除');
    expect(confirmAction.mock.calls[0]?.[0]).not.toContain('归档');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([draft.requestId]);
  });

  it('does not duplicate unsaved versions already shown as the normal list or conflicting candidate', async () => {
    const candidate = { ...draft, markdown: '当前冲突版本' };
    const panel = await mount({ candidate, status: 'memory-only', unsavedDrafts: [draft, candidate, candidate] });
    expect(panel.container.querySelectorAll('details')).toHaveLength(2);
    expect(panel.button('导出未落盘版本')).toBeUndefined();
    expect(panel.button('导出当前未保存草稿')).toBeDefined();
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
  });

  it('cancels a pending deletion when an additional unsaved version changes', async () => {
    const confirmation = deferred<boolean>(), onDelete = vi.fn(() => ({ ok: true }));
    const unsaved = { ...draft, markdown: '第一份未落盘原文' };
    const panel = await mount({ unsavedDrafts: [unsaved], onDelete, confirmAction: () => confirmation.promise });
    await panel.click('删除草稿及冲突版本');
    await panel.render({ unsavedDrafts: [{ ...unsaved, markdown: '随后变更的原文' }] });
    await act(async () => confirmation.resolve(true));
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain('待删除草稿已变化');
  });

  it('keeps standalone unsaved versions accessible and included in the clear snapshot', async () => {
    const onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [], candidate: null, status: 'idle', unsavedDrafts: [second], onDelete, confirmAction: () => true });
    expect(panel.container.textContent).toContain('未完成叙事草稿 · 1 条');
    expect(panel.button('导出未落盘版本')).toBeDefined();
    await panel.click('清空当前草稿');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([second.requestId]);
  });

  it('keeps refreshed persisted conflicts individually exportable, copyable and deletable without an ordinary draft or candidate', async () => {
    const conflicting = { ...draft, markdown: '另一份已保存内容' }, onExport = vi.fn(), onCopy = vi.fn();
    const onDelete = vi.fn(() => ({ ok: true })), onRetryUnsaved = vi.fn(() => ({ ok: true })), confirmAction = vi.fn((_message: string) => true);
    const panel = await mount({ drafts: [], candidate: null, conflictingDrafts: [draft, conflicting], status: 'memory-only', onExport, onCopy, onDelete, confirmAction, onRetryUnsaved });
    expect(panel.container.textContent).toContain('未完成叙事草稿 · 1 条');
    expect(panel.container.querySelectorAll('details')).toHaveLength(2);
    expect(panel.container.textContent).toContain('同编号的已保存冲突版本，请分别导出核对');
    expect(panel.container.textContent).not.toContain('尚未保存到本机');
    expect(panel.container.textContent).not.toContain('仅保留在内存');
    expect(panel.button('重试保存未落盘草稿')).toBeUndefined();
    expect(panel.button('导出未完成草稿')).toBeUndefined();
    const exportButtons = [...panel.container.querySelectorAll('button')].filter(button => button.textContent === '导出此冲突版本');
    await act(async () => exportButtons[0]!.click());
    expect(onExport).toHaveBeenLastCalledWith([draft]);
    await act(async () => exportButtons[1]!.click());
    expect(onExport).toHaveBeenLastCalledWith([conflicting]);
    const copyButtons = [...panel.container.querySelectorAll('button')].filter(button => button.textContent === '复制正文');
    await act(async () => copyButtons[0]!.click());
    expect(onCopy).toHaveBeenLastCalledWith(draft.markdown);
    await act(async () => copyButtons[1]!.click());
    expect(onCopy).toHaveBeenLastCalledWith(conflicting.markdown);
    await panel.click('删除草稿及冲突版本');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('全部已保存及未落盘版本都会删除');
    expect(onDelete).toHaveBeenLastCalledWith([draft.requestId]);
    await panel.click('清空当前草稿');
    expect(onDelete).toHaveBeenLastCalledWith([draft.requestId]);
    expect(onRetryUnsaved).not.toHaveBeenCalled();
  });

  it('selects a persisted conflict by ID and includes all conflict IDs in select-all and clear', async () => {
    const conflicting = { ...draft, markdown: '另一份已保存内容' }, anotherConflict = { ...second, markdown: '第二编号另一份内容' };
    const onDelete = vi.fn(() => ({ ok: true }));
    const panel = await mount({ drafts: [], candidate: null, conflictingDrafts: [draft, conflicting, second, anotherConflict], onDelete, confirmAction: () => true });
    const checkboxes = [...panel.container.querySelectorAll<HTMLInputElement>('input[aria-label^="选择已保存冲突草稿"]')];
    await act(async () => checkboxes[1]!.click());
    expect(checkboxes[0]!.checked).toBe(true);
    expect(checkboxes[1]!.checked).toBe(true);
    await panel.click('删除所选（1）');
    expect(onDelete).toHaveBeenLastCalledWith([draft.requestId]);
    await act(async () => panel.container.querySelector<HTMLInputElement>('input:not([aria-label])')!.click());
    await panel.click('删除所选（2）');
    expect(onDelete).toHaveBeenLastCalledWith([draft.requestId, second.requestId]);
    await panel.click('清空当前草稿');
    expect(onDelete).toHaveBeenLastCalledWith([draft.requestId, second.requestId]);
  });

  it('cancels a persisted conflict deletion when any saved version changes during confirmation', async () => {
    const confirmation = deferred<boolean>(), onDelete = vi.fn(() => ({ ok: true }));
    const conflicting = { ...draft, markdown: '另一份已保存内容' };
    const panel = await mount({ drafts: [], candidate: null, conflictingDrafts: [draft, conflicting], onDelete, confirmAction: () => confirmation.promise });
    await panel.click('清空当前草稿');
    await panel.render({ conflictingDrafts: [draft, { ...conflicting, markdown: '确认期间发生变化' }] });
    await act(async () => confirmation.resolve(true));
    expect(onDelete).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain('待删除草稿已变化');
  });

  it('does not choose a canonical saved conflict version through bulk archive export', async () => {
    const conflicting = { ...draft, markdown: '另一份已保存内容' }, candidate = { ...draft, markdown: '第三份当前未保存内容' };
    const onExport = vi.fn();
    const panel = await mount({ drafts: [second], candidate, conflictingDrafts: [draft, conflicting], status: 'available', onExport });
    await panel.click('导出未完成草稿');
    expect(onExport).toHaveBeenCalledExactlyOnceWith([second]);
    expect(panel.container.querySelectorAll('details')).toHaveLength(4);
  });

  it('deduplicates matching candidate and unsaved versions in favor of verified persisted conflicts', async () => {
    const conflicting = { ...draft, markdown: '另一份已保存内容' }, onRetryUnsaved = vi.fn(() => ({ ok: true })), onSave = vi.fn();
    const panel = await mount({ drafts: [], candidate: draft, conflictingDrafts: [draft, conflicting, conflicting], unsavedDrafts: [draft, conflicting], unsavedRequestIds: [draft.requestId], status: 'available', onRetryUnsaved, onSave });
    expect(panel.container.querySelectorAll('details')).toHaveLength(2);
    expect(panel.container.textContent).not.toContain('尚未保存到本机');
    expect(panel.container.textContent).not.toContain('有未保存草稿');
    expect(panel.button('导出未落盘版本')).toBeUndefined();
    expect(panel.button('保存未完成草稿')).toBeUndefined();
    expect(panel.button('重试保存未落盘草稿')).toBeUndefined();
    expect(onRetryUnsaved).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled();
  });

  it('distinguishes an additional unsaved version from persisted conflicts with the same ID', async () => {
    const conflicting = { ...draft, markdown: '另一份已保存内容' }, unsaved = { ...draft, markdown: '仍未保存的第三份内容' };
    const panel = await mount({ drafts: [], candidate: null, conflictingDrafts: [draft, conflicting], unsavedDrafts: [draft, unsaved], unsavedRequestIds: [draft.requestId], onRetryUnsaved: () => ({ ok: true }) });
    expect(panel.container.querySelectorAll('details')).toHaveLength(3);
    expect(panel.container.textContent).toContain('有 1 条草稿尚未保存到本机');
    expect([...panel.container.querySelectorAll('summary')].filter(summary => summary.textContent?.includes('已保存的冲突版本'))).toHaveLength(2);
    expect([...panel.container.querySelectorAll('summary')].filter(summary => summary.textContent?.includes('未落盘版本'))).toHaveLength(1);
    expect(panel.button('重试保存未落盘草稿')).toBeDefined();
    expect(panel.button('导出未完成草稿')).toBeUndefined();
  });
});
