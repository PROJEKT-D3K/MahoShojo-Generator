// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicRankingData, PublicRankingItem, PublicRankingRequest } from '@mahoshojo/contracts/public-ranking';
import { ArenaRankingModalView, type ArenaRankingModalViewProps } from '../src/ranking/ArenaRankingModalView';
import { BaseModal } from '../src/modal/BaseModal';
import type { RankingLinkProps, RankingQueryHook, RankingQueryResult } from '../src/ranking/RankingPageView';

type QueryOptions = { request: PublicRankingRequest; enabled?: boolean; staleTime?: number };
let root: Root | null;
let container: HTMLDivElement;
let props: ArenaRankingModalViewProps;
let queries: QueryOptions[];
let items: PublicRankingItem[];
let rating: PublicRankingData<'entityRating'> | undefined;
let errors: Partial<Record<PublicRankingRequest['kind'], string>>;
let loading: Set<PublicRankingRequest['kind']>;
const makeItem = (entityId: string, patch: Partial<PublicRankingItem> = {}): PublicRankingItem => ({
  rank: 1, entityType: 'data_card', entityId, displayName: entityId, authorName: '作者',
  rating: 1300, games: 20, wins: 10, losses: 8, draws: 2, tier: '花牌',
  techScore: 55, techLevel: 'C', isNative: true, tagIds: [], ...patch,
});
const tags: PublicRankingData<'tags'> = { success: true, tags: [
  { id: 'tag-a', name: '有效标签', description: '标签说明', category: '分类', scope: 'user', isActive: true },
  { id: 'inactive', name: '停用标签', description: null, category: null, scope: 'user', isActive: false },
] };
const seasons: PublicRankingData<'seasons'> = { schemaVersion: 1, seasons: [
  { id: 's-test', name: '测试赛季', status: 'current', startsAt: '2026-10-01', description: '当前赛季' },
] };
const useRankingQuery: RankingQueryHook = <R extends PublicRankingRequest,>(options: { request: R; enabled?: boolean; staleTime?: number }): RankingQueryResult<PublicRankingData<R['kind']>> => {
  queries.push(options);
  const request = options.request;
  const data = request.kind === 'leaderboard' ? { success: true, items: items.map((item, index) => ({ ...item, rank: request.offset + index + 1 })) }
    : request.kind === 'tags' ? tags
      : request.kind === 'seasons' ? seasons
        : request.kind === 'entityRating' ? rating : undefined;
  return { data: data as PublicRankingData<R['kind']> | undefined, isLoading: loading.has(request.kind), isError: Boolean(errors[request.kind]), error: errors[request.kind], refetch: vi.fn() };
};
const Link = (linkProps: RankingLinkProps) => <a {...linkProps} data-host-link="true" />;
const render = (patch: Partial<ArenaRankingModalViewProps> = {}) => {
  props = { ...props, ...patch };
  act(() => root!.render(<ArenaRankingModalView {...props} />));
};
const query = <K extends PublicRankingRequest['kind'],>(kind: K) => [...queries].reverse().find((value) => value.request.kind === kind)! as QueryOptions & { request: Extract<PublicRankingRequest, { kind: K }> };
const button = (text: string) => [...container.querySelectorAll('button')].find((value) => value.textContent === text)!;
const checkbox = (text: string) => [...container.querySelectorAll('label')].find((value) => value.textContent?.includes(text))!.querySelector<HTMLInputElement>('input')!;
const field = <T extends HTMLInputElement | HTMLSelectElement>(text: string) => [...container.querySelectorAll('label')].find((value) => value.textContent?.trim().startsWith(text))!.querySelector<T>('input, select')!;
const click = (target: HTMLElement) => act(() => target.click());
const change = (target: HTMLInputElement | HTMLSelectElement, value: string) => act(() => {
  const prototype = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value);
  target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const row = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="查看角色详情：${name}"]`)?.closest('tr');
const selectionButton = (name: string) => row(name)!.lastElementChild!.querySelector('button')!;
const flush = async () => act(async () => { await Promise.resolve(); });
const deferred = () => {
  let resolve!: (result?: void | false) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void | false>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queries = []; items = [makeItem('角色一')]; rating = undefined; errors = {}; loading = new Set();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = { isOpen: true, onClose: vi.fn(), useRankingQuery, Link, rankableRosterEntities: [],
    selectedEntityKeys: new Set(), selectionCountLabel: '0 / 20', onToggleEntity: vi.fn(async () => {}), onSelectionError: vi.fn() };
});
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container.remove(); });

describe('quick ranking presentation and reads', () => {
  it('retains the quick modal, season, table, Top300 copy, count and host link', () => {
    render();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('排位排行榜（可加入参战）');
    for (const copy of ['当前赛季：', '测试赛季', 'Top300', '未入榜角色不展示名次', '点击“加入参战”', '仅预筛当前页的分差', '最终计分仍由服务器判定', '已选择参战者：0 / 20']) expect(container.textContent).toContain(copy);
    expect([...container.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['#', '角色', '段位', '分', '局', 'W/L/D', '技术', '原生', '操作']);
    expect(container.querySelector('.md\\:grid-cols-6')).not.toBeNull();
    expect(container.querySelector('a[data-host-link]')?.getAttribute('href')).toBe('/ranking');
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(query('leaderboard')).toMatchObject({ enabled: true, staleTime: 10_000, request: { limit: 30, offset: 0 } });
    expect(query('tags')).toMatchObject({ enabled: true, staleTime: 60_000 });
    expect(query('seasons')).toMatchObject({ enabled: true, staleTime: 60_000 });
    expect(query('entityRating')).toMatchObject({ enabled: false, staleTime: 30_000 });
    expect(button('应用筛选')).toBeUndefined();
  });

  it('applies filters immediately and resets pagination, including tag include/exclude', () => {
    items = Array.from({ length: 30 }, (_, index) => makeItem(`角色${index}`));
    render(); click(button('下一页'));
    expect(query('leaderboard').request.offset).toBe(30);
    change(field('最低分'), '800');
    expect(query('leaderboard').request).toMatchObject({ offset: 0, filters: { minRating: 800 } });
    change(field('排序'), 'tech'); change(field('原生性'), '0');
    expect(query('leaderboard').request.filters).toMatchObject({ sort: 'tech', isNative: '0', order: 'desc' });
    click(checkbox('包含预设')); click(button('展开标签'));
    const tagButtons = [...container.querySelectorAll('button')].filter((value) => value.textContent === '有效标签');
    click(tagButtons[0]!); click(tagButtons[1]!);
    expect(query('leaderboard').request.filters).toMatchObject({ includePresets: false, includeTagIds: ['tag-a'], excludeTagIds: ['tag-a'] });
    expect(container.textContent).not.toContain('停用标签');
    click(button('收起标签')); click(button('清空标签'));
    expect(query('leaderboard').request.filters).toMatchObject({ includeTagIds: [], excludeTagIds: [] });
    change(field('天梯'), 'free');
    expect(query('leaderboard').request.filters.queue).toBe('free');
  });

  it('pages in thirties and stops before a request beyond Top300', () => {
    items = Array.from({ length: 30 }, (_, index) => makeItem(`角色${index}`));
    render(); expect(button('上一页').disabled).toBe(true);
    for (let offset = 30; offset <= 270; offset += 30) {
      click(button('下一页')); expect(query('leaderboard').request.offset).toBe(offset);
    }
    expect(button('下一页').disabled).toBe(true);
    click(button('下一页')); expect(query('leaderboard').request.offset).toBe(270);
    click(button('上一页')); expect(query('leaderboard').request.offset).toBe(240);
    items = items.slice(0, 29); render(); expect(button('下一页').disabled).toBe(true);
  });

  it('stops every query when closed and preserves loading/error/empty feedback', () => {
    render({ isOpen: false });
    expect(container.textContent).toBe('');
    for (const kind of ['tags', 'seasons', 'leaderboard', 'entityRating'] as const) expect(query(kind).enabled).toBe(false);
    loading.add('leaderboard'); render({ isOpen: true }); expect(container.textContent).toContain('正在加载排行榜');
    loading.clear(); errors.leaderboard = '离线'; render(); expect(container.textContent).toContain('加载失败：离线');
    errors = {}; items = []; render(); expect(container.textContent).toContain('暂无数据');
  });

  it('delegates details and cache to the host without using the cache as pivot authority', () => {
    const onOpenEntityDetails = vi.fn();
    const cache = { isCanonicalQuery: vi.fn(() => true), getRank: vi.fn(() => 1), onLiveItems: vi.fn() };
    render({ onOpenEntityDetails, cache, selectedEntityKeys: new Set(['data_card:角色一']) });
    click(container.querySelector<HTMLButtonElement>('[aria-label="查看角色详情：角色一"]')!);
    expect(onOpenEntityDetails).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'data_card', entityId: '角色一', displayName: '角色一', pendingNotice: expect.stringContaining('当前榜单：#1') }));
    expect(cache.onLiveItems).toHaveBeenCalledWith(expect.objectContaining({ queue: 'strict', maxRankSeen: 1 }));
    expect(cache.getRank).not.toHaveBeenCalled();
    expect(checkbox('严格分差预筛').disabled).toBe(true);
    cache.onLiveItems.mockClear(); cache.isCanonicalQuery.mockReturnValue(false); change(field('最低分'), '800');
    expect(cache.onLiveItems).not.toHaveBeenCalled();
    render({ canOpenEntityDetails: () => false });
    expect(container.querySelector<HTMLButtonElement>('[aria-label="查看角色详情：角色一"]')!.disabled).toBe(true);
  });
});

describe('strict current-page prefilter', () => {
  it('uses the shared low-games limit, hides the pivot and exempts presets', () => {
    items = [makeItem('我方'), makeItem('低局边界', { rating: 900, games: 5 }), makeItem('低局超出', { rating: 899, games: 5 }),
      makeItem('足局可选', { rating: 800, games: 20 }), makeItem('预设例外', { entityType: 'preset', rating: 100, games: 1 })];
    render({ rankableRosterEntities: [{ entityType: 'data_card', entityId: '我方' }] });
    click(checkbox('严格分差预筛'));
    expect(row('我方')).toBeUndefined(); expect(row('低局超出')).toBeUndefined();
    expect(row('低局边界')).toBeTruthy(); expect(row('足局可选')).toBeTruthy(); expect(row('预设例外')).toBeTruthy();
    expect(query('entityRating').enabled).toBe(false);
    expect(checkbox('严格分差预筛').closest('label')?.title).toContain('任一方不足 10 局时上限为 400');
  });

  it('reads only a missing data-card pivot after prefilter is enabled', () => {
    rating = { success: true, entityType: 'data_card', entityId: '我方', queue: 'strict', found: true, rating: 1300, games: 20 };
    items = [makeItem('超出', { rating: 899, games: 1 }), makeItem('边界', { rating: 900, games: 1 })];
    render({ rankableRosterEntities: [{ entityType: 'data_card', entityId: '我方' }] });
    expect(query('entityRating').enabled).toBe(false);
    click(checkbox('严格分差预筛'));
    expect(query('entityRating')).toMatchObject({ enabled: true, staleTime: 30_000, request: { kind: 'entityRating', entityType: 'data_card', entityId: '我方' } });
    expect(row('超出')).toBeUndefined(); expect(row('边界')).toBeTruthy();
    render({ rankableRosterEntities: [{ entityType: 'data_card', entityId: '另一个我方' }] });
    expect(row('超出')).toBeTruthy();
    change(field('天梯'), 'free');
    expect(query('entityRating').enabled).toBe(false); expect(checkbox('严格分差预筛').checked).toBe(false);
  });

  it('never reads preset ratings and cannot infer a pivot from selected UI keys', () => {
    items = [makeItem('预设我方', { entityType: 'preset' }), makeItem('远分', { rating: 1, games: 1 })];
    render({ selectedEntityKeys: new Set(['preset:预设我方']) });
    expect(checkbox('严格分差预筛').disabled).toBe(true);
    render({ rankableRosterEntities: [{ entityType: 'preset', entityId: '预设我方' }] });
    click(checkbox('严格分差预筛'));
    expect(row('预设我方')).toBeUndefined(); expect(row('远分')).toBeTruthy();
    expect(queries.filter((value) => value.request.kind === 'entityRating' && value.enabled)).toEqual([]);
    render({ rankableRosterEntities: [{ entityType: 'preset', entityId: '预设我方' }, { entityType: 'data_card', entityId: '远分' }] });
    expect(checkbox('严格分差预筛').disabled).toBe(true); expect(checkbox('严格分差预筛').checked).toBe(false);
  });

  it('explains unavailable pivot ratings and leaves candidates visible without fabricating scores', () => {
    items = [makeItem('候选', { rating: 1, games: 1 })]; loading.add('entityRating');
    render({ rankableRosterEntities: [{ entityType: 'data_card', entityId: '我方' }] }); click(checkbox('严格分差预筛'));
    expect(container.textContent).toContain('正在读取我方排位分'); expect(row('候选')).toBeTruthy();
    loading.clear(); errors.entityRating = '网络中断'; render();
    expect(container.textContent).toContain('无法读取我方排位分，已降级为不筛选严格范围：网络中断'); expect(row('候选')).toBeTruthy();
  });
});

describe('host-owned selection lifecycle', () => {
  it('adds with an abort signal and reflects only the host selection, never optimistic success', async () => {
    render(); click(selectionButton('角色一')); await flush();
    expect(props.onToggleEntity).toHaveBeenCalledWith(expect.objectContaining({ entityId: '角色一' }), true, expect.any(AbortSignal));
    expect(selectionButton('角色一').textContent).toBe('加入参战');
    expect(props.onSelectionError).not.toHaveBeenCalled();
    render({ selectedEntityKeys: new Set(['data_card:角色一']) }); expect(selectionButton('角色一').textContent).toBe('移除/已加入');
  });

  it.each(['data_card', 'preset'] as const)('allows %s removal even when the roster is full or source unavailable', async (entityType) => {
    items = [makeItem('角色一', { entityType })];
    render({ selectedEntityKeys: new Set([`${entityType}:角色一`]), selectionCountLabel: '20 / 20', getEntityUnavailableReason: () => '已达人数上限' });
    expect(selectionButton('角色一').disabled).toBe(false);
    click(selectionButton('角色一')); await flush();
    expect(props.onToggleEntity).toHaveBeenCalledWith(expect.objectContaining({ entityType }), false, expect.any(AbortSignal));
  });

  it('blocks both addition and removal for the host busy guard without cancelling its own pending admission', async () => {
    const operation = deferred(); const toggle = vi.fn((_item: PublicRankingItem, _selected: boolean, _signal: AbortSignal) => operation.promise);
    items.push(makeItem('已选角色'));
    render({ selectedEntityKeys: new Set(['data_card:已选角色']), onToggleEntity: toggle });
    click(selectionButton('角色一'));
    const signal = toggle.mock.calls[0]![2];
    render({ selectionDisabledReason: '正在生成或恢复，请稍后调整参战者' });
    expect(signal.aborted).toBe(false);
    await act(async () => operation.resolve());
    for (const name of ['角色一', '已选角色']) {
      expect(selectionButton(name).disabled).toBe(true);
      expect(selectionButton(name).title).toBe('正在生成或恢复，请稍后调整参战者');
      click(selectionButton(name));
    }
    expect(toggle).toHaveBeenCalledTimes(1);
    render({ selectionDisabledReason: null });
    expect(selectionButton('角色一').disabled).toBe(false); expect(selectionButton('已选角色').disabled).toBe(false);
  });

  it('displays source unavailability and blocks additions without blocking details', () => {
    items = [makeItem('未打包预设', { entityType: 'preset' })];
    render({ getEntityUnavailableReason: () => '此预设未包含在当前客户端中', onOpenEntityDetails: vi.fn() });
    expect(selectionButton('未打包预设').disabled).toBe(true);
    expect(selectionButton('未打包预设').title).toBe('此预设未包含在当前客户端中');
    expect(row('未打包预设')?.textContent).toContain('此预设未包含在当前客户端中');
    click(selectionButton('未打包预设')); expect(props.onToggleEntity).not.toHaveBeenCalled();
    expect(row('未打包预设')?.querySelector<HTMLButtonElement>('[aria-label]')?.disabled).toBe(false);
  });

  it('serializes repeated clicks and releases busy state after settlement', async () => {
    const operation = deferred(); const toggle = vi.fn(() => operation.promise);
    items.push(makeItem('角色二')); render({ onToggleEntity: toggle });
    const first = selectionButton('角色一');
    act(() => { first.click(); first.click(); });
    expect(toggle).toHaveBeenCalledTimes(1); expect(first.textContent).toBe('处理中...');
    expect(selectionButton('角色二').disabled).toBe(true);
    await act(async () => operation.resolve());
    expect(first.disabled).toBe(false); expect(selectionButton('角色二').disabled).toBe(false);
  });

  it('shows thrown failures, allows retry and treats false as rejected rather than successful', async () => {
    const toggle = vi.fn().mockRejectedValueOnce(new Error('无法读取数据卡')).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
    render({ onToggleEntity: toggle }); click(selectionButton('角色一')); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('❌ 加入参战失败：无法读取数据卡');
    expect(props.onSelectionError).toHaveBeenCalledWith('❌ 加入参战失败：无法读取数据卡');
    vi.mocked(props.onSelectionError!).mockClear(); click(selectionButton('角色一')); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('未能加入参战');
    expect(props.onSelectionError).not.toHaveBeenCalled(); expect(selectionButton('角色一').textContent).toBe('加入参战');
    click(selectionButton('角色一')); await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull(); expect(props.onSelectionError).not.toHaveBeenCalled();
  });

  it.each(['close', 'hidden', 'unmount'] as const)('aborts on %s and ignores a late failure', async (exit) => {
    const operation = deferred(); const toggle = vi.fn((_item: PublicRankingItem, _selected: boolean, _signal: AbortSignal) => operation.promise);
    render({ onToggleEntity: toggle }); click(selectionButton('角色一'));
    const signal = toggle.mock.calls[0]![2];
    if (exit === 'close') click(button('关闭'));
    else if (exit === 'hidden') render({ isOpen: false });
    else { act(() => root!.unmount()); root = null; }
    expect(signal.aborted).toBe(true);
    await act(async () => operation.reject(new Error('迟到错误')));
    expect(props.onSelectionError).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('迟到错误');
    if (exit === 'hidden') { render({ isOpen: true }); expect(selectionButton('角色一').disabled).toBe(false); }
  });

  it('fences a late success after close/reopen without clearing a newer operation', async () => {
    const oldOperation = deferred(), newOperation = deferred();
    const toggle = vi.fn().mockReturnValueOnce(oldOperation.promise).mockReturnValueOnce(newOperation.promise);
    render({ onToggleEntity: toggle }); click(selectionButton('角色一')); render({ isOpen: false }); render({ isOpen: true });
    click(selectionButton('角色一')); await act(async () => oldOperation.resolve());
    expect(selectionButton('角色一').textContent).toBe('处理中...'); expect(props.onSelectionError).not.toHaveBeenCalled();
    await act(async () => newOperation.resolve()); expect(selectionButton('角色一').disabled).toBe(false);
    expect(props.onSelectionError).not.toHaveBeenCalled();
  });
});


it('shares Escape and focus ownership with nested host details, then restores the original opener', () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  const onOuterClose = vi.fn(), onDetailsClose = vi.fn();
  function Host() {
    const [open, setOpen] = useState(true), [detailsOpen, setDetailsOpen] = useState(false);
    return <>
      <ArenaRankingModalView {...props} isOpen={open} onClose={() => { onOuterClose(); setOpen(false); }}
        onOpenEntityDetails={() => setDetailsOpen(true)} />
      <BaseModal isOpen={detailsOpen} title="宿主角色详情" onClose={() => { onDetailsClose(); setDetailsOpen(false); }}>
        <button>详情动作</button>
      </BaseModal>
    </>;
  }
  act(() => root!.render(<Host />));
  expect(document.activeElement).toBe(button('关闭'));
  const detailsOpener = container.querySelector<HTMLButtonElement>('[aria-label="查看角色详情：角色一"]')!;
  detailsOpener.focus(); click(detailsOpener);
  const dialogs = document.querySelectorAll('[role="dialog"]'); expect(dialogs).toHaveLength(2);
  const details = dialogs[1]!; expect(details.contains(document.activeElement)).toBe(true);
  const last = [...details.querySelectorAll<HTMLButtonElement>('button')].at(-1)!; last.focus();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(details.querySelector('button'));
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(onDetailsClose).toHaveBeenCalledTimes(1); expect(onOuterClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(detailsOpener); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(onOuterClose).toHaveBeenCalledTimes(1); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener); opener.remove();
});
