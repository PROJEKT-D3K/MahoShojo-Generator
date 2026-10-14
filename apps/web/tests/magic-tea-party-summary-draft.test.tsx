// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicTeaPartySummaryPanel } from '@/components/magic-tea-party/SummaryPanel';
import type { MagicTeaPartySession } from '@/lib/magic-tea-party/types';
vi.mock('@/components/ErrorMessage', () => ({ ErrorMessage: ({ message }: { message: string }) => <div>{message}</div> }));
const session: MagicTeaPartySession = { id: 'tea', createdAt: 1, updatedAt: 1, title: 'Tea', roles: [], summary: '原文',
  settings: { providerId: 'openai', modelId: 'synthetic' }, summaryMeta: { updatedAt: 1, tokenCount: 9,
    coverage: { version: 1, sourceMessageCount: 1, selectedMessageIds: ['old'], clippedMessageIds: [], omittedMessageCount: 0 }, extension: '保留' } as MagicTeaPartySession['summaryMeta'] };
let root: Root, container: HTMLDivElement;
const save = vi.fn(), intent = vi.fn(), generate = vi.fn(), clear = vi.fn(), stop = vi.fn(), toggle = vi.fn();
const render = (current = session, running = false) => act(async () => root.render(<MagicTeaPartySummaryPanel activeSession={current}
  isGenerating={false} isSummarizing={running} summaryError={null} hasMessages onGenerateSummary={generate} onClearSummary={clear}
  onSaveSummary={save} onSummaryIntent={intent} onStopSummary={stop} onAutoSummaryEnabledChange={toggle}
  updateDrafts={null} updateRangeSize={10} isGeneratingUpdates={false} isApplyingUpdates={false} updateError={null}
  updateApplyMode="draft" onUpdateRangeSizeChange={() => {}} onGenerateUpdates={() => {}} onApplyUpdates={() => {}}
  onClearUpdateDrafts={() => {}} onRollbackUpdates={() => {}} />));
const area = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="会话摘要正文"]')!;
const edit = async (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area(), text);
  area().dispatchEvent(new Event('input', { bubbles: true }));
});
const saveButton = () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存摘要')!;
beforeEach(async () => { save.mockReset().mockResolvedValue(true); intent.mockReset(); stop.mockReset(); toggle.mockReset(); generate.mockReset().mockResolvedValue(false); clear.mockReset().mockResolvedValue(false); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await render(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('Web summary local drafts', () => {
  it('exposes a working Stop and an enabled opt-out while automatic summary is running', async () => {
    await render({ ...session, settings: { ...session.settings, autoSummaryEnabled: true } }, true);
    const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === '停止摘要')!;
    expect(button).toBeDefined(); expect(button.disabled).toBe(false);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.disabled).toBe(false);
    await act(async () => { button.click(); checkbox.click(); });
    expect(stop).toHaveBeenCalledOnce(); expect(toggle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps fast text and composition edits local until Save, then drops old evidence but retains extensions', async () => {
    await edit('原文甲'); await edit('原文甲乙');
    await act(async () => area().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await edit('原文甲乙中文');
    await act(async () => area().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
    expect(area().value).toBe('原文甲乙中文'); expect(save).not.toHaveBeenCalled(); expect(intent).toHaveBeenCalledTimes(3);
    await act(async () => saveButton().click());
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0][0]).toMatchObject({ summary: '原文甲乙中文', summaryMeta: { extension: '保留' } });
    expect(save.mock.calls[0][0].summaryMeta).not.toHaveProperty('coverage');
    expect(save.mock.calls[0][0].summaryMeta).not.toHaveProperty('tokenCount');
  });
  it.each([false, true])('a delayed save result %s never removes newer local edits', async result => {
    let finish!: (value: boolean) => void;
    save.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await edit('提交的草稿'); await act(async () => { saveButton().click(); saveButton().click(); });
    expect(save).toHaveBeenCalledOnce();
    await edit('保存期间继续输入'); await render({ ...session, summary: '另一位置更新' });
    await act(async () => finish(result));
    expect(area().value).toBe('保存期间继续输入'); expect(saveButton().disabled).toBe(false);
  });
  it.each(['body', 'section'])('clearing dirty %s replaces the local draft only after a successful commit', async kind => {
    if (kind === 'body') await edit('未保存正文');
    else await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '新增小节')!.click());
    let finish!: (value: boolean) => void;
    clear.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '清空')!.click());
    await render({ ...session, summary: undefined, summarySections: undefined });
    await act(async () => finish(true));
    expect(area().value).toBe(''); expect(saveButton().disabled).toBe(true);
    expect(container.querySelector('input[placeholder="小节标题"]')).toBeNull();
  });
  it.each([false, true])('generation success=%s keeps failed drafts and replaces successful drafts', async success => {
    await edit('手工草稿');
    let finish!: (value: boolean) => void;
    generate.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '生成/更新摘要')!.click());
    if (success) await render({ ...session, summary: '已落盘的新摘要' });
    await act(async () => finish(success));
    expect(area().value).toBe(success ? '已落盘的新摘要' : '手工草稿');
    expect(saveButton().disabled).toBe(success);
  });

  it('preserves a rejected conditional save draft and resets only when switching sessions', async () => {
    save.mockResolvedValueOnce(false); await edit('冲突后留存'); await act(async () => saveButton().click());
    expect(area().value).toBe('冲突后留存'); expect(saveButton().disabled).toBe(false);
    await render({ ...session, id: 'other', summary: '新会话' }); expect(area().value).toBe('新会话');
    await render(session); expect(area().value).toBe('冲突后留存');
  });
});
