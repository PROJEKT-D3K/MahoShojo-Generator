// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterManagerPage } from '@/components/character/CharacterManagerPage';
import { writeCharacterManagerPageDraft } from '@/lib/character-manager-page-draft';
import { AuthStorageError } from '@/lib/auth-identity';
import { authStorage, dataCardApi } from '@/lib/auth';
import * as cardClient from '@/lib/data-card-list-client';
import type { OwnedDataCardReplacementTarget } from '@mahoshojo/contracts/data-cards';
const state = vi.hoisted(() => ({ userId: 7, users: { 7: { id: 7, username: 'tester' }, 8: { id: 8, username: 'tester' } } as Record<number, { id: number; username: string }>, push: vi.fn(), resign: vi.fn(), logout: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: state.users[state.userId], loading: false, isAuthenticated: true, authSource: 'better-auth-session', logout: state.logout }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false, matchDetails: [] }) }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => null }));
vi.mock('@/components/CanshouCard', () => ({ default: () => null }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => null }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));
vi.mock('@/components/UserTitle', () => ({ UserWithTitle: () => null }));
let root: Root; let container: HTMLDivElement;
const sample = { templateId: '通用角色', name: '雾灯', content: '角色正文', signature: 'opaque-evidence' };
const target: OwnedDataCardReplacementTarget = { id: 'owned-card', type: 'character', name: '原云卡', description: '保留描述', isPublic: 1, reviewStatus: 'approved', hasPendingUpdate: true, version: '1'.repeat(64) };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
const click = (label: string) => act(async () => { button(label).click(); });
const inputValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
const waitFor = async (check: () => boolean) => { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw new Error('等待角色管理云卡状态超时'); await act(async () => { await new Promise((done) => setTimeout(done, 10)); }); } };
const mount = async (isNative = false) => {
  writeCharacterManagerPageDraft({ pastedJson: '', characterData: sample, originalData: sample, isNative, selectedTemplate: 'general' });
  await act(async () => { root.render(<CharacterManagerPage />); }); await waitFor(() => !!button('保存到云端'));
};
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.userId = 7; state.resign.mockReset(); state.push.mockClear(); state.logout.mockReset().mockResolvedValue(undefined); localStorage.clear();
  vi.spyOn(authStorage, 'getAuth').mockImplementation(async () => ({ userId: state.userId, username: 'tester' })); vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue(null);
  vi.spyOn(dataCardApi, 'getUserCapacity').mockResolvedValue({ capacity: 20, usedSlots: 0 }); vi.spyOn(dataCardApi, 'getRecycleBin').mockResolvedValue([]);
  vi.spyOn(dataCardApi, 'createCard').mockResolvedValue({ success: true, id: 'new-card' }); vi.spyOn(dataCardApi, 'readOwnedReplacementTarget').mockResolvedValue({ success: true, target }); vi.spyOn(dataCardApi, 'replaceOwnedCard').mockResolvedValue({ success: true, pendingReview: true });
  vi.spyOn(cardClient, 'getDataCardSummaryPage').mockResolvedValue({ success: true, cards: [{ id: target.id, user_id: 7, name: target.name, description: target.description, type: 'character', is_public: 1, review_status: 'approved', created_at: null, updated_at: null, usage_count: 0, like_count: 0, favorite_count: 0, is_recommended: 0, username: 'tester', roleType: 'general', nativeAllowed: false, has_pending_update: true, tag_ids: [], favorited_at: null }], total: 1, nextOffset: null });
  vi.spyOn(cardClient, 'loadFullDataCard').mockResolvedValue({ id: target.id, type: target.type, name: target.name, data: JSON.stringify(sample) });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => { if (String(url).includes('/api/resign-data')) { const result = await state.resign(options); return result ?? Response.json({ ...sample, signature: 'renewed-signature' }); } return Response.json({ success: true, badges: [], items: {}, tags: [], reportCapability: null }); }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web真实角色管理普通角色/情景云写宿主', () => {
  it('退出时本地清除失败用既有页面消息准确提示，不清掉编辑正文', async () => {
    await mount();
    state.logout.mockRejectedValueOnce(new AuthStorageError());
    await click('退出登录');
    expect(container.textContent).toContain('本机登录信息清除失败，请检查浏览器存储设置后重试');
    expect(container.textContent).not.toContain('服务器登出失败');
    expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
    expect(state.logout).toHaveBeenCalledOnce();
  });

  it('保存表单可取消重开、设为公开，提交仍走原签名准备与owner围栏；重复点击只提交一次', async () => {
    await mount(true); await click('保存到云端'); await click('取消'); expect(document.querySelector('[role=dialog]')).toBeNull(); await click('保存到云端');
    await act(async () => { (document.querySelector('[role=dialog] input[type=checkbox]') as HTMLInputElement).click(); button('保存').click(); button('保存').click(); });
    await waitFor(() => vi.mocked(dataCardApi.createCard).mock.calls.length > 0);
    expect(state.resign).toHaveBeenCalledOnce(); expect(dataCardApi.createCard).toHaveBeenCalledOnce();
    expect(vi.mocked(dataCardApi.createCard).mock.calls[0]).toEqual(['character', '雾灯', '角色数据卡', expect.objectContaining({ signature: 'renewed-signature' }), 1, expect.objectContaining({ expectedUserId: 7 })]);
    expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯'); expect(container.textContent).toContain('数据卡保存成功');
  });
  it('明确保存失败保留名称描述和编辑正文；不确定结果关闭重开仍禁止直接重发', async () => {
    vi.mocked(dataCardApi.createCard).mockResolvedValueOnce({ success: false, error: '容量不足' }).mockResolvedValueOnce({ success: false, uncertain: true, error: '结果不确定' });
    await mount(); await click('保存到云端'); const fields = document.querySelectorAll<HTMLInputElement>('[role=dialog] input'); await inputValue(fields[0], '我的新名字');
    await click('保存'); expect(document.body.textContent).toContain('容量不足'); expect(document.querySelector<HTMLInputElement>('[role=dialog] input')?.value).toBe('我的新名字');
    await click('保存'); expect(button('保存').disabled).toBe(true); expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
    for (const label of ['检查我的云端卡', '我已检查，仍要再次新建（可能重复）']) expect(button(label).className.split(' ')).toEqual(expect.arrayContaining(['hover:bg-gray-50', 'focus-visible:ring-2', 'focus-visible:ring-fuchsia-500', 'disabled:opacity-50']));
    expect(button('我已检查，仍要再次新建（可能重复）').disabled).toBe(true);
    await click('取消'); await click('保存到云端'); expect(button('保存').disabled).toBe(true); expect(dataCardApi.createCard).toHaveBeenCalledTimes(2);
  });
  it('从真实管理卡片选替换目标，服务端版本先读后确认，取消零写，待审按ack反馈', async () => {
    await mount(); await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); }); await waitFor(() => !!button('替换')); await click('替换');
    expect(dataCardApi.readOwnedReplacementTarget).toHaveBeenCalledWith(target.id, expect.objectContaining({ expectedUserId: 7 })); expect(document.body.textContent).toContain('已有待审核版本'); expect(dataCardApi.replaceOwnedCard).not.toHaveBeenCalled();
    await click('取消'); await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); }); await waitFor(() => !!button('替换')); await click('替换'); await click('确认替换');
    expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledWith(target, expect.objectContaining({ name: '雾灯' }), expect.objectContaining({ expectedUserId: 7 })); expect(container.textContent).toContain('更新已提交审核');
  });
  it('账号切换使已打开保存/替换失效，旧准备响应不写新账号，编辑正文仍在', async () => {
    const old = deferred<{ success: boolean; target: OwnedDataCardReplacementTarget }>(); vi.mocked(dataCardApi.readOwnedReplacementTarget).mockReturnValue(old.promise);
    await mount(); await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); }); await waitFor(() => !!button('替换')); await click('替换');
    state.userId = 8; await act(async () => { root.render(<CharacterManagerPage />); }); await act(async () => { old.resolve({ success: true, target }); });
    expect(document.querySelector('[role=dialog]')).toBeNull(); expect(dataCardApi.replaceOwnedCard).not.toHaveBeenCalled(); expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
  });
  it.each(['close', 'escape', 'recycle'])('替换目标读取中经%s离开列表，迟到目标不再开确认或写入', async (leave) => {
    const old = deferred<{ success: boolean; target: OwnedDataCardReplacementTarget }>();
    vi.mocked(dataCardApi.readOwnedReplacementTarget).mockReturnValue(old.promise);
    await mount();
    await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); });
    await waitFor(() => !!button('替换')); await click('替换');
    expect(dataCardApi.readOwnedReplacementTarget).toHaveBeenCalledOnce();
    if (leave === 'close') await act(async () => { document.querySelector<HTMLButtonElement>('[role=dialog] [aria-label=关闭]')!.click(); });
    else if (leave === 'escape') await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    else await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((node) => node.textContent?.trim().startsWith('回收站'))!.click(); });
    await act(async () => { old.resolve({ success: true, target }); });
    expect(button('确认替换')).toBeUndefined();
    expect(dataCardApi.replaceOwnedCard).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
  });
  it('取消后重开不会被旧目标响应抢占，也不会释放新读取的等待态', async () => {
    const old = deferred<{ success: boolean; target: OwnedDataCardReplacementTarget }>();
    const current = deferred<{ success: boolean; target: OwnedDataCardReplacementTarget }>();
    vi.mocked(dataCardApi.readOwnedReplacementTarget).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const openList = async () => {
      await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); });
      await waitFor(() => !!button('替换')); await click('替换');
    };
    await mount(); await openList();
    await act(async () => { document.querySelector<HTMLButtonElement>('[role=dialog] [aria-label=关闭]')!.click(); });
    await openList();
    await act(async () => { old.resolve({ success: true, target }); });
    expect(button('确认替换')).toBeUndefined();
    expect(document.querySelector('[role=status]')?.textContent).toContain('正在处理数据卡');
    const currentTarget = { ...target, version: '2'.repeat(64) };
    await act(async () => { current.resolve({ success: true, target: currentTarget }); });
    expect(dataCardApi.replaceOwnedCard).not.toHaveBeenCalled();
    await click('确认替换');
    expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledExactlyOnceWith(currentTarget, expect.anything(), expect.objectContaining({ expectedUserId: 7 }));
  });
  it('回收站离开后迟到失败不污染新界面，正文和新选择能力保留', async () => {
    const old = deferred<{ success: boolean; error: string }>();
    vi.mocked(dataCardApi.readOwnedReplacementTarget).mockReturnValueOnce(old.promise);
    await mount();
    await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); });
    await waitFor(() => !!button('替换')); await click('替换');
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((node) => node.textContent?.trim().startsWith('回收站'))!.click(); });
    await act(async () => { old.resolve({ success: false, error: '旧目标读取失败' }); });
    expect(document.body.textContent).not.toContain('旧目标读取失败');
    expect(button('确认替换')).toBeUndefined();
    expect(dataCardApi.replaceOwnedCard).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
  });
  it('等待反馈不解除已发送替换的写锁，重复点击和Escape不会重发或关闭', async () => {
    const writing = deferred<{ success: boolean; pendingReview: boolean }>();
    vi.mocked(dataCardApi.replaceOwnedCard).mockReturnValue(writing.promise);
    await mount();
    await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); });
    await waitFor(() => !!button('替换')); await click('替换');
    await act(async () => { button('确认替换').click(); button('确认替换').click(); });
    expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledOnce();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(button('替换中...')?.disabled).toBe(true);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    await act(async () => { writing.resolve({ success: true, pendingReview: true }); });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledOnce();
  });
  it('替换未知响应不自动重放且失败保稿，必须回列表重新读取目标', async () => {
    vi.mocked(dataCardApi.replaceOwnedCard).mockResolvedValue({ success: false, uncertain: true, error: '替换结果不确定' });
    await mount(); await act(async () => { [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('我的数据卡'))!.click(); }); await waitFor(() => !!button('替换')); await click('替换'); await click('确认替换');
    expect(button('确认替换').disabled).toBe(true); expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledOnce(); expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe('雾灯');
    expect(button('检查我的云端卡并重新选择目标').className.split(' ')).toEqual(expect.arrayContaining(['hover:bg-gray-50', 'focus-visible:ring-2', 'focus-visible:ring-fuchsia-500']));
    await click('检查我的云端卡并重新选择目标'); await waitFor(() => !!button('替换')); expect(dataCardApi.replaceOwnedCard).toHaveBeenCalledOnce();
  });
  it.each(['account', 'source'])('签名准备在途换%s，迟到的不合规响应不跳转、不写入、不污染新页面', async (change) => {
    const signing = deferred<Response>(); state.resign.mockImplementationOnce(() => signing.promise);
    await mount(true); await click('保存到云端'); await click('保存'); await waitFor(() => state.resign.mock.calls.length === 1);
    if (change === 'account') { state.userId = 8; await act(async () => { root.render(<CharacterManagerPage />); }); }
    else await inputValue(container.querySelector<HTMLInputElement>('#editor-field-name')!, '新编辑正文');
    await act(async () => { signing.resolve(Response.json({ shouldRedirect: true, reason: '旧数据拒绝' }, { status: 403 })); });
    expect(state.push).not.toHaveBeenCalled(); expect(dataCardApi.createCard).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe(change === 'account' ? '雾灯' : '新编辑正文'); expect(document.querySelector('[role=dialog]')).toBeNull();
  });

});
