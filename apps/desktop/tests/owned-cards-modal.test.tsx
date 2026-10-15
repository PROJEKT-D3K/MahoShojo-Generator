// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopCardDetailsModal } from '../src/features/card-details/card-details-modal';
import { DesktopOwnedCardsModal } from '../src/features/cloud-save/owned-cards-modal';
const mocks = vi.hoisted(() => ({ accountId: 7, epoch: 1, details: false, fetch: vi.fn(), load: vi.fn(), capacity: vi.fn(), createPort: vi.fn(), download: vi.fn() }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openContent: vi.fn() }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/platform/private-cloud-save', async (original) => ({ ...await original<typeof import('../src/platform/private-cloud-save')>(), readPrivateCloudCapacity: mocks.capacity }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => ({ useDesktopCloudSession: () => ({ state: { account: { userId: mocks.accountId }, verification: 'verified', authFlow: { kind: 'idle' } }, store: {
  getCredentialEpoch: () => mocks.epoch, getSnapshot: () => ({ account: { userId: mocks.accountId }, verification: 'verified', authFlow: { kind: 'idle' } }),
} }) }));
const platform = { Link: ({ children, ...props }: any) => <a {...props}>{children}</a>, marks: { isLiked: () => false, markLiked: () => true }, copyText: vi.fn(), downloadJson: mocks.download };
vi.mock('../src/platform/card-library-host', () => ({
  createDesktopCardLibraryOnlinePort: (...args: unknown[]) => { mocks.createPort(...args); return { fetchSummaryPage: mocks.fetch, loadFullCard: mocks.load }; },
  useDesktopCardLibraryHost: () => ({ platform, slots: mocks.details ? { CardDetailsModal: DesktopCardDetailsModal } : {} }),
}));
let root: Root; let container: HTMLDivElement;
const card = { id: 'owned', type: 'character', user_id: 7, name: '云端雾灯', description: '', is_public: 0, review_status: 'approved', roleType: 'general', usage_count: 0, like_count: 0, favorite_count: 0 };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
const render = (replace = vi.fn(), load = vi.fn()) => act(async () => { root.render(<DesktopOwnedCardsModal isOpen expectedUserId={7} onClose={() => {}} onReplaceCard={replace} onSelectCard={load} />); });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.accountId = 7; mocks.epoch = 1; mocks.details = false;
  mocks.fetch.mockResolvedValue({ success: true, cards: [card], total: 1, nextOffset: null }); mocks.load.mockResolvedValue({ ...card, data: '{"name":"正文"}' }); mocks.capacity.mockResolvedValue(null);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });
describe('Desktop 我的卡宿主回用共享管理模态框', () => {
  it('列表按expected owner读取，容量未知不伪装默认值，仅真实能力按钮可用', async () => {
    const select = vi.fn(); const replace = vi.fn(); await render(replace, select);
    expect(mocks.createPort.mock.calls[0][1]).toBe(7); expect(document.body.textContent).toContain('云端容量未知'); expect(document.body.textContent).not.toContain('0/20 槽');
    expect(button('修改信息')).toBeUndefined(); expect(button('删除')).toBeUndefined(); expect(button('详情')).toBeUndefined();
    await act(async () => { button('编辑档案').click(); }); expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'owned', data: '{"name":"正文"}' }));
    await act(async () => { button('替换').click(); }); expect(replace).toHaveBeenCalledOnce();
  });
  it('账号切换关闭旧账号管理，已在读取的目标迟到不会触发替换', async () => {
    let resolve!: (card: unknown) => void; mocks.load.mockReturnValue(new Promise((done) => { resolve = done; }));
    const replace = vi.fn(); await render(replace); await act(async () => { button('替换').click(); });
    mocks.accountId = 8; mocks.epoch += 1; await render(replace); await act(async () => { resolve({ ...card, data: '{}' }); });
    expect(document.querySelector('[role=dialog]')).toBeNull(); expect(replace).not.toHaveBeenCalled();
  });
});

it('真实我的卡详情直接消费已加载私有正文，不额外 HTTP，凭据世代更换后销毁', async () => {
  mocks.details = true; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    await render(); await act(async () => button('详情').click());
    expect(document.body.textContent).toContain('来源：我的云端数据卡正文'); expect(document.body.textContent).toContain('正文');
    expect(mocks.load).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(button('下载 JSON')).toBeDefined();
    mocks.epoch += 1; await render(); expect(button('下载 JSON')).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});


it('Desktop真实管理入口使用共源元信息owner与Native固定route，unknown保留输入且不重试', async () => {
  const target = { id: 'owned', type: 'character', name: '权威名称', description: '云端描述', isPublic: 0, reviewStatus: 'approved', hasPendingUpdate: true, version: 'a'.repeat(64) };
  const busy = vi.fn(); const invoke = vi.fn(async (_command, { request }: any) => request.routeId === 'data-cards.replace-target.query'
    ? { status: 200, body: { success: true, ownerUserId: 7, accountFenceVersion: 1, target } }
    : { status: 503, body: {} });
  await act(async () => root.render(<DesktopOwnedCardsModal isOpen expectedUserId={7} onClose={() => {}} invokeFn={invoke} metadataEditing={{ isBlocked: () => false, onBusyChange: busy }} />));
  await act(async () => button('修改信息').click()); expect(document.querySelector<HTMLInputElement>('[aria-label=名称]')?.value).toBe('权威名称'); expect(mocks.load).not.toHaveBeenCalled();
  await act(async () => { button('保存').click(); button('保存').click(); });
  const writes = invoke.mock.calls.filter(([, { request }]) => request.routeId === 'data-cards.metadata'); expect(writes).toHaveLength(1);
  expect(writes[0][1]).toEqual({ request: { routeId: 'data-cards.metadata', expectedUserId: 7, body: { id: 'owned', expectedVersion: target.version, expectedUserId: 7, name: target.name, description: target.description, isPublic: 0 } } });
  expect(button('保存').disabled).toBe(true); expect(document.body.textContent).toContain('修改结果不确定'); expect(busy).toHaveBeenLastCalledWith(false);
  await act(async () => button('重新读取云端信息').click()); await act(async () => button('已核对，使用此版本继续编辑').click());
  invoke.mockResolvedValueOnce({ status: 200, body: { success: true, id: 'owned', ownerUserId: 7, accountFenceVersion: 1, metadataVersion: 1 } } as never);
  await act(async () => button('保存').click()); expect(document.body.textContent).toContain('数据卡信息已更新'); expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it('真实云端管理入口进入共源回收站，列表与详情固定读取；不混入本地回收站或未交付写按钮', async () => {
  mocks.details = true;
  const summary = { id: 'deleted', type: 'character', name: '已删云端卡', description: '', is_public: 1, review_status: 'approved', created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false };
  const invoke = vi.fn(async (_command: string, { request }: any) => {
    if (request.routeId === 'data-cards.recycle.query') return { status: 200, body: { success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [summary], total: 1, filteredCount: 1, nextOffset: null } };
    if (request.routeId === 'data-cards.recycle-detail.query') return { status: 200, body: { success: true, accountFenceVersion: 1, ownerUserId: 7, card: { ...summary, data: '{"templateId":"通用角色","name":"墓碑","content":"云端墓碑正文"}' } } };
    throw new Error('非预期路由');
  });
  const busy = vi.fn();
  await act(async () => root.render(<DesktopOwnedCardsModal isOpen expectedUserId={7} onClose={() => {}} invokeFn={invoke} metadataEditing={{ isBlocked: () => false, onBusyChange: busy }} />));
  await act(async () => button('云端回收站').click()); expect(document.body.textContent).toContain('已删云端卡'); expect(document.body.textContent).not.toContain('云端墓碑正文');
  expect(button('恢复')).toBeUndefined(); expect(button('彻底删除')).toBeUndefined();
  await act(async () => button('查看详情').click()); expect(document.body.textContent).toContain('云端墓碑正文'); expect(button('下载 JSON')).toBeDefined();
  expect(invoke.mock.calls.map(([, { request }]) => request.routeId)).toEqual(['data-cards.recycle.query', 'data-cards.recycle-detail.query']);
  expect(busy.mock.calls.map(([value]) => value)).toEqual([true, false, true, false]);
  mocks.epoch++; await act(async () => root.render(<DesktopOwnedCardsModal isOpen expectedUserId={7} onClose={() => {}} invokeFn={invoke} />));
  expect(document.body.textContent).not.toContain('云端墓碑正文'); expect(button('云端回收站')).toBeDefined();
});
