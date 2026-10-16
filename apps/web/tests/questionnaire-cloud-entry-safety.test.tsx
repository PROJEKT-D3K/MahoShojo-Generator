// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ userId: 7, epoch: 1, check: vi.fn(), reload: vi.fn(), push: vi.fn(), copy: vi.fn(), download: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href}>{children}</a> }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/DeferredDataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/RecycleBinModal', () => ({ default: () => null }));
vi.mock('@/components/shared/TokenIndicator', () => ({ TokenIndicator: () => null }));
vi.mock('@/components/shared/JsonSizeIndicator', () => ({ JsonSizeIndicator: () => null }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: mocks.userId }, identityEpoch: mocks.epoch, authSource: 'legacy-bearer' }) }));
vi.mock('@/lib/use-data-card-summary-page', () => ({ useDataCardSummaryPage: () => ({ reload: mocks.reload, status: 'idle' }) }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.check }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download }));
import { QuestionnaireEditorPage } from '@/components/creation/QuestionnaireEditorPage';
import QuestionnaireCompatModal from '@/components/CharManager/QuestionnaireCompatModal';
import { authStorage, dataCardApi } from '@/lib/auth';
import { beginAuthIdentityTransition } from '@/lib/auth-identity';
import * as list from '@/lib/data-card-list-client';

const questionnaire = { id: 'draft-q', kind: 'magical-girl', title: '当前完整稿', extension: { keep: true }, questions: [{ id: 'q1', question: '题目', options: [] }] };
const card = { id: 'owned-q', user_id: 7, type: 'questionnaire', name: '合成云问卷', description: '保留云端描述', is_public: 0, review_status: 'approved', usage_count: 0, like_count: 0, favorite_count: 0 };
const target = { id: card.id, type: 'questionnaire', name: card.name, description: card.description, isPublic: 0, reviewStatus: 'approved', hasPendingUpdate: true, version: 'a'.repeat(64) };
const ready = { success: true, accountFenceVersion: 1, ownerUserId: 7, target };
const ack = { success: true, id: card.id, accountFenceVersion: 1, ownerUserId: 7, replacementVersion: 1, pendingReview: true };
const fetcher = vi.fn<typeof fetch>();
let root: Root; let container: HTMLDivElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
const click = (label: string) => act(async () => { expect(button(label), label).toBeTruthy(); button(label)!.click(); await flush(); });
const renderPage = () => act(async () => { root.render(<QuestionnaireEditorPage />); await flush(); });
// The modal's metadata batch is a read-only POST; every other non-GET remains a write candidate.
const writes = () => fetcher.mock.calls.filter(([url, init]) => String(url) !== '/api/data-card-meta-batch' && init?.method && !['GET', 'HEAD'].includes(init.method));
const input = (node: HTMLInputElement | HTMLTextAreaElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
});
const draftInput = () => container.querySelector<HTMLTextAreaElement>('textarea[placeholder="在此粘贴问卷 JSON"]')!;
const importDraft = async () => { input(draftInput(), JSON.stringify(questionnaire)); await click('应用粘贴内容'); };
const chooseTarget = async () => { await click('替换已有'); await click('替换'); };
const closeLibrary = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.userId = 7; mocks.epoch = beginAuthIdentityTransition().identity.epoch;
  mocks.check.mockReset().mockResolvedValue({ hasSensitiveWords: false }); mocks.copy.mockResolvedValue(undefined);
  vi.spyOn(authStorage, 'getAuth').mockResolvedValue({ userId: 7, username: 'synthetic-owner' });
  vi.spyOn(authStorage, 'getAuthHeader').mockResolvedValue('Bearer synthetic-local-only');
  vi.spyOn(dataCardApi, 'getUserCapacity').mockResolvedValue({ capacity: 20, usedSlots: 1 });
  vi.spyOn(dataCardApi, 'repairQuestionnaireType');
  vi.spyOn(dataCardApi, 'replaceCard');
  vi.spyOn(list, 'getDataCardSummaryPage').mockResolvedValue({ success: true, cards: [card], total: 1, nextOffset: null } as never);
  vi.spyOn(list, 'loadFullDataCard').mockResolvedValue({ ...card, data: JSON.stringify(questionnaire) });
  vi.spyOn(window, 'confirm').mockReturnValue(true); vi.spyOn(window, 'alert').mockImplementation(() => {});
  fetcher.mockReset().mockImplementation(async (url, init) => Response.json(String(url).includes('/replace-owned') ? (init?.method === 'PUT' ? ack : ready) : { success: true, items: {}, tags: [] }));
  vi.stubGlobal('fetch', fetcher);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('真实问卷页、云端库与安全替换入口', () => {
  test('问卷库仅保留载入和管理，明确安全替换位置及历史错标限制', async () => {
    await renderPage(); await importDraft(); await click('打开问卷库');
    expect(button('替换')).toBeUndefined();
    expect(button('编辑档案')).toBeTruthy(); expect(button('修改信息')).toBeTruthy(); expect(button('删除')).toBeTruthy();
    expect(document.body.textContent).toContain('替换当前问卷请使用下方“替换已有”');
    expect(document.body.textContent).toContain('历史误分类问卷暂不支持一步原位覆写');
    await closeLibrary(); expect(button('替换已有')).toBeTruthy();
    expect(draftInput().value).toBe(JSON.stringify(questionnaire));
    expect(writes()).toHaveLength(0);
  });

  test('安全路径预览后显式提交完整稿和 owner/version，不调用旧替换或类型修复', async () => {
    await renderPage(); await importDraft(); await chooseTarget();
    expect(button('确认替换')).toBeTruthy(); expect(writes()).toHaveLength(0);
    await click('确认替换'); expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/data-cards/replace-owned');
    expect(JSON.parse(writes()[0][1]!.body as string)).toMatchObject({ id: card.id, type: 'questionnaire', expectedUserId: 7, expectedVersion: target.version, data: { title: questionnaire.title, extension: { keep: true } } });
    expect(dataCardApi.replaceCard).not.toHaveBeenCalled(); expect(dataCardApi.repairQuestionnaireType).not.toHaveBeenCalled();
    expect(draftInput().value).toBe(JSON.stringify(questionnaire));
  });

  test('载入历史错标问卷只导入本地稿，不隐式修改云端类型', async () => {
    vi.mocked(list.loadFullDataCard).mockResolvedValue({ ...card, isLegacyQuestionnaire: true, data: JSON.stringify(questionnaire) });
    await renderPage(); await click('打开问卷库'); await click('编辑档案');
    expect(draftInput().value).toBe(JSON.stringify(questionnaire));
    expect(dataCardApi.repairQuestionnaireType).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });

  test('额外字段非法 JSON 不进入目标选择、不丢原稿扩展', async () => {
    await renderPage(); await importDraft();
    const label = [...container.querySelectorAll('label')].find((node) => node.textContent === '额外字段 JSON（可选）')!;
    const extra = label.parentElement!.querySelector('textarea')!; input(extra, '{ invalid extension');
    await click('替换已有');
    expect(button('替换')).toBeUndefined(); expect(button('确认替换')).toBeUndefined();
    expect(extra.value).toBe('{ invalid extension'); expect(draftInput().value).toBe(JSON.stringify(questionnaire));
    expect(writes()).toHaveLength(0); expect(window.alert).toHaveBeenCalled();
  });

  test('未知结果关闭再开仍禁止重发，原稿可复制保留', async () => {
    await renderPage(); await importDraft(); await chooseTarget();
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 500 })); await click('确认替换');
    expect(button('确认替换')!.disabled).toBe(true); await click('取消'); await click('替换已有');
    expect(button('确认替换')!.disabled).toBe(true); expect(writes()).toHaveLength(1);
    await click('取消'); await click('复制 JSON');
    expect(JSON.parse(mocks.copy.mock.calls.at(-1)![0])).toMatchObject({ title: questionnaire.title, extension: { keep: true } });
    expect(writes()).toHaveLength(1); expect(dataCardApi.replaceCard).not.toHaveBeenCalled();
  });

  test('目标版本冲突后必须重新选取并确认新版本', async () => {
    await renderPage(); await importDraft(); await chooseTarget();
    fetcher.mockResolvedValueOnce(Response.json({ error: 'TARGET_CHANGED' }, { status: 409 })); await click('确认替换');
    expect(button('确认替换')!.disabled).toBe(true); await click('重新选择替换目标');
    fetcher.mockImplementation(async (url, init) => Response.json(String(url).includes('/replace-owned') ? (init?.method === 'PUT' ? ack : { ...ready, target: { ...target, version: 'b'.repeat(64) } }) : { success: true, items: {}, tags: [] }));
    await click('替换'); await click('确认替换');
    expect(writes()).toHaveLength(2); expect(JSON.parse(writes()[1][1]!.body as string).expectedVersion).toBe('b'.repeat(64));
  });

  test('真实目标仍是角色类型时拒绝原位替换，不隐式 repair', async () => {
    await renderPage(); await importDraft();
    fetcher.mockImplementation(async (url) => Response.json(String(url).includes('/replace-owned') ? { ...ready, target: { ...target, type: 'character' } } : { success: true, items: {}, tags: [] }));
    await chooseTarget(); expect(button('确认替换')).toBeUndefined();
    expect(window.alert).toHaveBeenCalledWith('目标卡片类型已变化，请重新选择');
    expect(writes()).toHaveLength(0); expect(dataCardApi.repairQuestionnaireType).not.toHaveBeenCalled();
  });

  test('确认期间账号换代不会派发旧写入或回显成功', async () => {
    await renderPage(); await importDraft(); await chooseTarget();
    let finish!: (value: { hasSensitiveWords: boolean }) => void;
    mocks.check.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await click('确认替换'); mocks.userId = 8; mocks.epoch = beginAuthIdentityTransition().identity.epoch; await renderPage();
    await act(async () => { finish({ hasSensitiveWords: false }); await flush(); });
    expect(writes()).toHaveLength(0); expect(window.alert).not.toHaveBeenCalled();
    expect(draftInput().value).toBe(JSON.stringify(questionnaire)); expect(button('确认替换')).toBeUndefined();
  });
});

describe('问卷兼容编辑保留本地稿的出口', () => {
  test('明确暂不支持原位覆写，编辑后的原始 JSON 仍可复制、下载和带复制跳转', async () => {
    await act(async () => { root.render(<QuestionnaireCompatModal isOpen onClose={vi.fn()} rawJson={JSON.stringify(questionnaire)} targetCard={{ id: card.id, name: card.name, description: card.description, isPublic: 0 }} />); await flush(); });
    expect(button('保存并替换此数据卡')).toBeUndefined();
    expect(container.textContent).toContain('暂不支持原位覆写'); expect(container.textContent).toContain('另存为新问卷');
    const raw = '{ edited but invalid JSON'; input(container.querySelector('textarea')!, raw);
    await click('复制 JSON'); expect(mocks.copy).toHaveBeenLastCalledWith(raw);
    await click('下载 JSON'); expect(mocks.download).toHaveBeenCalledOnce();
    const blob = mocks.download.mock.calls[0][0] as Blob;
    const downloaded = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
    expect(downloaded).toBe(raw);
    await click('复制并打开问卷编辑器'); expect(mocks.copy).toHaveBeenLastCalledWith(raw); expect(mocks.push).toHaveBeenCalledWith('/questionnaire-editor');
    expect(container.querySelector('textarea')!.value).toBe(raw); expect(writes()).toHaveLength(0);
    expect(dataCardApi.replaceCard).not.toHaveBeenCalled(); expect(dataCardApi.repairQuestionnaireType).not.toHaveBeenCalled();
  });
});

describe('问卷页在途云写的离页守卫', () => {
  test.each([['create', 7], ['replace', 7], ['create', 8], ['replace', 8]] as const)('账号换代不能提前释放已派发的 %s（当前用户 %s），原请求终态后恢复操作', async (kind, nextUserId) => {
    await renderPage(); await importDraft();
    if (kind === 'create') await click('保存为云端问卷'); else await chooseTarget();
    let finish!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    await click(kind === 'create' ? '保存' : '确认替换');
    expect(writes()).toHaveLength(1);
    const blocked = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
    const link = document.createElement('a'); link.href = '/leave-questionnaire'; document.body.append(link);
    let reachedLink = false;
    link.addEventListener('click', (event) => { reachedLink = true; event.preventDefault(); });
    try {
      expect(blocked()).toBe(true);
      mocks.userId = nextUserId; mocks.epoch = beginAuthIdentityTransition().identity.epoch; await renderPage();
      expect(blocked()).toBe(true);
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      expect(reachedLink).toBe(false);
      await click('替换已有'); expect(writes()).toHaveLength(1);
    } finally {
      await act(async () => { finish(Response.json(kind === 'create' ? { success: true, id: 'created-q', accountFenceVersion: 1, ownerUserId: 7 } : ack, { status: kind === 'create' ? 201 : 200 })); await flush(); });
      link.remove();
    }
    expect(blocked()).toBe(false); expect(window.alert).not.toHaveBeenCalled();
    document.body.append(link);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(reachedLink).toBe(true); link.remove();
    expect(button('保存为云端问卷')!.disabled).toBe(false); expect(button('替换已有')!.disabled).toBe(false);
    await click('保存为云端问卷'); expect(button('保存')).toBeTruthy(); expect(writes()).toHaveLength(1);
    expect(draftInput().value).toBe(JSON.stringify(questionnaire));
  });
  test('尚未派写的目标预览换代后不会留下持久离页锁', async () => {
    await renderPage(); await importDraft(); await click('替换已有');
    let finish!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    await click('替换');
    mocks.epoch = beginAuthIdentityTransition().identity.epoch; await renderPage();
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(writes()).toHaveLength(0);
    await act(async () => { finish(Response.json(ready)); await flush(); });
    expect(button('确认替换')).toBeUndefined(); expect(button('替换已有')!.disabled).toBe(false);
  });

});
