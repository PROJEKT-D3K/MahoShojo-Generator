// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopCardDetailsModal } from '../src/features/card-details/card-details-modal';
import { DesktopOwnedCardsModal } from '../src/features/cloud-save/owned-cards-modal';
const mocks = vi.hoisted(() => ({ accountId: 7, epoch: 1, details: false, store: {} as { getCredentialEpoch: () => number; getSnapshot: () => any }, fetch: vi.fn(), load: vi.fn(), capacity: vi.fn(), createPort: vi.fn(), download: vi.fn() }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openContent: vi.fn() }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../src/platform/private-cloud-save', async (original) => ({ ...await original<typeof import('../src/platform/private-cloud-save')>(), readPrivateCloudCapacity: mocks.capacity }));
vi.mock('../src/features/account/use-desktop-cloud-session', () => ({ useDesktopCloudSession: () => ({ state: { account: { userId: mocks.accountId }, verification: 'verified', authFlow: { kind: 'idle' } }, store: mocks.store }) }));
const platform = { Link: ({ children, ...props }: any) => <a {...props}>{children}</a>, marks: { isLiked: () => false, markLiked: () => true }, copyText: vi.fn(), downloadJson: mocks.download };
vi.mock('../src/platform/card-library-host', () => ({
  createDesktopCardLibraryOnlinePort: (...args: unknown[]) => { mocks.createPort(...args); return { fetchSummaryPage: mocks.fetch, loadFullCard: mocks.load }; },
  useDesktopCardLibraryHost: () => ({ platform, slots: mocks.details ? { CardDetailsModal: DesktopCardDetailsModal } : {} }),
}));
let root: Root; let container: HTMLDivElement;
const card = { id: 'owned', type: 'character', user_id: 7, name: '云端雾灯', description: '', is_public: 0, review_status: 'approved', roleType: 'general', usage_count: 0, like_count: 0, favorite_count: 0 };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.accountId = 7; mocks.epoch = 1; mocks.details = false;
  mocks.store = { getCredentialEpoch: () => mocks.epoch, getSnapshot: () => ({ account: { userId: mocks.accountId }, verification: 'verified', authFlow: { kind: 'idle' } }) };
  mocks.fetch.mockResolvedValue({ success: true, cards: [card], total: 1, nextOffset: null }); mocks.load.mockResolvedValue({ ...card, data: '{"name":"正文"}' }); mocks.capacity.mockResolvedValue(null);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

it.each([{ stage: 'read', change: 'identity' }, { stage: 'write', change: 'identity' }, { stage: 'read', change: 'source' }, { stage: 'write', change: 'source' }] as const)('Desktop旧式metadata $stage 在$change换代后迟到不清新busy，也不刷新旧成功', async ({ stage, change }) => {
  const target = { id: card.id, type: 'character', name: '权威名称', description: '', isPublic: 0, reviewStatus: 'approved', hasPendingUpdate: false, version: 'a'.repeat(64) };
  const ready = { status: 200, body: { success: true, ownerUserId: 7, accountFenceVersion: 1, target } };
  const saved = { status: 200, body: { success: true, id: card.id, ownerUserId: 7, accountFenceVersion: 1, metadataVersion: 1 } };
  let finishOld!: (value: unknown) => void; let finishNew!: (value: unknown) => void;
  const oldRequest = new Promise(resolve => { finishOld = resolve; });
  const newRequest = new Promise(resolve => { finishNew = resolve; });
  const invoke = vi.fn(async (_command: string, { request }: any) => request.routeId === 'data-cards.replace-target.query' ? ready : saved);
  let held = false;
  const busy = vi.fn((value: boolean) => { held = value; });
  const guard = { isBlocked: () => held, onBusyChange: busy };
  let source = 0;
  const show = () => act(async () => root.render(<DesktopOwnedCardsModal key={source} isOpen expectedUserId={7} onClose={() => {}} invokeFn={invoke} metadataEditing={guard} />));
  await show();
  if (stage === 'read') invoke.mockReturnValueOnce(oldRequest as never);
  await act(async () => button('修改信息').click());
  if (stage === 'write') { invoke.mockReturnValueOnce(oldRequest as never); await act(async () => button('保存').click()); }
  expect(held).toBe(true);
  // The outer DesktopCloudCardActions scope resets its own guard when credentials change.
  if (change === 'identity') mocks.epoch++; else source++;
  held = false; await show();
  invoke.mockReturnValueOnce(newRequest as never); await act(async () => button(stage === 'write' && change === 'source' ? '重新读取云端信息' : '修改信息').click());
  expect(held).toBe(true);
  busy.mockClear(); const reads = mocks.fetch.mock.calls.length;
  await act(async () => finishOld(stage === 'read' ? ready : saved));
  expect(held).toBe(true); expect(busy).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(reads); expect(document.body.textContent).not.toContain('数据卡信息已更新');
  await act(async () => finishNew(ready));
  expect(held).toBe(false); expect(busy).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.querySelector<HTMLInputElement>('[aria-label=名称]')?.value).toBe('权威名称');
  if (stage === 'write' && change === 'source') { expect(button('保存').disabled).toBe(true); expect(document.body.textContent).toContain('修改结果不确定'); }
});
