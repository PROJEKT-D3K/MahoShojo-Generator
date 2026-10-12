// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/public-ranking.json';
import { PublicRankingRequestSchema, PUBLIC_RANKING_BODY_BUDGETS } from '@mahoshojo/contracts/public-ranking';
vi.mock('next/link', () => ({ default: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props} /> }));
vi.mock('@/components/ranking/LeaderboardEntityDetailsModal', () => ({ LeaderboardEntityDetailsModal: ({ entity }: { entity: { displayName: string } | null }) => entity ? <div role="dialog">详情：{entity.displayName}</div> : null }));
import { RankingPage, readWebRanking } from '@/components/ranking/RankingPage';
let root: Root; let container: HTMLDivElement; let client: QueryClient;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fetcher = vi.fn();
const render = () => act(async () => { root.render(<QueryClientProvider client={client}><RankingPage /></QueryClientProvider>); await new Promise((resolve) => setTimeout(resolve, 20)); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const button = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)!;
const search = async () => {
  await act(async () => { const input = container.querySelector<HTMLInputElement>('[aria-label="排行榜搜索"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '角色'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('搜索').click());
};
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetcher.mockReset(); fetcher.mockImplementation(async (path: string) => respond(path.startsWith('/api/arena/leaderboard/search') ? { success: true, items: [{ ...fixture.responses.search.items[0], entityId: 'search-only' }] } : path.startsWith('/api/arena/leaderboard') ? fixture.responses.leaderboard : path === '/api/tags' ? fixture.responses.tags : path === '/config/seasons.json' ? fixture.responses.seasons : fixture.responses.archive));
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

describe('Web actual shared ranking host', () => {
  it('renders the same browser and retains existing real entity detail action for rank-zero search', async () => {
    await render(); await settle(); expect(container.textContent).toContain('合成排行角色');
    await search(); expect(container.textContent).toContain('#—'); expect(container.textContent).not.toContain('#0');
    const result = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('#—'))!;
    await act(async () => result.click()); expect(container.querySelector('[role="dialog"]')?.textContent).toContain('合成排行角色');
    for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  });
  it('fences old live search when season metadata changes current to history without user interaction', async () => {
    await render(); await settle(); const old = deferred<Response>();
    fetcher.mockImplementation(async (path: string) => path.startsWith('/api/arena/leaderboard/search') ? old.promise : respond({ ...fixture.responses.archive, season: { ...fixture.responses.archive.season, id: 'S4' } }));
    await search();
    await act(async () => { client.setQueryData(['seasonsConfig', { kind: 'seasons' }], { ...fixture.responses.seasons, seasons: fixture.responses.seasons.seasons.map((season) => ({ ...season, status: 'history' })) }); });
    await settle(); expect(container.textContent).toContain('归档排行角色');
    await act(async () => old.resolve(respond({ success: true, items: [{ ...fixture.responses.search.items[0], displayName: '迟到搜索不可见' }] })));
    expect(container.textContent).not.toContain('迟到搜索不可见');
  });
  it('isolates a late live leaderboard after applying another queue with the actual query host', async () => {
    const old = deferred<Response>(); let first = true;
    fetcher.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/arena/leaderboard')) {
        if (first) { first = false; return old.promise; }
        return respond({ success: true, items: [{ ...fixture.responses.leaderboard.items[0], displayName: '新自由列表' }] });
      }
      return respond(path === '/api/tags' ? fixture.responses.tags : fixture.responses.seasons);
    });
    await render(); await settle();
    await act(async () => { const queue = container.querySelectorAll('select')[1]!; queue.value = 'free'; queue.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => button('应用筛选').click()); await settle(); expect(container.textContent).toContain('新自由列表');
    await act(async () => old.resolve(respond({ success: true, items: [{ ...fixture.responses.leaderboard.items[0], displayName: '迟到旧排行榜' }] }))); await settle();
    expect(container.textContent).toContain('新自由列表'); expect(container.textContent).not.toContain('迟到旧排行榜');
  });
  it('does not write archive ranks into the Web live rank cache', async () => {
    await render(); await settle(); const before = localStorage.getItem('mahoshojo.arena.rank-cache.v1'); expect(before).not.toBeNull();
    fetcher.mockImplementation(async () => respond({ ...fixture.responses.archive, entities: [{ ...fixture.responses.archive.entities[0], entityId: 'archive-only' }] }));
    await act(async () => { const select = container.querySelector('select')!; select.value = 'S3'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
    expect(container.textContent).toContain('归档排行角色'); expect(localStorage.getItem('mahoshojo.arena.rank-cache.v1')).toBe(before); expect(localStorage.getItem('mahoshojo.arena.rank-cache.v1')).not.toContain('archive-only');
  });
});

describe('Web bounded public reader', () => {
  it('rejects actual chunk overflow even without Content-Length and hides malformed response fragments', async () => {
    const request = PublicRankingRequestSchema.parse(fixture.requests.search);
    fetcher.mockResolvedValue(new Response(new Uint8Array(PUBLIC_RANKING_BODY_BUDGETS.search + 1)));
    await expect(readWebRanking(request)).rejects.toThrow('排行榜响应过大');
    fetcher.mockResolvedValue(new Response('private invalid response body'));
    await expect(readWebRanking(request)).rejects.toThrow('排行榜响应协议无效');
    fetcher.mockResolvedValue(new Response(new Uint8Array([0xff])));
    await expect(readWebRanking(request)).rejects.toThrow('排行榜响应协议无效');
  });
  it.each([404, 429, 500])('keeps HTTP %s separate from empty successful reads', async (status) => {
    fetcher.mockResolvedValue(respond({ error: 'private server debug' }, status));
    await expect(readWebRanking(PublicRankingRequestSchema.parse(fixture.requests.search))).rejects.toThrow(`HTTP ${status}`);
  });
});
