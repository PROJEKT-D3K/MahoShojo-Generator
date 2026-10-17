// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationRankingParticipant, GenerationRankingQueueResult } from '@mahoshojo/contracts/arena-generation-ranking';

import { CombatantList } from '@/components/arena/components/CombatantList';
import { getArenaRosterCombatantKey, useBattleStore } from '@/components/arena/stores/useBattleStore';
import type { CombatantData } from '@/components/arena/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dataCombatant = (filename: string, codename: string, teamId?: number): CombatantData => ({
  type: 'magical-girl',
  data: { codename, name: codename },
  filename,
  isValid: true,
  isPreset: false,
  isNonStandard: false,
  ...(teamId ? { teamId } : {}),
});

const resetStore = () => {
  useBattleStore.setState(useBattleStore.getInitialState(), true);
};

const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const button = (label: string): HTMLButtonElement => {
  const target = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!(target instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return target;
};

const renderList = (): void => {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CombatantList onShowDetails={() => undefined} />
      </QueryClientProvider>,
    );
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetStore();
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('shared Arena roster section via solo adapter', () => {
  const seedMeta = (id: string, rating: number) => queryClient.setQueryData(['arenaDataCardMeta', id], {
    success: true, metrics: { techScore: 77, techLevel: 'A' },
    ratings: { strict: { queue: 'strict', rating, games: 4, wins: 2, losses: 1, draws: 1, tier: '无牌' }, free: null },
  });
  const queue = (patch: Partial<GenerationRankingQueueResult> = {}): GenerationRankingQueueResult => ({
    eligible: false, ineligibleReasons: ['need-login'], eventStatus: 'applied', skipReason: null,
    rating: null, games: null, tier: null, delta: null, rank: null, total: null, rankDelta: null, ...patch,
  });
  const participant = (entityId: string, strict: GenerationRankingQueueResult): GenerationRankingParticipant => ({
    displayName: '服务器旧名称', entityType: 'data_card', entityId, entityKey: `data_card:${entityId}`,
    dataCardId: entityId, presetId: null, techScore: null, techLevel: null,
    queues: { strict, free: queue({ rating: 0, delta: 0 }) },
  });

  it('keeps existing metadata ratings without a settlement suffix when no result exists', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    seedMeta('alpha', 1210);
    useBattleStore.setState({ combatants: [{ ...dataCombatant('alpha.json', '阿尔法'), sourceDataCardId: 'alpha' }] });
    renderList();
    const row = container.querySelector('.group')!;
    expect(row.textContent).toContain('严格：1210');
    expect(row.textContent).toContain('自由：-');
    expect(row.textContent).toContain('技术值：77');
    expect(row.textContent).not.toMatch(/已计分|未计分|结算中|暂无结算记录|不符合计分资格/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses shared settlement rows while preserving entity matching, metadata fallback, badges and prediction', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    seedMeta('alpha', 1210); seedMeta('beta', 1300);
    queryClient.setQueryData(['arenaGenerationRanking', 'generation-test'], {
      success: true, generationId: 'generation-test', state: 'ready', snapshot: { status: 'completed', combatantCount: 2 },
      participants: [participant('beta', queue({ rating: 1250, delta: -5 })), participant('alpha', queue())],
    });
    useBattleStore.setState({ lastGenerationId: 'generation-test', combatants: [
      { ...dataCombatant('alpha.json', '阿尔法'), sourceDataCardId: 'alpha' },
      { ...dataCombatant('beta.json', '贝塔'), sourceDataCardId: 'beta' },
    ] });
    renderList();
    const rows = [...container.querySelectorAll('.group')];
    const alpha = rows.find(row => row.textContent?.includes('阿尔法'))!;
    const beta = rows.find(row => row.textContent?.includes('贝塔'))!;
    expect(alpha.textContent).toContain('严格：1210（已计分；本局变化未返回）');
    expect(beta.textContent).toContain('严格：1250（已计分；本局变化：Δ-5）');
    expect(alpha.textContent).toContain('自由：0（已计分；本局变化：Δ+0）');
    expect(alpha.textContent).toContain('技术值：77');
    expect(alpha.textContent).toContain('无牌');
    expect(alpha.querySelector('[title="预计胜率（Elo · 严格）：44%（1210 vs 1250）"]')).not.toBeNull();
    expect(alpha.textContent).not.toContain('需登录');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('渲染 roster 行与计数，并支持全局重排', () => {
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法'), dataCombatant('beta.json', '贝塔')],
    });
    renderList();

    expect(container.textContent).toContain('已选角色 (2/无限制):');
    expect(container.textContent).toContain('阿尔法');
    expect(container.textContent).toContain('贝塔');
    expect(container.textContent).toContain('(魔法少女)');

    const moveDown = container.querySelector<HTMLButtonElement>('button[aria-label="下移 阿尔法"]');
    if (!moveDown) throw new Error('move button not found');
    act(() => moveDown.click());

    expect(useBattleStore.getState().combatants.map((item) => item.filename))
      .toEqual(['beta.json', 'alpha.json']);
  });

  it('新建分队后可内联重命名，并把角色分配到分队', () => {
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法')],
    });
    renderList();

    act(() => button('+ 新建分队').click());
    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="分队名称"]');
    if (!renameInput) throw new Error('team rename input not found');
    expect(useBattleStore.getState().teams.map((team) => team.name)).toEqual(['分队 1']);

    act(() => setValue(renameInput, '守护队'));
    act(() => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useBattleStore.getState().teams.map((team) => team.name)).toEqual(['守护队']);

    const teamSelect = container.querySelector<HTMLSelectElement>('select[title="把角色加入/转移到该分队"]');
    if (!teamSelect) throw new Error('team member select not found');
    act(() => setValue(teamSelect, JSON.stringify(['file', 'alpha.json'])));

    expect(useBattleStore.getState().combatants[0]?.teamId).toBe(1);
    expect(container.textContent).toContain('未分队');
    expect(container.textContent).toContain('守护队');
  });

  it('重命名输入在折叠按钮外，点击输入与回车提交不会触发分队折叠', () => {
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法')],
    });
    renderList();

    act(() => button('+ 新建分队').click());
    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="分队名称"]');
    if (!renameInput) throw new Error('team rename input not found');
    expect(container.textContent).toContain('暂无成员');

    // 点击输入框曾因嵌套在折叠 button 内冒泡触发折叠，导致队伍内容收起。
    act(() => renameInput.click());
    expect(container.textContent).toContain('暂无成员');

    act(() => setValue(renameInput, '守护队'));
    act(() => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useBattleStore.getState().teams.map((team) => team.name)).toEqual(['守护队']);
    expect(container.textContent).toContain('暂无成员');
  });

  it('分队成员可移回未分队，删除分队需确认', () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法', 1)],
      teams: [{ id: 1, name: '守护队', isCollapsed: false }],
    });
    renderList();

    const moveBackSelect = container.querySelector<HTMLSelectElement>('select[title="把某个已分队的角色移回未分队"]');
    if (!moveBackSelect) throw new Error('move-back select not found');
    act(() => setValue(moveBackSelect, JSON.stringify(['file', 'alpha.json'])));
    expect(useBattleStore.getState().combatants[0]?.teamId).toBeUndefined();

    act(() => button('删除').click());
    expect(globalThis.confirm).toHaveBeenCalled();
    expect(useBattleStore.getState().teams).toEqual([]);
  });

  it('行动引导编辑写入 store', () => {
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法')],
    });
    renderList();

    const row = [...container.querySelectorAll('.group')]
      .find((candidate) => candidate.textContent?.includes('阿尔法'));
    if (!row) throw new Error('row not found');
    const actionButton = [...row.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === '行动');
    if (!(actionButton instanceof HTMLButtonElement)) throw new Error('guidance button not found');
    act(() => actionButton.click());

    const guidance = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.id === `arena-roster-guidance-${JSON.stringify(['file', 'alpha.json'])}`);
    if (!guidance) throw new Error('guidance textarea not found');
    act(() => setValue(guidance, '优先保护同伴'));

    const combatant = useBattleStore.getState().combatants[0];
    expect(combatant && 'data' in combatant ? combatant.characterGuidance : undefined).toBe('优先保护同伴');
  });

  it('同名卡库行使用独立 UI 身份编辑引导、分队并删除来源事件', () => {
    const card = (id: string): CombatantData => ({
      ...dataCombatant('同名.json', '同名'),
      cardLibrarySelectionId: `local:${id}`,
      adjudicationSourceKey: `library:local:${id}`,
    });
    useBattleStore.setState({
      combatants: [card('one'), card('two')],
      teams: [{ id: 1, name: '守护队', isCollapsed: false }],
      adjudicationEvents: ['one', 'two'].map((id) => ({
        id, description: id, type: 'binary', probability: 50, sourceKey: `library:local:${id}`,
      })),
    });
    renderList();
    const rows = [...container.querySelectorAll('.group')];
    expect(rows).toHaveLength(2);
    const actionButton = [...rows[1].querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === '行动');
    if (!(actionButton instanceof HTMLButtonElement)) throw new Error('guidance button not found');
    act(() => actionButton.click());
    const guidance = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find((node) => node.id === `arena-roster-guidance-${JSON.stringify(['library', 'local:two'])}`);
    expect(guidance).not.toBeNull();
    act(() => setValue(guidance!, '只修改第二个角色'));
    expect(useBattleStore.getState().combatants.map((item) => 'data' in item ? item.characterGuidance : undefined))
      .toEqual([undefined, '只修改第二个角色']);

    const teamSelect = container.querySelector<HTMLSelectElement>('select[title="把角色加入/转移到该分队"]');
    if (!teamSelect) throw new Error('team member select not found');
    act(() => setValue(teamSelect, JSON.stringify(['library', 'local:two'])));
    expect(useBattleStore.getState().combatants.map((item) => item.teamId)).toEqual([undefined, 1]);

    const groupedRow = [...container.querySelectorAll('.group')].find((row) => row.textContent?.includes('只修改第二个角色'));
    const removeButton = groupedRow?.querySelector<HTMLButtonElement>('button[aria-label="移除 同名"]');
    if (!removeButton) throw new Error('second row remove button not found');
    act(() => removeButton.click());
    expect(useBattleStore.getState().combatants).toMatchObject([{ cardLibrarySelectionId: 'local:one' }]);
    expect(useBattleStore.getState().adjudicationEvents.map((entry) => entry.id)).toEqual(['one']);
  });

  it('卡库 UI key 与旧上传 filename 相同也只修改/移除命中的卡库行', () => {
    useBattleStore.setState({ combatants: [
      { ...dataCombatant('同名.json', '库角色'), cardLibrarySelectionId: 'local:two', adjudicationSourceKey: 'library:local:two' },
      { ...dataCombatant('local:two', '上传角色'), adjudicationSourceKey: 'file:local:two' },
    ], adjudicationEvents: [
      { id: 'library', description: 'library', type: 'binary', probability: 50, sourceKey: 'library:local:two' },
      { id: 'upload', description: 'upload', type: 'binary', probability: 50, sourceKey: 'file:local:two' },
    ] });
    const reference = { rosterKey: getArenaRosterCombatantKey(useBattleStore.getState().combatants[0]) };
    useBattleStore.getState().updateCombatantCharacterGuidance(reference, '卡库行动');
    useBattleStore.getState().updateCombatantTeam(reference, 1);
    expect(useBattleStore.getState().combatants.map((item) => ({ guidance: 'data' in item ? item.characterGuidance : undefined, teamId: item.teamId })))
      .toEqual([{ guidance: '卡库行动', teamId: 1 }, { guidance: undefined, teamId: undefined }]);
    useBattleStore.getState().removeCombatant(reference);
    expect(useBattleStore.getState().combatants).toMatchObject([{ filename: 'local:two', data: { codename: '上传角色' } }]);
    expect(useBattleStore.getState().adjudicationEvents.map((entry) => entry.id)).toEqual(['upload']);
  });

  it('真实 roster 点击碰撞上传行只删除上传自身，保留卡库行和事件', () => {
    useBattleStore.setState({ combatants: [
      { ...dataCombatant('同名.json', '库角色'), cardLibrarySelectionId: 'local:two', adjudicationSourceKey: 'library:local:two' },
      { ...dataCombatant('local:two', '上传角色'), adjudicationSourceKey: 'file:local:two' },
    ], adjudicationEvents: [
      { id: 'library', description: 'library', type: 'binary', probability: 50, sourceKey: 'library:local:two' },
      { id: 'upload', description: 'upload', type: 'binary', probability: 50, sourceKey: 'file:local:two' },
    ] });
    renderList();
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label="移除 上传角色"]');
    expect(removeButton).not.toBeNull();
    act(() => removeButton!.click());
    expect(useBattleStore.getState().combatants).toMatchObject([{ cardLibrarySelectionId: 'local:two', data: { codename: '库角色' } }]);
    expect(useBattleStore.getState().adjudicationEvents.map((entry) => entry.id)).toEqual(['library']);
  });

  it.each(['local:two', JSON.stringify(['library', 'local:two'])])('旧直接文件名 %s 不被猜成内部引用', (filename) => {
    useBattleStore.setState({ combatants: [
      { ...dataCombatant('同名.json', '库角色'), cardLibrarySelectionId: 'local:two', adjudicationSourceKey: 'library:local:two' },
      { ...dataCombatant(filename, '上传角色'), adjudicationSourceKey: `file:${filename}` },
    ] });
    useBattleStore.getState().updateCombatantCharacterGuidance(filename, '上传行动');
    useBattleStore.getState().updateCombatantTeam(filename, 1);
    expect(useBattleStore.getState().combatants.map((item) => ({ guidance: 'data' in item ? item.characterGuidance : undefined, teamId: item.teamId })))
      .toEqual([{ guidance: undefined, teamId: undefined }, { guidance: '上传行动', teamId: 1 }]);
    useBattleStore.getState().removeCombatant(filename);
    expect(useBattleStore.getState().combatants).toMatchObject([{ cardLibrarySelectionId: 'local:two' }]);
  });

  it.each(['source-id', 'source-event'])('旧引导/分队字符串 %s 不扩展成来源别名', (filename) => {
    useBattleStore.setState({ combatants: [
      { ...dataCombatant('cloud.json', '旧云角色'), sourceDataCardId: 'source-id', adjudicationSourceKey: 'source-event' },
      dataCombatant(filename, '上传角色'),
    ] });
    useBattleStore.getState().updateCombatantCharacterGuidance(filename, '上传行动');
    useBattleStore.getState().updateCombatantTeam(filename, 1);
    expect(useBattleStore.getState().combatants.map((item) => ({ guidance: 'data' in item ? item.characterGuidance : undefined, teamId: item.teamId })))
      .toEqual([{ guidance: undefined, teamId: undefined }, { guidance: '上传行动', teamId: 1 }]);
  });

  it('随机占位、移除与清空列表保持单人能力', () => {
    useBattleStore.setState({
      combatants: [dataCombatant('alpha.json', '阿尔法')],
      teams: [{ id: 1, name: '守护队', isCollapsed: false }],
    });
    renderList();

    act(() => button('+ 添加随机残兽').click());
    const identifiers = useBattleStore.getState().combatants.map((item) => 'id' in item ? item.id : item.filename);
    expect(identifiers[0]).toBe('alpha.json');
    expect(identifiers[1]).toMatch(/^random-canshou-/);

    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label="移除 阿尔法"]');
    if (!removeButton) throw new Error('remove button not found');
    act(() => removeButton.click());
    expect(useBattleStore.getState().combatants).toHaveLength(1);
    expect(useBattleStore.getState().combatants[0] && 'id' in useBattleStore.getState().combatants[0]!).toBe(true);

    act(() => button('清空列表').click());
    expect(useBattleStore.getState().combatants).toEqual([]);
    expect(useBattleStore.getState().teams).toEqual([]);
  });
});
