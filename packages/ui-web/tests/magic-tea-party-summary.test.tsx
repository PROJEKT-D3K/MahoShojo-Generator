// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MagicTeaPartyMessage, MagicTeaPartyPreferences } from '@mahoshojo/domain/magic-tea-party/types';
import { MagicTeaPartyChatMessage, MagicTeaPartySummaryBody } from '../src/magic-tea-party';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('keeps the shared summary body controlled and hosts save/collapse/error/extension slots without writes', async () => {
  const generate = vi.fn(), save = vi.fn(), clear = vi.fn();
  const Panel = () => { const [summary, setSummary] = useState('摘要'); const [collapsed, setCollapsed] = useState(false);
    return <MagicTeaPartySummaryBody active summary={summary} disabled={false} isSummarizing={false} hasMessages error="保留旧摘要" description="本地保存" collapsed={collapsed}
      onCollapsedChange={setCollapsed} onGenerate={generate} onClear={clear} onChange={setSummary} onSave={save} dirty>
      <div>宿主小节工具</div>
    </MagicTeaPartySummaryBody>; };
  await act(async () => root.render(<Panel />)); const input = container.querySelector('textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, ' 新编辑 '); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(input.value).toBe(' 新编辑 '); expect(save).not.toHaveBeenCalled();
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
  expect(button('生成/更新摘要').title).toContain('Token'); await act(async () => button('生成/更新摘要').click()); expect(generate).toHaveBeenCalledOnce();
  await act(async () => button('保存摘要').click()); expect(save).toHaveBeenCalledOnce();
  await act(async () => button('收起').click()); expect(container.querySelector('textarea')).toBeNull(); expect(container.textContent).toContain('摘要错误：保留旧摘要'); expect(container.textContent).not.toContain('宿主小节工具');
  await act(async () => button('展开').click()); expect(container.querySelector('textarea')!.value).toBe(' 新编辑 '); expect(container.textContent).toContain('宿主小节工具');
});
it.each(['done', 'error', 'streaming'] as const)('renders summary %s as a non-role operation without parsing fake choices', async status => {
  const choose = vi.fn(); const raw = '  {"type":"choices","items":[{"id":"c","text":"不可执行"}]}  ';
  const message: MagicTeaPartyMessage = { id: 'summary', sessionId: 'tea', role: 'assistant', status, createdAt: 1, content: raw.trim(),
    meta: { kind: 'summary', choicesValid: true, rawOutput: raw }, segments: [{ type: 'choices', items: [{ id: 'c', text: '不可执行' }] }] };
  await act(async () => root.render(<MagicTeaPartyChatMessage message={message} session={null} preferences={{} as MagicTeaPartyPreferences} isGenerating={false} onSelectChoice={choose} outputView="raw" />));
  expect(container.textContent).toContain('魔法茶会 · 摘要操作'); expect(container.textContent).toContain(raw); expect(container.querySelector('button')).toBeNull(); expect(choose).not.toHaveBeenCalled();
});
