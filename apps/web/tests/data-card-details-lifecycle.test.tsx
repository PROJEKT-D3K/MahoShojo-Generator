// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardDetailsSource } from '@mahoshojo/ui-web/card-details';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/public-card-cache/shared-loader', () => ({ getPublicCardByIdWithSharedCache: mocks.read }));
vi.mock('@/lib/auth', () => ({ authStorage: { getAuthHeader: async () => null, buildAuthenticatedRequestInit: async (init: RequestInit) => init } }));
vi.mock('@/lib/arena/rank-cache', () => ({ upsertArenaRankCacheFromMeta: vi.fn() }));
import DataCardDetailsModal from '@/components/DataCardDetailsModal';
import { LeaderboardEntityDetailsModal } from '@/components/ranking/LeaderboardEntityDetailsModal';
let root: Root; let container: HTMLDivElement;
const date = '2026-10-01T00:00:00Z';
const card = { id: '00000000-0000-4000-8000-000000000001', name: '卡A', description: '简介', type: 'character' as const, data: '{"name":"完整正文","signature":"旧签名"}', isPublic: true, updatedAt: date };
const meta = (id = card.id, updatedAt = date, isStale = false) => ({ success: true, dataCardId: id, tags: [], metrics: { techScore: 123, techLevel: 'A', isNative: true, dataCardUpdatedAt: updatedAt, isStale }, ratings: { strict: null, free: null } });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const render = (source: CardDetailsSource = { kind: 'public' }, value = card, isOpen = true) => act(async () => root.render(<DataCardDetailsModal isOpen={isOpen} onClose={() => {}} card={value} source={source} />));
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.read.mockReset();
  window.localStorage.setItem('mahoshojo.data-card-details.meta-expanded.v1', '1');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('data-card-meta') ? meta() : { canReport: true, reasons: [] })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe('Web 原详情实际消费 shared，宿主 metadata 有版本与生命周期围栏', () => {
  it.each([{ kind: 'local', label: '当前输入副本' }, { kind: 'cache', lastSuccessAt: date }, { kind: 'preset' }] satisfies CardDetailsSource[])('显式 %j 即使保留云 ID/时间/signature 也不联网或声称原生', async (source) => {
    await render(source); expect(fetch).not.toHaveBeenCalled(); expect(container.textContent).toContain('本机未验证'); expect(container.textContent).toContain('完整正文'); expect(container.textContent).not.toContain('服务器判断）：是'); expect(container.textContent).not.toContain('更多');
  });
  it('预设保持宿主的排位历史入口，只有点击才读取历史且不查 metadata', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ success: true, items: [] }));
    await act(async () => root.render(<DataCardDetailsModal isOpen onClose={() => {}} card={card} source={{ kind: 'preset' }} ratingHistoryEntity={{ entityType: 'preset', entityId: 'preset.json' }} />));
    expect(fetch).not.toHaveBeenCalled();
    const history = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '最近严格排位')!;
    await act(async () => history.click()); expect(fetch).toHaveBeenCalledWith('/api/arena/entity-rating-history?entityType=preset&entityId=preset.json', expect.anything());
  });
  it('本地保存 callback 的失败显示在 Web 详情内', async () => {
    await act(async () => root.render(<DataCardDetailsModal isOpen onClose={() => {}} card={card} source={{ kind: 'cache', lastSuccessAt: date }} onSaveCopyToLocalLibrary={async () => { throw new Error('本地副本写入失败'); }} />));
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === '存到本地库')!;
    await act(async () => save.click()); expect(container.querySelector('[role="alert"]')?.textContent).toContain('本地副本写入失败');
  });
  it('只有 ID/时间一致且不 stale 的在线原件才展示服务器判断', async () => {
    await render(); expect(container.textContent).toContain('原生（服务器判断）：是'); expect(container.textContent).toContain('123（A）');
  });
  it.each(['new-version', 'stale', 'wrong-id'] as const)('%s 的 metadata 不绑定这份正文', async (reason) => {
    vi.mocked(fetch).mockImplementation(async (url) => response(String(url).includes('data-card-meta') ? meta(reason === 'wrong-id' ? 'another-card' : card.id, reason === 'new-version' ? '2026-10-02T00:00:00Z' : date, reason === 'stale') : { canReport: false, reasons: [] }));
    await render(); expect(container.textContent).not.toContain('服务器判断）：是'); expect(container.textContent).not.toContain('123（A）');
  });
  it('Web 榜单真实 loading→切卡→详情→Escape 隔离晚正文并还原入口焦点', async () => {
    const old = deferred<{ card: unknown; source: string }>();
    const current = deferred<{ card: unknown; source: string }>();
    mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    let open = false; let id = 'web-a';
    const mount = () => root.render(<><button id="web-opener">打开榜单详情</button><LeaderboardEntityDetailsModal isOpen={open} entity={{ entityType: 'data_card', entityId: id, displayName: id }} onClose={() => { open = false; mount(); }} /></>);
    await act(async () => mount()); container.querySelector<HTMLButtonElement>('#web-opener')!.focus();
    open = true; await act(async () => mount()); expect(document.body.textContent).toContain('正在加载角色详情');
    id = 'web-b'; await act(async () => mount());
    await act(async () => current.resolve({ card: { ...card, id, name: '新版B正文' }, source: 'network' }));
    await act(async () => old.resolve({ card: { ...card, id: 'web-a', name: '迟到A正文' }, source: 'network' }));
    expect(document.body.textContent).toContain('新版B正文'); expect(document.body.textContent).not.toContain('迟到A正文');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement?.id).toBe('web-opener');
  });
  it('A→B 同一更新时间仍拒绝 A 晚响应，关闭后结果不复活', async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    vi.mocked(fetch).mockImplementation((url) => String(url).includes('data-card-meta') ? (String(url).includes(card.id) ? a.promise : b.promise) : Promise.resolve(response({ canReport: false, reasons: [] })));
    await render(); const next = { ...card, id: '00000000-0000-4000-8000-000000000002', name: '卡B' }; await render({ kind: 'public' }, next);
    await act(async () => a.resolve(response(meta()))); expect(container.textContent).not.toContain('123（A）');
    await render({ kind: 'public' }, next, false); await act(async () => b.resolve(response(meta(next.id)))); expect(container.textContent).toBe('');
  });
});
