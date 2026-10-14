// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { NarrativeDraftsPanel } from '../src/narrative-history';
import type { NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const draft: NarrativeDraft = { requestId: 'request-one', title: '尚未结束', createdAt: '2026-10-14T00:00:00Z', source: 'hosted', markdown: '<script>unsafe()</script>正文', completion: { kind: 'unconfirmed' } };
describe('readonly unfinished narrative drafts', () => {
  it('keeps conflicting candidates separately exportable without replacing or duplicating the archived ID', async () => {
    const container = document.createElement('div'), root = createRoot(container), onExport = vi.fn();
    const candidate = { ...draft, markdown: '当前安全候选' };
    await act(async () => root.render(<NarrativeDraftsPanel drafts={[draft]} candidate={candidate} status="memory-only" onExport={onExport} />));
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find(button => button.textContent === '导出当前未保存草稿')!.click());
    expect(onExport).toHaveBeenLastCalledWith([candidate]);
    await act(async () => buttons.find(button => button.textContent === '导出未完成草稿')!.click());
    expect(onExport).toHaveBeenLastCalledWith([draft]);
    await act(async () => root.unmount());
  });
  it('only exposes explicit saving and draft-only exports, renders inert text and reports storage failures', async () => {
    const container = document.createElement('div'), root = createRoot(container), save = vi.fn(), exportDrafts = vi.fn();
    await act(async () => root.render(<NarrativeDraftsPanel drafts={[]} candidate={draft} status="memory-only" onSave={save} onExport={exportDrafts} />));
    expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('textarea,input')).toBeNull();
    expect(container.textContent).toContain('仅保留在内存'); expect(container.textContent).toContain('完成状态未确认');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['保存未完成草稿', '导出未完成草稿', '导出此草稿']);
    await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
    expect(save).toHaveBeenCalledOnce(); expect(exportDrafts).toHaveBeenCalledWith([draft]);
    await act(async () => root.render(<NarrativeDraftsPanel drafts={[draft]} candidate={draft} status="stored" onSave={save} onExport={exportDrafts} />));
    expect(container.querySelectorAll('details')).toHaveLength(1); expect(container.textContent).toContain('草稿已保存到本机');
    expect(container.textContent).not.toContain('保存未完成草稿');
    await act(async () => root.unmount());
  });
});
