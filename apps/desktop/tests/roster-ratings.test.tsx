// @vitest-environment jsdom
import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as techIndex from '@mahoshojo/domain/metrics/tech-index';
import { buildDesktopRosterExtras } from '../src/features/arena/roster-presentation';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { useDesktopRosterRatings, projectRosterRatingTargets } from '../src/features/arena/use-roster-ratings';
import type { ArenaDraft } from '../src/features/arena/session';

type Card = Extract<ArenaDraft['combatants'][number], { data: unknown }>;
type Reader = NonNullable<Parameters<typeof useDesktopRosterRatings>[3]>;
const card = (id: string): Card => ({ type: 'general-character', filename: `${id}.json`, data: { name: id, content: '所选正文' }, isValid: false, isPreset: false, desktopSource: 'online', sourceDataCardId: id, cardLibrarySelectionId: `cloud:${id}` });
const reply = (request: Parameters<Reader>[0], rating = 1200, found = true) => ({ success: true as const, entityType: request.entityType, entityId: request.entityId, queue: request.queue, found, rating, games: found ? 2 : 0 });
let root: Root, container: HTMLDivElement;
let output: ReturnType<typeof useDesktopRosterRatings>;
let renders: ReturnType<typeof useDesktopRosterRatings>[];
const Probe = ({ cards, scope = 'owner-a:direct:classic', enabled = true, read }: { cards: readonly Card[]; scope?: string; enabled?: boolean; read: Reader }) => {
  output = useDesktopRosterRatings(cards, scope, enabled, read); renders.push(output); return <pre>{JSON.stringify(output)}</pre>;
};
beforeEach(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); renders = []; });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const render = async (props: Parameters<typeof Probe>[0]) => { await act(async () => root.render(<Probe {...props} />)); };

describe('当前已选角色只读评分', () => {
  it('无关 phase 更新保持投影引用和技术值计算次数，正文与评分变化仍重算', async () => {
    const tech = vi.spyOn(techIndex, 'computeTechIndex');
    const pending: (() => void)[] = [];
    const read = vi.fn<Reader>(request => new Promise(resolve => pending.push(() => resolve({ ...reply(request, 1555), tier: '女王' }))));
    const cards = [card('a')];
    const PresentationProbe = ({ cards, phase }: { cards: readonly Card[]; phase: string }) => {
      const observations = useDesktopRosterRatings(cards, 'stable-owner', true, read);
      useMemo(() => cards.map((value, index) => buildDesktopRosterExtras(value, () => {}, undefined, observations[index])), [cards, observations]);
      output = observations;
      return <span>{phase}</span>;
    };
    await act(async () => root.render(<PresentationProbe cards={cards} phase="idle" />));
    const before = tech.mock.calls.length; const initialOutput = output;
    expect(before).toBeGreaterThan(0);
    await act(async () => root.render(<PresentationProbe cards={cards} phase="streaming" />));
    expect(output).toBe(initialOutput); expect(tech).toHaveBeenCalledTimes(before);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(output[0]?.rating?.strict).toBe(1555);
    expect(output[0]?.rating?.tiers).toEqual({ strict: '女王', free: '女王' });
    expect(tech.mock.calls.length).toBeGreaterThan(before);
    const afterRating = tech.mock.calls.length;
    await act(async () => root.render(<PresentationProbe cards={cards} phase="completed" />));
    expect(tech).toHaveBeenCalledTimes(afterRating);
    const changed = [{ ...card('a'), data: { name: 'a', content: '修改后的正文' } }];
    await act(async () => root.render(<PresentationProbe cards={changed} phase="completed" />));
    expect(output[0]?.rating).toBeNull(); expect(tech.mock.calls.length).toBeGreaterThan(afterRating);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
  });

  it('消费可选双队列段位；旧服务缺字段仍保留评分/预测，found=false 不制造段位', async () => {
    const read = vi.fn<Reader>(async request => ({ ...reply(request, 1600), tier: request.queue === 'strict' ? '女王' : '花牌' }));
    await render({ cards: [card('a'), card('b')], read });
    expect(output[0]?.rating?.tiers).toEqual({ strict: '女王', free: '花牌' });
    expect(output[0]?.prediction?.expectedPct).toBe(50);
    const oldRead = vi.fn<Reader>(async request => reply(request, 1600));
    await render({ cards: [card('a'), card('b')], scope: 'old-api', read: oldRead });
    expect(output[0]?.rating).toMatchObject({ strict: 1600, free: 1600, tiers: { strict: null, free: null }, failed: false });
    expect(output[0]?.prediction?.expectedPct).toBe(50);
    const missingRead = vi.fn<Reader>(async request => ({ ...reply(request, 1000, false), tier: '无牌' }));
    await render({ cards: [card('a')], scope: 'missing', read: missingRead });
    expect(output[0]?.rating).toEqual({ strict: null, free: null, failed: false, tiers: { strict: null, free: null } });
  });

  it('双队列查询并共源预测，不把服务初始分当已存在评分', async () => {
    const read = vi.fn<Reader>(async request => reply(request, request.entityId === 'a' ? 1200 : 1000, !(request.queue === 'strict' && request.entityId === 'a')));
    await render({ cards: [card('a'), card('b')], read });
    expect(read).toHaveBeenCalledTimes(4);
    expect(output[0]?.rating).toMatchObject({ strict: null, free: 1200 });
    expect(output.map(row => [row.prediction?.queue, row.prediction?.expectedPct])).toEqual([['free', 76], ['free', 24]]);
  });
  it('本地、缓存、恢复或伪造正文身份不发请求；已知内置预设才可读取', async () => {
    const read = vi.fn<Reader>(async request => reply(request));
    const local = { ...card('spoof'), desktopSource: undefined, data: { sourceDataCardId: 'spoof', signature: 'fake' } };
    const preset = { ...local, isPreset: true, filename: PRESET_LIST[0]!.filename };
    await render({ cards: [local, preset], read });
    expect(read).not.toHaveBeenCalled(); expect(output.every(row => !row.hasSource && row.prediction === null)).toBe(true);
    await render({ cards: [{ ...preset, desktopSource: 'preset' }], read });
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[0]?.[0].entityType).toBe('preset');
    expect(projectRosterRatingTargets([{ ...preset, desktopSource: 'preset', filename: 'not-packaged.json' }])).toEqual([null]);
  });
  it('当前实体去重、同正文克隆不重发；移除后不保留缓存', async () => {
    const read = vi.fn<Reader>(async request => reply(request)); const a = card('a');
    await render({ cards: [a, a], read }); expect(read).toHaveBeenCalledTimes(2);
    await render({ cards: structuredClone([a, a]), read }); expect(read).toHaveBeenCalledTimes(2);
    await render({ cards: [], read }); await render({ cards: [a], read }); expect(read).toHaveBeenCalledTimes(4);
  });
  it('缓存只在再次需要读取时过期，没有计时器轮询', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const read = vi.fn<Reader>(async request => reply(request));
    await render({ cards: [card('a')], read }); expect(read).toHaveBeenCalledTimes(2);
    now += 61_000;
    await render({ cards: [card('a')], read }); expect(read).toHaveBeenCalledTimes(2);
    await render({ cards: [card('a'), card('b')], read }); expect(read).toHaveBeenCalledTimes(6);
    await render({ cards: [card('a')], read }); expect(read).toHaveBeenCalledTimes(6);
  });
  it('scope、禁用和正文变化在渲染当帧拒旧数据，迟到响应不能复活', async () => {
    const pending: (() => void)[] = [];
    const read = vi.fn<Reader>((request) => new Promise(resolve => pending.push(() => resolve(reply(request, 1888)))));
    await render({ cards: [card('a')], read }); expect(read).toHaveBeenCalledTimes(2);
    renders.length = 0;
    await render({ cards: [card('a')], scope: 'owner-b:hosted:daily', enabled: false, read });
    expect(renders.every(rows => rows.every(row => row.rating === null && row.prediction === null))).toBe(true);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(output[0]?.rating).toBeNull();
    const changed = { ...card('a'), data: { name: 'a', content: '不同正文' } };
    await render({ cards: [changed], scope: 'owner-b:hosted:daily', read }); expect(read).toHaveBeenCalledTimes(4);
    expect(output[0]?.rating).toBeNull();
    await act(async () => pending.splice(0).forEach(resolve => resolve())); expect(output[0]?.rating?.strict).toBe(1888);
    renders.length = 0; await render({ cards: [card('a')], scope: 'owner-b:hosted:daily', read });
    expect(renders[0]?.[0]?.rating).toBeNull();
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
  });
  it('已有评分从 A 经禁用 B 回到 A 时，首帧不能复活旧 A', async () => {
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    let delayed = false; const pending: (() => void)[] = [];
    const read = vi.fn<Reader>(request => delayed
      ? new Promise(resolve => pending.push(() => resolve(reply(request, 1500))))
      : Promise.resolve(reply(request, 1200)));
    const cards = [card('a')];
    await render({ cards, scope: 'A', read }); expect(output[0]?.rating?.strict).toBe(1200);
    await render({ cards, scope: 'B', enabled: false, read });
    now += 61_000; delayed = true; renders.length = 0;
    await render({ cards, scope: 'A', read });
    expect(renders[0]?.[0]?.rating).toBeNull(); expect(output[0]?.rating).toBeNull();
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(output[0]?.rating?.strict).toBe(1500); expect(read).toHaveBeenCalledTimes(4);
  });
  it('原生 IPC 不可取消时，切换 scope 也不突破四个在飞槽', async () => {
    let active = 0, maximum = 0; const pending: (() => void)[] = [];
    const read = vi.fn<Reader>(request => new Promise(resolve => {
      maximum = Math.max(maximum, ++active);
      pending.push(() => { active--; resolve(reply(request)); });
    }));
    const cards = [card('a'), card('b')];
    await render({ cards, read }); expect(read).toHaveBeenCalledTimes(4);
    for (const scope of ['intermediate:direct', 'another:hosted', 'new-owner:hosted']) {
      await render({ cards, scope, read }); expect(read).toHaveBeenCalledTimes(4);
    }
    expect(output.every(row => row.rating === null)).toBe(true);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(read).toHaveBeenCalledTimes(8); expect(maximum).toBe(4);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(output[0]?.rating?.strict).toBe(1200);
  });
  it('最多四个并发请求，无来源预算外扫描；失败不填假分数', async () => {
    let active = 0, maximum = 0; const pending: (() => void)[] = [];
    const read = vi.fn<Reader>((request) => new Promise((resolve, reject) => {
      maximum = Math.max(maximum, ++active);
      pending.push(() => { active--; if (request.entityId === 'b') reject(new Error('offline')); else resolve(reply(request)); });
    }));
    await render({ cards: ['a', 'b', 'c'].map(card), read }); expect(read).toHaveBeenCalledTimes(4);
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    await act(async () => pending.splice(0).forEach(resolve => resolve()));
    expect(maximum).toBe(4); expect(read).toHaveBeenCalledTimes(6); expect(output[1]?.rating).toEqual({ strict: null, free: null, failed: true, tiers: { strict: null, free: null } });
    await render({ cards: Array.from({ length: 33 }, (_, index) => card(String(index))), read }); expect(read).toHaveBeenCalledTimes(6);
  });
});
