// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NarrativeHistoryModal } from '@/components/arena/components/NarrativeHistoryModal';
import { useNarrativeHistoryStore, NARRATIVE_HISTORY_STORAGE_KEY } from '@/components/arena/stores/useNarrativeHistoryStore';
import { quickCheck } from '@/lib/sensitive-word-filter';
import { createNarrativeDraftsStore, useNarrativeDraftsStore, NARRATIVE_DRAFTS_STORAGE_KEY } from '@/components/arena/stores/useNarrativeDraftsStore';
import { createNarrativeDraftCandidate } from '@mahoshojo/domain/narrative-drafts';
import { downloadBlob } from '@/lib/client/blobUrl';
const owner = vi.hoisted(() => ({ scope: 0 }));
vi.mock('@/lib/arena/narrative-draft-owner', () => ({ captureNarrativeDraftOwner: () => { const scope = owner.scope; return { scope: `account:history-adapter-${scope}`, isCurrent: () => scope === owner.scope }; } }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: vi.fn(async (text: string) => ({ filteredText: text.replace('bad', '***'), hasSensitiveWords: text.includes('bad') })) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: vi.fn() }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: ({ data, cardType }: { data: unknown; cardType: string }) => <button data-cloud-type={cardType} data-cloud-payload={JSON.stringify(data)}>保存到云端</button> }));
vi.mock('@/components/shared/JsonSizeIndicator', () => ({ JsonSizeIndicator: () => <span>cloud size</span> }));
vi.mock('@/components/BattleDataModal', () => ({ default: ({ isOpen, onSelectCard }: { isOpen: boolean; onSelectCard: (data: unknown) => void }) => isOpen ? <button onClick={() => onSelectCard({ templateId: 'narrative-history', version: 1, entries: [{ id: 'cloud-entry', title: 'cloud', content: 'cloud body' }], _cardId: 'cloud-original' })}>选择云端历史</button> : null }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { localStorage.clear(); owner.scope += 1; useNarrativeDraftsStore.getState().setScope(`account:history-adapter-${owner.scope}`); container = document.createElement('div'); document.body.append(container); root = createRoot(container); useNarrativeHistoryStore.setState({ entries: [], lastUpdatedAt: null, sort: 'updated_desc' }); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function click(text: string) { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(text)); expect(button, text).toBeTruthy(); await act(async () => button!.click()); }
async function input(selector: string, value: string) { const field = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement; await act(async () => { Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function render() { await act(async () => root.render(<NarrativeHistoryModal isOpen onClose={vi.fn()} />)); }
const raw = JSON.stringify([{ templateId: 'narrative-history', version: 1, entries: [{ id: 'same', title: 'bad title', content: 'bad content' }] }, { templateId: 'narrative-history', version: 1, entries: [{ id: 'same', title: 'another', content: 'body' }] }]);
describe('real Web narrative editor adapter', () => {
  it('reopens and refreshes the separate managed draft archive without exposing it to formal cloud export', async () => {
    const candidate = createNarrativeDraftCandidate({ requestId: 'request-reopen', createdAt: '2026-10-14T00:00:00Z', source: 'hosted', acceptedText: '# 草稿标题\n未完成正文', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' }, reportFormat: 'markdown', generationMode: 'stream', current: true, cancelled: false, completed: false })!;
    useNarrativeDraftsStore.getState().offerDraft(candidate, true);
    await render(); expect(document.body.textContent).toContain('正式 0 条 · 未完成草稿 1 条');
    const panel = document.querySelector('[aria-label="未完成叙事草稿"]')!;
    expect(panel.querySelector('textarea')).toBeNull(); expect(panel.querySelector('input[type=checkbox]')).not.toBeNull(); expect(panel.textContent).toContain('未完成正文');
    await act(async () => root.render(<NarrativeHistoryModal isOpen={false} onClose={vi.fn()} />));
    const reopened = createNarrativeDraftsStore(localStorage, useNarrativeDraftsStore.getState().scope);
    reopened.getState().loadDrafts();
    expect(reopened.getState().drafts).toEqual([candidate]);
    useNarrativeDraftsStore.getState().clearCandidate();
    await render(); expect(document.body.textContent).toContain('草稿标题');
    expect(useNarrativeDraftsStore.getState().drafts).toEqual([candidate]);
    expect(localStorage.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBeNull();
    const raw = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).filter(key => key.startsWith('arena-narrative-drafts:v2:')).map(key => localStorage.getItem(key)).join('\n');
    expect(raw).toContain('未完成正文'); expect(raw).not.toContain('"entries"');
    expect(document.querySelector('[data-cloud-type="history"]')!.getAttribute('data-cloud-payload')).toBe('null');
    await click('导出未完成草稿'); expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), '未完成叙事草稿.json');
  });
  it('creates/edits through original store and quickCheck; cloud save receives canonical card', async () => {
    await render(); await click('新建条目'); await input('[aria-label="历史标题"]', 'bad title'); await input('[aria-label="历史正文"]', 'bad body'); await click('创建条目');
    const first = useNarrativeHistoryStore.getState().entries[0]; expect(first.content).toBe('*** body'); expect(first.title).toBe('*** title'); expect(document.body.textContent).toContain('已自动屏蔽敏感词后创建');
    await input('[aria-label="历史正文"]', 'edited bad body'); await click('保存修改'); expect(useNarrativeHistoryStore.getState().entries[0]).toMatchObject({ id: first.id, content: 'edited *** body' });
    await click('返回列表'); const cloud = document.querySelector('[data-cloud-type="history"]')!; expect(JSON.parse(cloud.getAttribute('data-cloud-payload')!)).toMatchObject({ templateId: 'narrative-history', version: 1, entries: [{ id: first.id }] });
    await click('导出 JSON'); expect(downloadBlob).toHaveBeenCalledOnce(); expect(quickCheck).toHaveBeenCalled(); expect(useNarrativeHistoryStore.persist.getOptions()).toMatchObject({ name: NARRATIVE_HISTORY_STORAGE_KEY, version: 2, skipHydration: true });
  });
  it('multi-card append normalizes/deduplicates and explicit replace remains confirmed', async () => {
    await render(); await click('粘贴导入'); await input('textarea', raw); await click('确认追加导入'); const first = useNarrativeHistoryStore.getState().entries;
    expect(first).toHaveLength(2); expect(new Set(first.map((entry) => entry.id)).size).toBe(2); expect(first[0].content).toBe('*** content'); expect(document.body.textContent).toContain('来自 2 组');
    const mode = [...document.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'replace'))!;
    await act(async () => { mode.value = 'replace'; mode.dispatchEvent(new Event('change', { bubbles: true })); }); await click('粘贴导入'); await input('textarea', JSON.stringify([{ id: 'new', title: 'new', content: 'replacement' }])); vi.mocked(window.confirm).mockReturnValueOnce(false); await click('确认覆盖导入'); expect(useNarrativeHistoryStore.getState().entries).toBe(first); expect(document.querySelector('textarea')?.value).toContain('replacement');
    await click('确认覆盖导入'); expect(useNarrativeHistoryStore.getState().entries).toMatchObject([{ id: 'new', content: 'replacement' }]);
  });
  it('cloud picker callback imports with original quickCheck and provenance hint', async () => {
    await render(); await click('从云端导入'); await click('选择云端历史'); expect(useNarrativeHistoryStore.getState().entries).toMatchObject([{ id: 'cloud-entry', content: 'cloud body' }]); expect(document.body.textContent).toContain('来源数据卡 ID：cloud-original');
  });
  it('late quickCheck result after editor unmount does not write the Web store', async () => {
    let finish!: (value: Awaited<ReturnType<typeof quickCheck>>) => void;
    vi.mocked(quickCheck).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await click('新建条目'); await input('[aria-label="历史正文"]', 'pending content'); await click('创建条目'); await act(async () => root.render(null)); await act(async () => finish({ filteredText: 'late', hasSensitiveWords: false, detectedWords: [], originalText: 'late', shouldRedirectToArrested: false, matchDetails: [] })); expect(useNarrativeHistoryStore.getState().entries).toHaveLength(0);
  });
});
