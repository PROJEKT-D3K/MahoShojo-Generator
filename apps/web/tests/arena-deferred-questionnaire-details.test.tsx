// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => { resolve = done; });
  return { ready, resolve, loads: vi.fn() };
});
vi.mock('@/components/DataCardDetailsModal', async () => {
  fixture.loads(); await fixture.ready;
  const { BaseModal } = await import('@/components/shared/BaseModal');
  return { default: ({ isOpen, onClose, card }: { isOpen: boolean; onClose: () => void; card: { name: string } }) => (
    <BaseModal isOpen={isOpen} onClose={onClose} title={card.name}><p>完整详情</p></BaseModal>
  ) };
});
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/shared/TokenIndicator', () => ({ TokenIndicator: () => null }));
import { QuestionnaireLorePanel } from '@/components/arena/components/QuestionnaireLorePanel';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { normalizeQuestionnaireDefinition } from '@/lib/questionnaires';

test('问卷详情不首屏加载；pending可Escape关闭，重开使用当前详情并归还焦点', async () => {
  const initial = useBattleStore.getInitialState(); useBattleStore.setState(initial, true);
  useBattleStore.getState().addQuestionnaireSelection({ source: 'upload', questionnaire: normalizeQuestionnaireDefinition({
    id: 'q-deferred', kind: 'magical-girl', title: '问卷甲', questions: [], loreMarkdown: 'lore',
  })! });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ presets: [] }) }));
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QuestionnaireLorePanel />));
    expect(fixture.loads).not.toHaveBeenCalled();
    const entry = [...container.querySelectorAll('button')].find((b) => b.textContent === '详情')!;
    entry.focus();
    await act(async () => entry.click());
    await vi.waitFor(() => expect(fixture.loads).toHaveBeenCalledOnce());
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(entry);
    await act(async () => { fixture.resolve(); await vi.dynamicImportSettled(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => entry.click());
    expect(document.body.textContent).toContain('完整详情');
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(entry);
    expect(fetch).toHaveBeenCalledOnce(); expect(fixture.loads).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); useBattleStore.setState(initial, true);
  }
});
