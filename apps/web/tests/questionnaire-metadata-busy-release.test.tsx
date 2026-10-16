// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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


test.each(['read', 'write'] as const)('picker metadata %s 换代后仅在请求终态释放，恢复保存入口且不回显旧成功', async (stage) => {
  await renderPage(); await importDraft(); await click('替换已有');
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  if (stage === 'read') fetcher.mockReturnValueOnce(pending);
  await click('修改信息');
  if (stage === 'write') { fetcher.mockReturnValueOnce(pending); await click('保存'); }
  expect(button('保存为云端问卷')?.disabled).toBe(true);
  mocks.epoch = beginAuthIdentityTransition().identity.epoch; await renderPage();
  expect(button('保存为云端问卷')?.disabled).toBe(true);
  expect(button('替换已有')?.disabled).toBe(true);
  await act(async () => { finish(Response.json(stage === 'read' ? ready : { success: true, id: card.id, accountFenceVersion: 1, ownerUserId: 7, metadataVersion: 1 })); await flush(); });
  expect(button('保存为云端问卷')?.disabled).toBe(false);
  expect(button('替换已有')?.disabled).toBe(false);
  expect(document.body.textContent).not.toContain('数据卡信息已更新');
  expect(document.querySelector('[aria-label="名称"]')).toBeNull();
  expect(window.alert).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(stage === 'write' ? 1 : 0);
  expect(draftInput().value).toBe(JSON.stringify(questionnaire));
  await click('替换已有'); expect(button('替换')).toBeTruthy();
});
