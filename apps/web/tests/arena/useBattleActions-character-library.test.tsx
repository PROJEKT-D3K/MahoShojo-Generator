// @vitest-environment jsdom

import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { useBattleActions } from '@/components/arena/hooks/useBattleActions';
import { useBattleStore } from '@/components/arena/stores/useBattleStore';
import { verifyArenaContentOrigin } from '@/lib/arena/verify-origin';

vi.mock('@/lib/arena/verify-origin', () => ({ verifyArenaContentOrigin: vi.fn(async () => false) }));

const event = (id: string) => ({ id, description: id, type: 'binary' as const, probability: 50 });
const character = (eventId = 'inherited') => ({
  templateId: '通用角色', name: '同名角色', content: '角色正文', adjudicationEvents: [event(eventId)],
  _cardId: 'original-extension', extension: { nested: ['original'] },
});
const context = (storageLocation: CardLibrarySelectionContext['storageLocation'], id: string, rawSourceData = character()): CardLibrarySelectionContext => ({
  storageLocation,
  selectionId: `${storageLocation}:${id}`,
  ...(storageLocation === 'cloud' ? { cloudCardId: id, cloudCardUpdatedAt: 'server-version' } : {}),
  rawSourceData,
});
const payload = (id = '') => ({ ...character(), _cardId: id, _cardName: '同名角色', _cardType: 'character', _author: '云端作者' });
const selected = () => useBattleStore.getState().combatants;
const ids = () => useBattleStore.getState().adjudicationEvents.map((entry) => entry.id);
let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useBattleActions>;
const Harness = () => {
  const current = useBattleActions();
  useEffect(() => { actions = current; }, [current]);
  return null;
};
const toggle = (card: unknown, nextSelected: boolean, source: CardLibrarySelectionContext) =>
  actions.handleToggleCombatantDataCard(card, nextSelected, source);

beforeEach(async () => {
  vi.mocked(verifyArenaContentOrigin).mockReset().mockResolvedValue(false);
  localStorage.clear();
  useBattleStore.setState(useBattleStore.getInitialState(), true);
  useBattleStore.setState({ adjudicationEvents: [event('manual')] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Web 卡库角色连续多选', () => {
  it('本地角色无需云 ID，并深拷贝原正文而不误删同名扩展字段', async () => {
    const source = context('local', 'local-one');
    await act(async () => toggle(payload(), true, source));
    expect(selected()).toHaveLength(1);
    expect(selected()[0]).toMatchObject({ cardLibrarySelectionId: 'local:local-one', data: source.rawSourceData });
    expect(selected()[0]).not.toHaveProperty('sourceDataCardId');
    expect(selected()[0]).not.toHaveProperty('sourceAuthor');
    const stored = selected()[0];
    if (!('data' in stored)) throw new Error('expected character');
    expect(stored.data).not.toBe(source.rawSourceData);
    expect(stored.data.extension).not.toBe(source.rawSourceData?.extension);
    expect(ids()).toEqual(['manual', 'inherited']);
    expect(useBattleStore.getState().adjudicationEvents[1].sourceKey).toBe('library:local:local-one');
  });

  it('独立来源同名角色可以连续加入；撤选只清对应行与其事件且不读取正文', async () => {
    await act(async () => toggle(payload('cloud-one'), true, context('cloud', 'cloud-one', character('cloud-event'))));
    await act(async () => toggle(payload('cloud-two'), true, context('cloud', 'cloud-two', character('second-event'))));
    expect(selected()).toHaveLength(2);
    expect(ids()).toEqual(['manual', 'cloud-event', 'second-event']);
    const unreadable = new Proxy({}, { get: () => { throw new Error('不得读取撤选正文'); } });
    await act(async () => toggle(unreadable, false, context('cloud', 'cloud-one')));
    expect(selected()).toHaveLength(1);
    expect(selected()[0]).toMatchObject({ cardLibrarySelectionId: 'cloud:cloud-two' });
    expect(ids()).toEqual(['manual', 'second-event']);
  });

  it('异步验证期间关闭取消不会追加角色或继承事件，并返回 false', async () => {
    let resolveVerification!: (value: boolean) => void;
    vi.mocked(verifyArenaContentOrigin).mockImplementationOnce(() => new Promise((resolve) => { resolveVerification = resolve; }));
    const controller = new AbortController();
    const source = { ...context('cloud', 'cancelled'), signal: controller.signal };
    let result: false | void;
    await act(async () => {
      const pending = toggle(payload('cancelled'), true, source);
      controller.abort();
      resolveVerification(false);
      result = await pending;
    });
    expect(result!).toBe(false);
    expect(selected()).toHaveLength(0);
    expect(ids()).toEqual(['manual']);
  });

  it('本地/缓存输入忽略伪造云身份；在线重验证缓存仍按原展示行撤选', async () => {
    await act(async () => toggle(payload('forged-cloud-id'), true, context('cache', 'cached', character('offline-cache'))));
    expect(selected()[0]).toMatchObject({ cardLibrarySelectionId: 'cache:cached' });
    expect(selected()[0]).not.toHaveProperty('sourceDataCardId');
    expect(selected()[0]).not.toHaveProperty('sourceAuthor');
    expect(selected()[0]).not.toHaveProperty('sourceIsPublic');
    await act(async () => toggle(undefined, false, { selectionId: 'cache:cached', storageLocation: 'cache' }));
    const revalidated = { ...context('cloud', 'cached', character('online-cache')), rowSelectionId: 'cache:cached' };
    await act(async () => toggle(payload('forged-cloud-id'), true, revalidated));
    expect(selected()[0]).toMatchObject({
      cardLibrarySelectionId: 'cache:cached', sourceDataCardId: 'cached', sourceDataCardUpdatedAt: 'server-version',
    });
    await act(async () => toggle(payload('cached'), true, context('cloud', 'cached', character('cloud-row'))));
    expect(selected()).toHaveLength(2);
    await act(async () => toggle(undefined, false, { selectionId: 'cache:cached', storageLocation: 'cache' }));
    expect(selected()).toMatchObject([{ cardLibrarySelectionId: 'cloud:cached' }]);
    expect(ids()).toEqual(['manual', 'cloud-row']);
  });

  it('同一行重复点击和重复撤选返回 false，不重复追加事件；旧云角色兼容撤选', async () => {
    await act(async () => actions.handleSelectDataCard(payload('legacy-cloud')));
    await act(async () => {
      expect(await toggle(payload('legacy-cloud'), true, context('cloud', 'legacy-cloud'))).toBe(false);
      await toggle(undefined, false, { selectionId: 'cloud:legacy-cloud', storageLocation: 'cloud' });
      expect(await toggle(undefined, false, { selectionId: 'cloud:legacy-cloud', storageLocation: 'cloud' })).toBe(false);
    });
    expect(selected()).toHaveLength(0);
    expect(ids()).toEqual(['manual']);
    await act(async () => {
      await toggle(payload(), true, context('local', 'one'));
      expect(await toggle(payload(), true, context('local', 'one'))).toBe(false);
    });
    expect(selected()).toHaveLength(1);
    expect(ids()).toEqual(['manual', 'inherited']);
  });

  it('并发验证使用最新名单且名单和事件原子提交，同一行 busy 返回 false', async () => {
    const releases: Array<(value: boolean) => void> = [];
    vi.mocked(verifyArenaContentOrigin).mockImplementation(() => new Promise((resolve) => { releases.push(resolve); }));
    const mismatches: string[] = [];
    const unsubscribe = useBattleStore.subscribe((state) => {
      if (state.combatants.length !== state.adjudicationEvents.length - 1) mismatches.push('non-atomic commit');
    });
    try {
      await act(async () => {
        const first = toggle(payload(), true, context('local', 'first', character('first-event')));
        expect(await toggle(payload(), true, context('local', 'first'))).toBe(false);
        const second = toggle(payload(), true, context('local', 'second', character('second-event')));
        releases[1](false);
        await second;
        releases[0](false);
        await first;
      });
      expect(selected()).toHaveLength(2);
      expect(ids()).toEqual(['manual', 'second-event', 'first-event']);
      expect(mismatches).toEqual([]);
    } finally { unsubscribe(); }
  });

  it('取消在途添加后可立刻重新选择，旧完成不得覆盖新结果', async () => {
    let releaseOld!: (value: boolean) => void;
    vi.mocked(verifyArenaContentOrigin).mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    const controller = new AbortController();
    await act(async () => {
      const old = toggle(payload(), true, { ...context('local', 'reopen', character('old')), signal: controller.signal });
      controller.abort();
      await toggle(payload(), true, context('local', 'reopen', character('new')));
      releaseOld(false);
      expect(await old).toBe(false);
    });
    expect(selected()).toHaveLength(1);
    expect(ids()).toEqual(['manual', 'new']);
  });

  it('撤选在途行使未完成添加失效；预先取消不读取正文，失败可重试', async () => {
    const controller = new AbortController();
    controller.abort();
    const unreadable = new Proxy({}, { get: () => { throw new Error('不得读取取消正文'); } });
    await act(async () => {
      expect(await toggle(unreadable, true, { ...context('local', 'pre-cancel'), signal: controller.signal })).toBe(false);
      vi.mocked(verifyArenaContentOrigin).mockRejectedValueOnce(new Error('校验失败'));
      await expect(toggle(payload(), true, context('local', 'retry'))).rejects.toThrow('校验失败');
      expect(useBattleStore.getState().error).toContain('校验失败');
      expect(selected()).toHaveLength(0);
      expect(ids()).toEqual(['manual']);
      await toggle(payload(), true, context('local', 'retry'));
    });
    expect(selected()).toHaveLength(1);
    let release!: (value: boolean) => void;
    vi.mocked(verifyArenaContentOrigin).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => {
      const pending = toggle(payload(), true, context('local', 'removed'));
      expect(await toggle(undefined, false, { selectionId: 'local:removed', storageLocation: 'local' })).toBe(false);
      release(false);
      expect(await pending).toBe(false);
    });
    expect(selected()).toHaveLength(1);
  });

  it('验证完成时生成状态变化会拒绝添加；提交瞬间取消会回滚角色与事件', async () => {
    let release!: (value: boolean) => void;
    vi.mocked(verifyArenaContentOrigin).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => {
      const pending = toggle(payload(), true, context('local', 'generation'));
      useBattleStore.setState({ isGenerating: true });
      release(false);
      expect(await pending).toBe(false);
      useBattleStore.setState({ isGenerating: false });
    });
    const controller = new AbortController();
    const unsubscribe = useBattleStore.subscribe((state) => { if (state.combatants.length > 0) controller.abort(); });
    try {
      await act(async () => {
        expect(await toggle(payload(), true, { ...context('local', 'commit-cancel'), signal: controller.signal })).toBe(false);
      });
      expect(selected()).toHaveLength(0);
      expect(ids()).toEqual(['manual']);
    } finally { unsubscribe(); }
  });

  it('Web 角色卡库保持无数量上限，粘贴仍按旧文件名去重', async () => {
    await act(async () => {
      for (let index = 0; index < 22; index += 1) await toggle(payload(), true, context('local', `many-${index}`));
    });
    expect(selected()).toHaveLength(22);
    await act(async () => {
      await actions.handlePaste(JSON.stringify({ templateId: '通用角色', name: '粘贴角色', content: '正文' }));
      await actions.handlePaste(JSON.stringify({ templateId: '通用角色', name: '粘贴角色', content: '正文' }));
    });
    expect(selected()).toHaveLength(23);
    expect(useBattleStore.getState().error).toContain('同名角色');
  });

});
