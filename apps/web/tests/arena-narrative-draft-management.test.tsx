// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';
import { createNarrativeDraftRepository } from '@mahoshojo/domain/narrative-draft-storage';

const owner = vi.hoisted(() => ({ scope: 0 }));
vi.mock('@/lib/arena/narrative-draft-owner', () => ({ captureNarrativeDraftOwner: () => { const scope = owner.scope; return { scope: `account:management-${scope}`, isCurrent: () => scope === owner.scope }; } }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async (text: string) => ({ filteredText: text, hasSensitiveWords: false }) }));
import { NarrativeHistoryModal } from '@/components/arena/components/NarrativeHistoryModal';
import { createNarrativeDraftsStore, useNarrativeDraftsStore } from '@/components/arena/stores/useNarrativeDraftsStore';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';

let root: Root, container: HTMLDivElement;
const draft = (id: string): NarrativeDraft => ({ requestId: id, title: `草稿 ${id}`, createdAt: '2026-10-14T00:00:00Z', source: 'hosted', markdown: '月光下，她走进了一座安静的庭院。', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' } });
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find(button => button.textContent === text)!;
const mount = () => act(async () => { root.render(<NarrativeHistoryModal isOpen onClose={() => undefined} />); });
beforeEach(async () => {
  localStorage.clear(); owner.scope += 1;
  useNarrativeDraftsStore.getState().setScope(`account:management-${owner.scope}`);
  useNarrativeHistoryStore.setState(useNarrativeHistoryStore.getInitialState());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('Web formal history and scoped draft management', () => {
  it('clears four drafts while formal history is empty and persists deletion across reload and stale tabs', async () => {
    const state = useNarrativeDraftsStore.getState();
    for (let index = 0; index < 4; index++) state.offerDraft(draft(`item-${index}`), true);
    const stale = createNarrativeDraftsStore(localStorage, state.scope); stale.getState().loadDrafts();
    await mount();
    expect(button('清空').disabled).toBe(true);
    expect(button('清空当前草稿').disabled).toBe(false);
    expect(document.body.textContent).toContain('正式 0 条 · 未完成草稿 4 条');
    await act(async () => { button('清空当前草稿').click(); });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('4 条'));
    expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
    stale.getState().offerDraft(draft('item-0'), true);
    expect(stale.getState().candidate).toBeNull();
    const reopened = createNarrativeDraftsStore(localStorage, state.scope); reopened.getState().loadDrafts();
    expect(reopened.getState().drafts).toEqual([]);
    expect(useNarrativeHistoryStore.getState().entries).toEqual([]);
  });
  it('keeps rows on quota failure, retries after storage recovers, and never changes formal history', async () => {
    const state = useNarrativeDraftsStore.getState(); state.offerDraft(draft('quota-one'), true);
    useNarrativeHistoryStore.getState().appendEntry({ title: '正式故事', content: '完整的正式历史' });
    const formal = useNarrativeHistoryStore.getState().entries;
    await mount();
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.includes(':deleted:')) throw new Error('QuotaExceededError');
      original.call(this, key, value);
    });
    await act(async () => { button('删除此草稿').click(); });
    expect(useNarrativeDraftsStore.getState().drafts).toHaveLength(1);
    expect(document.body.textContent).toContain('删除屏障未能保存');
    spy.mockRestore();
    await act(async () => { button('删除此草稿').click(); });
    expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
    expect(useNarrativeHistoryStore.getState().entries).toEqual(formal);
  });
  it('shows every persisted conflicting version after reload and clears the confirmed request without touching history', async () => {
    const scope = useNarrativeDraftsStore.getState().scope!;
    const first = draft('conflict-one'), second = { ...first, markdown: '另一份完整但不同的故事原文。' };
    // These two valid entries are the final state of concurrent admission (domain tests interleave the writes).
    const entries = new Map<string, string>();
    const isolated = { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
    expect(createNarrativeDraftRepository(localStorage).save(scope, first).ok).toBe(true);
    expect(createNarrativeDraftRepository(isolated).save(scope, second).ok).toBe(true);
    for (const [key, value] of entries) localStorage.setItem(key, value);
    useNarrativeDraftsStore.getState().loadDrafts();
    await mount();
    expect(document.body.textContent).toContain(first.markdown);
    expect(document.body.textContent).toContain(second.markdown);
    expect(document.body.textContent).toContain('正式 0 条 · 未完成草稿 1 条');
    expect(useNarrativeDraftsStore.getState().unsavedRequestIds).toEqual([]);
    expect(button('清空当前草稿').disabled).toBe(false);
    await act(async () => { button('清空当前草稿').click(); });
    const reopened = createNarrativeDraftsStore(localStorage, scope); reopened.getState().loadDrafts();
    expect(reopened.getState().drafts).toEqual([]);
    expect(reopened.getState().conflictingDrafts).toEqual([]);
    expect(useNarrativeHistoryStore.getState().entries).toEqual([]);
  });
  it('does not expose unscoped legacy data until the explicit device action', async () => {
    const raw = JSON.stringify({ version: 1, archive: { kind: 'arena-narrative-draft-archive', version: 1, drafts: [draft('old-device')] }, completedRequestIds: [] });
    localStorage.setItem('arena-narrative-drafts-v1', raw);
    await mount();
    expect(document.body.textContent).not.toContain('草稿 old-device');
    await act(async () => { button('查看旧设备草稿').click(); });
    expect(document.body.textContent).toContain('草稿 old-device');
    expect(localStorage.getItem('arena-narrative-drafts-v1')).toBe(raw);
    expect(useNarrativeDraftsStore.getState().drafts).toEqual([]);
  });
});
