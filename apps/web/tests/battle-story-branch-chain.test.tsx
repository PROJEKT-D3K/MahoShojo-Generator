// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BattleStoryBranchChainModal } from '@/components/arena/components/BattleStoryBranchChainModal';
import type { BattleStorySessionRecord } from '@/lib/ai-session/battle-story/types';

let root: Root; let container: HTMLDivElement;
const session = (id: string, parent?: string): BattleStorySessionRecord => ({
  id, title: `会话${id}`, createdAt: 0, updatedAt: 1, source: { mode: 'daily', language: 'zh', storyLength: 'standard', generationMode: 'stream' },
  seed: { combatants: [], settings: { readArenaHistory: false, writeArenaHistory: false, readCurrentState: false, writeCurrentState: false, readNarrativeHistory: false, writeNarrativeHistory: false } },
  workingCombatants: [], chapterCount: 1,
  ...(parent ? { branchOf: { sessionId: parent, chapterId: `${parent}-chapter`, chapterIndex: 1, createdAt: 1 } } : {}),
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('actual Web wrapper renders a cyclic graph with finite unique rows and explicit termination', async () => {
  const sessions = [session('A', 'B'), session('B', 'A')], select = vi.fn(), close = vi.fn();
  await act(async () => root.render(<BattleStoryBranchChainModal isOpen sessions={sessions} activeSession={sessions[0]!} onSelectSession={select} onClose={close} />));
  expect(document.body.textContent).toContain('循环分支来源');
  const parent = document.querySelector('[aria-label="已知父链"]')!;
  expect(parent.querySelectorAll('button')).toHaveLength(2); expect(parent.textContent).not.toContain('根会话');
  await act(async () => parent.querySelector<HTMLButtonElement>('button')!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith('B'); expect(close).toHaveBeenCalledOnce();
});
it('actual Web directory boundary does not turn an unavailable 101st parent into root or proof of deletion', async () => {
  const sessions = Array.from({ length: 100 }, (_, i) => session(`recent-${i}`));
  const active = session('active', 'older-than-page');
  await act(async () => root.render(<BattleStoryBranchChainModal isOpen sessions={sessions} activeSession={active} onSelectSession={vi.fn()} onClose={vi.fn()} />));
  const chain = document.querySelector('[aria-label="已知父链"]')!;
  expect(chain.textContent).not.toContain('根会话'); expect(chain.querySelectorAll('button')).toHaveLength(1);
  expect(document.body.textContent).toContain('最近 100 个会话'); expect(document.body.textContent).toContain('不能据此认定已删除');
  expect(document.body.textContent).toContain('older-than-page');
});
