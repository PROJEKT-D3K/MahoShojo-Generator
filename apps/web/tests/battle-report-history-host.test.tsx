// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/battle-report-history.json';
const mocks = vi.hoisted(() => ({
  snapshot: { user: null as { id: number; username: string } | null },
  listeners: new Set<() => void>(), fetch: vi.fn(), buildInit: vi.fn(), regenerate: vi.fn(), search: new URLSearchParams(),
  record: vi.fn(), access: vi.fn(), combatants: vi.fn(), output: vi.fn(), governance: vi.fn(), sensitive: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/me', useSearchParams: () => mocks.search, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/auth-client-store', () => ({ getAuthSnapshot: () => mocks.snapshot, subscribeAuthSnapshot: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: mocks.snapshot.user, isAuthenticated: mocks.snapshot.user !== null, loading: false, userBadges: [] }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { buildAuthenticatedRequestInit: mocks.buildInit } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.regenerate }) }) }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/me/ProfileHeader', () => ({ ProfileHeader: () => null }));
vi.mock('@/components/me/ProfileCardModal', () => ({ ProfileCardModal: () => null }));
vi.mock('@/components/me/BattleReportCardModal', () => ({ BattleReportCardModal: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>重生结果窗口</div> : null }));
vi.mock('@/lib/database/battle-report-generations', () => ({ getBattleReportGenerationByIdLite: mocks.record, updateBattleReportGenerationOutputHasSensitiveWords: mocks.governance }));
vi.mock('@/lib/database/battle-report-generation-combatants', () => ({ getBattleReportGenerationCombatantsByGenerationId: mocks.combatants }));
vi.mock('@/lib/database/arena-ratings', () => ({ parseGenerationCombatantsFallback: () => [] }));
vi.mock('@/lib/arena/battle-report-record-utils', () => ({ extractBattleReportGenerationErrorMessage: () => null, loadBattleReportGenerationOutputText: mocks.output }));
vi.mock('@/lib/arena/battle-report-access', () => ({ resolveBattleReportAccess: mocks.access }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.sensitive }));
vi.mock('@/lib/api/server', () => ({
  json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init),
  requireAuthUser: async () => ({ user: mocks.snapshot.user }),
}));
import { appRouteHandler } from '@/app/api/me/battle-reports/[generationId]/handler';
import { MePage } from '@/components/me/MePage';
let root: Root; let container: HTMLDivElement; let client: QueryClient;
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const list = (id = 42, title = '演示战报', page = 1) => ({ ...fixture.list, viewerUserId: id, page, records: [{ ...fixture.list.records[0], displayTitle: title }] });
const login = async (id: number | null) => { await act(async () => { mocks.snapshot = { user: id === null ? null : { id, username: `user${id}` } }; for (const listener of mocks.listeners) listener(); await flush(); }); await act(flush); };
const render = async () => { await act(async () => { root.render(<QueryClientProvider client={client}><MePage /></QueryClientProvider>); await flush(); }); await act(flush); };
const click = async (text: string) => { await act(async () => { [...document.querySelectorAll('button')].find((node) => node.textContent === text)!.click(); await flush(); }); await act(flush); };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.snapshot = { user: { id: 42, username: 'user42' } }; mocks.search = new URLSearchParams(); mocks.listeners.clear();
  mocks.fetch.mockReset(); mocks.regenerate.mockReset();
  for (const mock of [mocks.record, mocks.access, mocks.combatants, mocks.output, mocks.governance, mocks.sensitive]) mock.mockReset(); mocks.buildInit.mockReset().mockImplementation(async (init) => init);
  mocks.fetch.mockImplementation(async (path: string) => response(path.includes('/generation-1?') ? fixture.detail : list(mocks.snapshot.user!.id, `账号${mocks.snapshot.user!.id}战报`, Number(new URL(path, 'https://test.invalid').searchParams.get('page')))));
  vi.stubGlobal('fetch', mocks.fetch);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

describe('Web actual me shared report host', () => {
  it('does not query signed out, preserves URL filters, uses shared text detail and original Web action', async () => {
    mocks.snapshot.user = null; await render(); expect(mocks.fetch).not.toHaveBeenCalled();
    await login(42); expect(container.textContent).toContain('账号42战报');
    await click('详情'); expect(document.querySelector('pre')?.textContent?.trim()).toBe(fixture.detail.record.outputPreview);
    expect(document.querySelector('script')).toBeNull(); expect(mocks.fetch.mock.calls[1]![0]).toBe('/api/me/battle-reports/generation-1?expectedUserId=42');
    mocks.regenerate.mockResolvedValue(response({ report: {} })); await click('重生战报卡片');
    expect(mocks.regenerate).toHaveBeenCalledWith('/api/me/battle-reports/generation-1/regenerate', expect.objectContaining({ method: 'POST', body: '{}' }));
    expect(container.textContent).toContain('重生结果窗口');
  });
  it('passes the actual encoded detail request through the handler to the canonical colon ID lookup', async () => {
    const id = 'generation:1';
    const rawRecord = Object.fromEntries(Object.entries({ ...fixture.detail.record, id }).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));
    mocks.record.mockResolvedValue({ ...rawRecord, output_has_sensitive_words: 0, output_has_shield_words: 0, extra_json: null });
    mocks.access.mockResolvedValue({ scope: 'owner', arenaParticipantRole: null });
    mocks.combatants.mockResolvedValue([]);
    mocks.output.mockResolvedValue({ outputText: fixture.detail.record.outputPreview, source: 'd1', readError: null, hasStoredOutput: true });
    mocks.sensitive.mockResolvedValue({ hasSensitiveWords: false });
    mocks.fetch.mockImplementation(async (path: string) => path.includes('/battle-reports/')
      ? appRouteHandler(new Request(new URL(path, 'https://example.test')))
      : response({ ...fixture.list, records: [{ ...fixture.list.records[0], id }] }));
    await render(); await click('详情');
    expect(mocks.fetch.mock.calls[1]![0]).toBe('/api/me/battle-reports/generation%3A1?expectedUserId=42');
    expect(mocks.record).toHaveBeenCalledWith(id); expect(mocks.access).toHaveBeenCalledWith(id, 42);
    expect(document.querySelector('pre')?.textContent?.trim()).toBe(fixture.detail.record.outputPreview);
  });
  it('retains initial query and synchronizes filter changes with an atomic page reset', async () => {
    mocks.search = new URLSearchParams('page=2&pageSize=10&status=failed&q=标题&sort=started_at_asc');
    mocks.fetch.mockImplementation(async (path: string) => response({ ...list(42, '筛选战报', Number(new URL(path, 'https://test.invalid').searchParams.get('page'))), total: 30 }));
    await render(); const first = new URL(mocks.fetch.mock.calls[0]![0], 'https://test.invalid');
    expect(first.searchParams.get('page')).toBe('2'); expect(first.searchParams.get('status')).toBe('failed'); expect(first.searchParams.get('q')).toBe('标题');
    const mode = container.querySelectorAll('select')[2]!;
    await act(async () => { mode.value = 'daily'; mode.dispatchEvent(new Event('change', { bubbles: true })); await flush(); }); await act(flush);
    expect(window.location.search).toContain('mode=daily'); expect(window.location.search).not.toContain('page=2');
    expect(new URL(mocks.fetch.mock.lastCall![0], 'https://test.invalid').searchParams.get('page')).toBe('1');
  });
  it.each([200, 401])('hides private content immediately and ignores late %s on account switch and same-account re-login', async (status) => {
    await render(); const old = deferred<Response>(); mocks.fetch.mockReturnValueOnce(old.promise); await click('详情');
    await login(43); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.textContent).not.toContain('账号42战报'); expect(container.textContent).toContain('账号43战报');
    await act(async () => { old.resolve(response(fixture.detail, status)); await flush(); });
    expect(document.body.textContent).not.toContain('原始正文'); expect(document.body.textContent).not.toContain('登录已失效');
    const count = mocks.fetch.mock.calls.length; await login(43); expect(mocks.fetch.mock.calls.length).toBeGreaterThan(count);
    await login(null); expect(container.textContent).not.toContain('账号43战报'); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('cannot publish wrong-viewer, missing-capability or wrong-target results', async () => {
    mocks.fetch.mockResolvedValue(response(list(7, '不得显示'))); await render(); expect(container.textContent).toContain('返回账号不匹配'); expect(container.textContent).not.toContain('不得显示');
    const { viewerUserId: _, ...legacy } = fixture.list; mocks.fetch.mockResolvedValue(response(legacy)); await click('刷新'); expect(container.textContent).toContain('协议不兼容');
    mocks.fetch.mockResolvedValue(response(list())); await click('刷新'); mocks.fetch.mockResolvedValue(response({ ...fixture.detail, record: { ...fixture.detail.record, id: 'wrong', outputPreview: '错目标正文' } })); await click('详情');
    expect(document.body.textContent).toContain('返回目标不匹配'); expect(document.body.textContent).not.toContain('错目标正文');
  });
  it('does not publish a late regenerate result after same-account re-login', async () => {
    await render(); const old = deferred<Response>(); mocks.regenerate.mockReturnValue(old.promise); await click('重生战报'); await login(42);
    await act(async () => { old.resolve(response({ report: {} })); await flush(); });
    expect(container.textContent).not.toContain('重生结果窗口'); expect(container.textContent).not.toContain('旧战报结果');
  });
});
