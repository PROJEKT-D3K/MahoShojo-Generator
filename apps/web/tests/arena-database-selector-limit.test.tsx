// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSelector } from '@/components/arena/components/DatabaseSelector';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Web Arena / Battle Lite character source limit', () => {
  it('preserves the ordinary editor default unlimited roster beyond the room limit', async () => {
    const browse = vi.fn();
    const random = vi.fn();
    await act(async () => root.render(<DatabaseSelector combatantCount={40} isAuthenticated isGenerating={false}
      isMatching={null} onOpenCharacterModal={browse} onRandomMatchCharacter={random} />));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map(button => button.disabled)).toEqual([false, false]);
    await act(async () => { buttons[0]!.click(); buttons[1]!.click(); });
    expect(browse).toHaveBeenCalledOnce();
    expect(random).toHaveBeenCalledOnce();
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])('preserves unlimited semantics for a non-positive or non-finite limit %s', async limit => {
    await act(async () => root.render(<DatabaseSelector combatantCount={40} maxCombatants={limit} isAuthenticated isGenerating={false}
      isMatching={null} onOpenCharacterModal={() => {}} onRandomMatchCharacter={() => {}} />));
    expect([...container.querySelectorAll('button')].map(button => button.disabled)).toEqual([false, false]);
  });
  it('still honors an explicit room-sized limit', async () => {
    await act(async () => root.render(<DatabaseSelector combatantCount={32} maxCombatants={32} isAuthenticated isGenerating={false}
      isMatching={null} onOpenCharacterModal={() => {}} onRandomMatchCharacter={() => {}} />));
    expect([...container.querySelectorAll('button')].map(button => button.disabled)).toEqual([true, true]);
  });
});
