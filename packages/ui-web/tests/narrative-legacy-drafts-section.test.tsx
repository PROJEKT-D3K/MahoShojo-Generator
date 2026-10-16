// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NarrativeLegacyDraftsSection, type NarrativeLegacyDraftsSectionProps, type NarrativeLegacyDraftsSnapshot } from '../src/narrative-history';
import { MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS, type NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const first: NarrativeDraft = { requestId: 'legacy-one', title: '旧故事', createdAt: '2026-10-14T00:00:00Z', source: 'hosted', markdown: '旧故事正文', completion: { kind: 'unconfirmed' } };
const second = { ...first, requestId: 'legacy-two', title: '旧故事二' };
const available: NarrativeLegacyDraftsSnapshot = { status: 'available', drafts: [first], raw: ' { "original" : "bytes" }\n' };
const roots: Root[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};
const mount = async (props: Partial<NarrativeLegacyDraftsSectionProps> = {}) => {
  const container = document.createElement('div'), root = createRoot(container);
  roots.push(root);
  let current: NarrativeLegacyDraftsSectionProps = {
    legacy: null, scopeKey: 'owner-a', onLoad: vi.fn(), onDelete: vi.fn(() => ({ ok: true })),
    onCopyToCurrent: vi.fn(() => ({ ok: true })), confirmAction: vi.fn(() => true), onExport: vi.fn(), onExportRaw: vi.fn(), ...props,
  };
  const render = async (next: Partial<NarrativeLegacyDraftsSectionProps>) => {
    current = { ...current, ...next };
    await act(async () => root.render(<NarrativeLegacyDraftsSection {...current} />));
  };
  await render({});
  const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;
  const click = async (text: string) => { await act(async () => button(text).click()); };
  return { container, render, button, click };
};
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); });

describe('separate legacy narrative drafts', () => {
  it('does not read or display legacy data until explicitly opened', async () => {
    const onLoad = vi.fn(), onCopyToCurrent = vi.fn(), onDelete = vi.fn();
    const panel = await mount({ onLoad, onCopyToCurrent, onDelete });
    expect(panel.container.textContent).toBe('查看旧设备草稿');
    expect(onLoad).not.toHaveBeenCalled();
    await act(async () => { panel.button('查看旧设备草稿').click(); panel.button('查看旧设备草稿').click(); });
    expect(onLoad).toHaveBeenCalledOnce();
    expect(panel.container.textContent).toContain('正在读取旧设备草稿');
    await panel.click('收起旧设备草稿'); await panel.click('查看旧设备草稿');
    expect(onLoad).toHaveBeenCalledOnce();
    await panel.render({ legacy: available });
    expect(panel.container.textContent).toContain('未记录账号归属');
    expect(panel.container.textContent).toContain('账号隔离不提供本机保密');
    expect(panel.container.textContent).toContain(first.title);
    expect(panel.container.textContent).not.toContain('自动保留未完成草稿');
    expect(onCopyToCurrent).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
  });

  it('exports original bytes only on explicit request without parsing or rewriting them', async () => {
    const onExportRaw = vi.fn(), raw = '  { "unknownVersion": 9000 }\r\n';
    const panel = await mount({ legacy: { status: 'protected', drafts: [], raw }, onExportRaw });
    expect(onExportRaw).not.toHaveBeenCalled();
    await panel.click('查看旧设备草稿');
    expect(panel.container.textContent).toContain('无法安全解析');
    expect(panel.container.textContent).not.toContain('unknownVersion');
    expect(panel.button('复制这些草稿到当前账号/本机范围')).toBeUndefined();
    expect(panel.button('删除此草稿')).toBeUndefined();
    await panel.click('导出旧设备原件');
    expect(onExportRaw).toHaveBeenCalledExactlyOnceWith(raw);
  });

  it('requires ownership confirmation before copying and preserves the old list', async () => {
    const confirmAction = vi.fn((_message: string) => false), onCopyToCurrent = vi.fn(() => ({ ok: true }));
    const panel = await mount({ legacy: available, confirmAction, onCopyToCurrent });
    await panel.click('查看旧设备草稿');
    await panel.click('复制这些草稿到当前账号/本机范围');
    expect(onCopyToCurrent).not.toHaveBeenCalled();
    expect(confirmAction.mock.calls[0]?.[0]).toContain('先确认它们属于你');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('旧设备原件仍保留');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('不会写入正式叙事历史');
    confirmAction.mockReturnValue(true);
    await panel.click('复制这些草稿到当前账号/本机范围');
    expect(onCopyToCurrent).toHaveBeenCalledExactlyOnceWith([first.requestId]);
    expect(panel.container.textContent).toContain('已复制到当前账号/本机范围');
    expect(panel.container.textContent).toContain(first.markdown);
  });

  it('freezes copy IDs through confirmation and blocks double clicks until the host succeeds', async () => {
    const confirmation = deferred<boolean>(), copying = deferred<{ ok: true }>();
    const confirmAction = vi.fn(() => confirmation.promise), onCopyToCurrent = vi.fn(() => copying.promise);
    const panel = await mount({ legacy: available, confirmAction, onCopyToCurrent });
    await panel.click('查看旧设备草稿');
    const label = '复制这些草稿到当前账号/本机范围';
    await act(async () => { panel.button(label).click(); panel.button(label).click(); });
    expect(confirmAction).toHaveBeenCalledOnce();
    await panel.render({ legacy: { ...available, drafts: [first, second] } });
    await act(async () => confirmation.resolve(true));
    expect(onCopyToCurrent).toHaveBeenCalledExactlyOnceWith([first.requestId]);
    expect(panel.button(label).disabled).toBe(true);
    await act(async () => copying.resolve({ ok: true }));
    expect(panel.button(label).disabled).toBe(false);
  });

  it('rejects a changed source version instead of copying unconfirmed content', async () => {
    const confirmation = deferred<boolean>(), onCopyToCurrent = vi.fn(() => ({ ok: true }));
    const panel = await mount({ legacy: available, confirmAction: () => confirmation.promise, onCopyToCurrent });
    await panel.click('查看旧设备草稿'); await panel.click('复制这些草稿到当前账号/本机范围');
    await panel.render({ legacy: { ...available, drafts: [{ ...first, markdown: '发生变化' }] } });
    await act(async () => confirmation.resolve(true));
    expect(onCopyToCurrent).not.toHaveBeenCalled();
    expect(panel.container.textContent).toContain('旧设备草稿已变化');
  });

  it('leaves archive admission to the host rather than reporting large unchanged source data as changed', async () => {
    const markdown = '文'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS / 2 + 1);
    const onCopyToCurrent = vi.fn(() => ({ ok: false, error: '当前范围超出保存预算，请分别导出' }));
    const panel = await mount({ legacy: { ...available, drafts: [{ ...first, markdown }, { ...second, markdown }] }, onCopyToCurrent, renderMarkdown: () => '长篇正文' });
    await panel.click('查看旧设备草稿'); await panel.click('复制这些草稿到当前账号/本机范围');
    expect(onCopyToCurrent).toHaveBeenCalledExactlyOnceWith([first.requestId, second.requestId]);
    expect(panel.container.textContent).toContain('当前范围超出保存预算');
    expect(panel.container.textContent).not.toContain('旧设备草稿已变化');
  });

  it('cancels old copy confirmations and closes the legacy view on scope change', async () => {
    const confirmation = deferred<boolean>(), onCopyToCurrent = vi.fn(() => ({ ok: true }));
    const panel = await mount({ legacy: available, confirmAction: () => confirmation.promise, onCopyToCurrent });
    await panel.click('查看旧设备草稿'); await panel.click('复制这些草稿到当前账号/本机范围');
    await panel.render({ scopeKey: 'owner-b', legacy: null });
    await act(async () => confirmation.resolve(true));
    expect(onCopyToCurrent).not.toHaveBeenCalled();
    expect(panel.container.textContent).toBe('查看旧设备草稿');
  });

  it('does not let a previous scope write completion leak feedback into the next scope', async () => {
    const copying = deferred<{ ok: false; error: string }>();
    const panel = await mount({ legacy: available, onCopyToCurrent: () => copying.promise });
    await panel.click('查看旧设备草稿'); await panel.click('复制这些草稿到当前账号/本机范围');
    await panel.render({ scopeKey: 'owner-b', legacy: null });
    await act(async () => copying.resolve({ ok: false, error: '旧账号错误' }));
    expect(panel.container.textContent).toBe('查看旧设备草稿');
  });

  it('shows copy failures without success or data loss and permits retry', async () => {
    const onCopyToCurrent = vi.fn().mockResolvedValueOnce({ ok: false, error: '当前范围存储不可用' }).mockRejectedValueOnce(new Error('private detail')).mockResolvedValueOnce({ ok: true });
    const panel = await mount({ legacy: available, onCopyToCurrent });
    await panel.click('查看旧设备草稿'); await panel.click('复制这些草稿到当前账号/本机范围');
    expect(panel.container.textContent).toContain('当前范围存储不可用');
    expect(panel.container.textContent).not.toContain('已复制到');
    await panel.click('复制这些草稿到当前账号/本机范围');
    expect(panel.container.textContent).toContain('复制到当前范围失败，请重试');
    expect(panel.container.textContent).not.toContain('private detail');
    await panel.click('复制这些草稿到当前账号/本机范围');
    expect(panel.container.textContent).toContain('已复制到当前账号/本机范围');
    expect(panel.container.textContent).toContain(first.markdown);
  });

  it('routes old-list deletion to its own host and explains that raw data and the current scope remain', async () => {
    const onDelete = vi.fn(() => ({ ok: true })), confirmAction = vi.fn((_message: string) => true), onExport = vi.fn(), onCopy = vi.fn();
    const panel = await mount({ legacy: available, onDelete, confirmAction, onExport, onCopy, renderMarkdown: text => <p data-legacy-body>{text}</p> });
    await panel.click('查看旧设备草稿'); await panel.click('删除此草稿');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('从旧设备列表删除');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('保留旧设备原始数据');
    expect(confirmAction.mock.calls[0]?.[0]).toContain('不会删除当前账号/本机范围');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith([first.requestId]);
    await panel.click('导出此草稿'); expect(onExport).toHaveBeenCalledExactlyOnceWith([first]);
    await panel.click('复制正文'); expect(onCopy).toHaveBeenCalledExactlyOnceWith(first.markdown);
    expect(panel.container.querySelector('[data-legacy-body]')?.textContent).toBe(first.markdown);
  });

  it('distinguishes absent data from unavailable storage and retries an unavailable read', async () => {
    const onLoad = vi.fn();
    const panel = await mount({ legacy: { status: 'absent', drafts: [], raw: null }, onLoad });
    await panel.click('查看旧设备草稿');
    expect(panel.container.textContent).toContain('未找到旧设备草稿');
    expect(panel.button('导出旧设备原件')).toBeUndefined();
    await panel.render({ legacy: { status: 'unavailable', drafts: [], raw: null } });
    expect(panel.container.textContent).toContain('暂时无法读取');
    await panel.click('重新读取旧设备草稿');
    expect(onLoad).toHaveBeenCalledOnce();
    expect(panel.container.textContent).toContain('正在读取旧设备草稿');
    await panel.render({ legacy: available });
    expect(panel.container.textContent).not.toContain('正在读取');
    expect(panel.container.textContent).toContain(first.markdown);
  });

  it('handles a throwing load callback with a retry rather than treating it as an empty archive', async () => {
    const onLoad = vi.fn().mockRejectedValueOnce(new Error('cannot read')).mockResolvedValueOnce(undefined);
    const panel = await mount({ onLoad });
    await panel.click('查看旧设备草稿');
    expect(panel.container.textContent).toContain('旧设备草稿读取失败');
    expect(panel.container.textContent).not.toContain('未找到旧设备草稿');
    await panel.click('重新读取旧设备草稿');
    expect(onLoad).toHaveBeenCalledTimes(2);
    await panel.render({ legacy: available });
    expect(panel.container.textContent).toContain(first.markdown);
  });
});
