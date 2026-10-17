// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardLibraryModalProps, CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';

const boundary = vi.hoisted(() => ({ props: null as Omit<CardLibraryModalProps, 'host'> | null }));
vi.mock('@/components/BattleDataModal', () => ({ default: (props: Omit<CardLibraryModalProps, 'host'>) => { boundary.props = props; return null; } }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: false, loading: false, user: null }) }));
vi.mock('@/components/arena/hooks/useArenaData', () => ({ useLanguagesQuery: () => ({ data: [] }) }));
vi.mock('@/lib/arena/verify-origin', () => ({ verifyArenaContentOrigin: vi.fn(async () => false) }));
vi.mock('@mahoshojo/ui-web/arena', async (importOriginal) => ({
  ...await importOriginal<object>(),
  AdvancedArenaPageView: () => null,
  BattleLitePageView: () => null,
}));

import { ArenaPage } from '@/components/arena/ArenaPage';
import { BattleLitePage } from '@/components/arena-lite/BattleLitePage';

let root: Root;
let container: HTMLDivElement;
const props = () => {
  if (!boundary.props) throw new Error('missing card library boundary');
  return boundary.props;
};
const source = (storageLocation: 'local' | 'cache', id: string): CardLibrarySelectionContext => ({
  selectionId: `${storageLocation}:${id}`,
  storageLocation,
  rawSourceData: { templateId: '通用角色', name: '同名角色', content: '原文', extension: { retained: true } },
});

beforeEach(() => {
  boundary.props = null;
  localStorage.clear();
  useBattleStore.setState(useBattleStore.getInitialState(), true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe.each([['ArenaPage', ArenaPage], ['BattleLitePage', BattleLitePage]] as const)('%s 真实角色卡库接缝', (_name, Page) => {
  it('保留 callback Promise/context，更新来源选择键并仅删除指定同名行', async () => {
    await act(async () => root.render(<Page />));
    expect(props().selectedSelectionIds).toEqual([]);
    expect(props().selectedCardIds).toBeUndefined();
    expect(props().maxSelected).toBeUndefined();
    const local = source('local', 'one');
    await act(async () => {
      const pending = props().onToggleCard?.({ _cardName: '同名角色' }, true, local);
      expect(pending).toBeInstanceOf(Promise);
      await pending;
    });
    expect(props().selectedSelectionIds).toEqual(['local:one']);
    await act(async () => {
      const pending = props().onSelectCard?.({ _cardName: '同名角色' }, source('cache', 'two'));
      expect(pending).toBeInstanceOf(Promise);
      await pending;
    });
    expect(props().selectedSelectionIds).toEqual(['local:one', 'cache:two']);
    await act(async () => props().onToggleCard?.(undefined, false, { storageLocation: 'local', selectionId: 'local:one' }));
    expect(props().selectedSelectionIds).toEqual(['cache:two']);
    expect(useBattleStore.getState().combatants).toHaveLength(1);
  });
});
