// @vitest-environment jsdom
import React, { act, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CharacterManagerPage } from '@/components/character/CharacterManagerPage';
import { QuestionnaireEditorPage } from '@/components/creation/QuestionnaireEditorPage';
import { authStorage, dataCardApi } from '@/lib/auth';
import * as cardClient from '@/lib/data-card-list-client';

const mocks = vi.hoisted(() => ({
  user: { id: 7, username: 'tester' },
  push: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: mocks.user, loading: false, isAuthenticated: true, authSource: 'better-auth-session', logout: mocks.logout }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false, matchDetails: [] }) }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => null }));
vi.mock('@/components/CanshouCard', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => null }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));
vi.mock('@/components/UserTitle', () => ({ UserWithTitle: () => null }));

const fence = { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7 };
const version = 'a'.repeat(64);
const fetcher = vi.fn();
const writes = () => fetcher.mock.calls.filter(([, options]) => options?.method === 'POST' && String(options?.body).includes('expectedUserId'));
const fullResponse = {
  code: 'RECYCLE_BIN_FULL',
  error: '回收站已满，所有类型的数据卡共享账号回收站容量。本次未删除该卡或其他卡片，请先到回收站恢复或彻底删除不需要的卡片后重试。',
};
let root: Root;
let container: HTMLDivElement;
let cardType: 'character' | 'questionnaire';
let deleteSucceeds: boolean;
let deleted: boolean;

function button(label: string, within: ParentNode = document) {
  return [...within.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
}
async function click(node: HTMLButtonElement | undefined) {
  expect(node).toBeDefined();
  await act(async () => { node!.click(); });
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待共源 Web 删除反馈超时');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}
const badgeRequests = () => vi.mocked(authStorage.fetch).mock.calls.filter(([url]) => url === '/api/badges/user').length;
const refreshCounts = () => ({
  capacity: vi.mocked(dataCardApi.getUserCapacity).mock.calls.length,
  recycle: vi.mocked(dataCardApi.getRecycleBin).mock.calls.length,
  summary: vi.mocked(cardClient.getDataCardSummaryPage).mock.calls.length,
  badges: badgeRequests(),
});

beforeEach(() => {
  localStorage.clear();
  cardType = 'character';
  deleteSucceeds = false;
  deleted = false;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ userId: mocks.user.id, username: mocks.user.username });
  vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(dataCardApi, 'getUserCapacity').mockResolvedValue({ capacity: 20, usedSlots: 1 });
  vi.spyOn(dataCardApi, 'getRecycleBin').mockResolvedValue([]);
  // Both real pages consume the real shared controller and HTTP adapter; only the network is replaced.
  vi.spyOn(dataCardApi, 'deleteCard');
  vi.spyOn(authStorage, 'fetch').mockImplementation(async () => Response.json({ success: true, badges: [] }));
  fetcher.mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/data-cards/delete-preview-owned?')) {
      expect(new URL(url, 'https://example.test').searchParams.get('scope')).toBe('active');
      return Response.json({ ...fence, operation: 'preview-active', targets: [{
        id: 'owned-card', type: cardType, name: '预览核对的卡名', description: '原卡说明', version,
      }], total: 1, recycleLimit: 5 });
    }
    if (url === '/api/data-cards/soft-delete-owned' && options?.method === 'POST') {
      if (!deleteSucceeds) return Response.json(fullResponse, { status: 409 });
      deleted = true;
      return Response.json({ ...fence, operation: 'soft-delete', id: 'owned-card' });
    }
    if (url.includes('purge-') || options?.method === 'DELETE') throw new Error('未确认的永久删除或旧 DELETE');
    return Response.json({ success: true, badges: [], items: {}, tags: [], reportCapability: null });
  });
  vi.spyOn(cardClient, 'getDataCardSummaryPage').mockImplementation(async () => ({
    success: true,
    cards: deleted ? [] : [{
      id: 'owned-card', user_id: 7, name: '保留的云端卡', description: '原卡说明', type: cardType,
      is_public: 0, review_status: 'approved', created_at: null, updated_at: null,
      usage_count: 0, like_count: 0, favorite_count: 0, is_recommended: 0,
      username: 'tester', roleType: cardType === 'character' ? 'general' : null,
      nativeAllowed: false, has_pending_update: false, tag_ids: [], favorited_at: null,
    }],
    total: deleted ? 0 : 1,
    nextOffset: null,
  }));
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each([
  { name: '角色管理', type: 'character' as const, Page: CharacterManagerPage, openLabel: '我的数据卡' },
  { name: '问卷编辑器', type: 'questionnaire' as const, Page: QuestionnaireEditorPage, openLabel: '打开问卷库' },
])('Web $name 共源确认式删除', ({ type, Page, openLabel }) => {
  async function openLibrary() {
    cardType = type;
    await act(async () => { root.render(<Page />); });
    const opener = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(openLabel));
    await click(opener);
    await waitFor(() => !!button('删除', document.querySelector('[role="dialog"]')!));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保留的云端卡');
  }

  async function confirmSoftDelete() {
    await click(button('删除', document.querySelector('[role="dialog"]')!));
    expect(document.body.textContent).toContain('预览核对的卡名');
    expect(writes()).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe('取消');
    await click(button('移入回收站'));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(dataCardApi.deleteCard).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![0]).toBe('/api/data-cards/soft-delete-owned');
    expect(JSON.parse(writes()[0]![1].body)).toEqual({ expectedUserId: 7, id: 'owned-card', version });
  }

  it('409 满额在前景给出四个选择，保留原卡、零成功刷新；取消不派生永久写', async () => {
    await openLibrary();
    const before = refreshCounts();
    await confirmSoftDelete();
    expect(document.body.textContent).toContain('回收站已满，当前卡尚未移入');
    expect(button('永久删除「预览核对的卡名」…')).toBeDefined();
    expect(button('清空回收站并继续…')).toBeDefined();
    expect(button('整理回收站')).toBeDefined();
    expect(document.activeElement?.textContent).toBe('取消');
    expect(document.body.textContent).not.toContain('数据卡已移入回收站');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保留的云端卡');
    expect(refreshCounts()).toEqual(before);
    await click(button('取消'));
    expect(document.body.textContent).not.toContain('当前卡尚未移入');
    expect(button('删除', document.querySelector('[role="dialog"]')!)?.disabled).toBe(false);
    expect(writes()).toHaveLength(1);
    expect(refreshCounts()).toEqual(before);
  });

  it('严格成功回执显示移入反馈并刷新列表，不误报回收站已满', async () => {
    deleteSucceeds = true;
    await openLibrary();
    const before = refreshCounts();
    await confirmSoftDelete();
    await waitFor(() => !document.querySelector('[role="dialog"]')?.textContent?.includes('保留的云端卡'));
    expect(document.body.textContent).toContain('数据卡已移入回收站');
    expect(document.body.textContent).not.toContain('回收站已满');
    expect(document.body.textContent).not.toContain('删除失败');
    expect(refreshCounts().capacity).toBe(before.capacity + 1);
    expect(dataCardApi.getRecycleBin).not.toHaveBeenCalled();
    expect(refreshCounts().summary).toBeGreaterThan(before.summary);
    expect(badgeRequests()).toBe(before.badges + (type === 'character' ? 1 : 0));
  });
});
