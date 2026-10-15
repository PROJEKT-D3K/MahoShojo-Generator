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
    if (Date.now() > deadline) throw new Error('等待旧 Web 删除反馈超时');
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
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue(mocks.user);
  vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(dataCardApi, 'getUserCapacity').mockResolvedValue({ capacity: 20, usedSlots: 1 });
  vi.spyOn(dataCardApi, 'getRecycleBin').mockResolvedValue([]);
  // Keep the real facade: only the authenticated HTTP boundary supplies the 409.
  vi.spyOn(dataCardApi, 'deleteCard');
  vi.spyOn(authStorage, 'fetch').mockImplementation(async (url, options) => {
    if (url === '/api/data-cards?id=owned-card' && options?.method === 'DELETE') {
      if (!deleteSucceeds) return Response.json(fullResponse, { status: 409 });
      deleted = true;
      return Response.json({ success: true });
    }
    return Response.json({ success: true, badges: [] });
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
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, badges: [], items: {}, tags: [], reportCapability: null })));
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
  { name: '角色管理', type: 'character' as const, Page: CharacterManagerPage, openLabel: '我的数据卡', successMessage: '数据卡已移入回收站' },
  { name: '问卷编辑器', type: 'questionnaire' as const, Page: QuestionnaireEditorPage, openLabel: '打开问卷库', successMessage: '✅ 问卷数据卡已移入回收站' },
])('旧 Web $name 普通删除', ({ type, Page, openLabel, successMessage }) => {
  async function openLibrary() {
    cardType = type;
    await act(async () => { root.render(<Page />); });
    const opener = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(openLabel));
    await click(opener);
    await waitFor(() => !!button('删除', document.querySelector('[role="dialog"]')!));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保留的云端卡');
  }

  it('409 RECYCLE_BIN_FULL 经真实 auth facade 原样呈现，保留卡片且不触发成功刷新', async () => {
    await openLibrary();
    const before = refreshCounts();
    await click(button('删除', document.querySelector('[role="dialog"]')!));

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(dataCardApi.deleteCard).toHaveBeenCalledExactlyOnceWith('owned-card');
    expect(authStorage.fetch).toHaveBeenCalledWith('/api/data-cards?id=owned-card', { method: 'DELETE' });
    expect(await vi.mocked(dataCardApi.deleteCard).mock.results[0].value).toEqual(fullResponse);
    expect(container.textContent).toContain(fullResponse.error);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(fullResponse.error);
    expect(container.textContent).not.toContain(successMessage);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保留的云端卡');
    expect(button('删除', document.querySelector('[role="dialog"]')!)?.disabled).toBe(false);
    expect(refreshCounts()).toEqual(before);

    await click(document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain(fullResponse.error);
  });

  it('成功响应仍显示移入回收站反馈并刷新列表，不误报回收站已满', async () => {
    deleteSucceeds = true;
    await openLibrary();
    const before = refreshCounts();
    await click(button('删除', document.querySelector('[role="dialog"]')!));
    await waitFor(() => !document.querySelector('[role="dialog"]')?.textContent?.includes('保留的云端卡'));

    expect(dataCardApi.deleteCard).toHaveBeenCalledExactlyOnceWith('owned-card');
    expect(await vi.mocked(dataCardApi.deleteCard).mock.results[0].value).toEqual({ success: true });
    expect(container.textContent).toContain(successMessage);
    expect(container.textContent).not.toContain(fullResponse.error);
    expect(container.textContent).not.toContain('删除失败');
    expect(refreshCounts().capacity).toBe(before.capacity + 1);
    expect(dataCardApi.getRecycleBin).not.toHaveBeenCalled();
    expect(refreshCounts().summary).toBeGreaterThan(before.summary);
    expect(badgeRequests()).toBe(before.badges + (type === 'character' ? 1 : 0));
  });
});
