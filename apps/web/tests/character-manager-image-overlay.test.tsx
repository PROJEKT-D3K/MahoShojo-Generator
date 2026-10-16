// @vitest-environment jsdom
import React, { act, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Real Manager, Web list adapters, shared lists and deletion dialogs. Only
// accounts, read ports, image encoding and unrelated page panels are isolated.
const boundary = vi.hoisted(() => ({
  imageUrl: 'data:image/png;base64,cHJldmlldw==',
  finishExport: null as (() => void) | null,
  deleteWrite: vi.fn(), save: vi.fn(), download: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: 7, username: 'tester' }, identityEpoch: 1, authSource: 'better-auth-session', loading: false, isAuthenticated: true }) }));
vi.mock('@/components/me/authMigrationStatus', () => ({ loadAuthMigrationStatus: async () => ({ migrationRequired: false, legacyOnly: false, authSource: 'better-auth-session', hasAuthLink: true, hasPassword: true, emailVerified: true }) }));
vi.mock('@/lib/auth', () => ({
  dataCardApi: { getUserCapacity: async () => ({ capacity: 10, usedSlots: 1 }), replaceCard: boundary.save },
  authStorage: { getAuthHeader: async () => null, fetch: async () => Response.json({ success: true, badges: [] }) },
}));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false, matchDetails: [] }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: boundary.download }));
vi.mock('@/lib/local-library/save-local-data-card', () => ({ saveLocalDataCard: boundary.save }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ({ onSaveImage }: { onSaveImage: (url: string) => void }) =>
  <button type="button" onClick={() => { boundary.finishExport = () => onSaveImage(boundary.imageUrl); }}>导出测试卡片图片</button>,
}));
vi.mock('@/components/MagicalGirlCard', () => ({ default: () => null }));
vi.mock('@/components/CanshouCard', () => ({ default: () => null }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));
vi.mock('@/components/CharManager/AuthModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/SaveCardModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/NarrativeHistoryCardEditorModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/QuestionnaireCompatModal', () => ({ default: () => null }));
vi.mock('@/components/UserTitle', () => ({ UserWithTitle: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/lib/data-card-list-client', () => ({
  getDataCardSummaryPage: async () => ({ success: true, cards: [{ id: 'owned-card', name: '待确认卡片', type: 'character', description: '原描述', is_public: 1, review_status: 'approved', usage_count: 0, like_count: 0, favorite_count: 0 }], total: 1, nextOffset: null }),
  loadFullDataCard: async () => { throw new Error('unexpected body read'); },
}));
vi.mock('@/lib/owned-card-delete', () => ({ createWebOwnedCardDeletePort: (expectedUserId: number, identity: { isCurrent: () => boolean }, options: object) => ({
  ...options, expectedUserId, isCurrent: identity.isCurrent,
  preview: async (scope: string) => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: expectedUserId, operation: `preview-${scope}`, targets: [{ id: 'owned-card', type: 'character', name: '待确认卡片', description: null, version: 'a'.repeat(64) }], total: 1, recycleLimit: 5 } }),
  write: boundary.deleteWrite,
}) }));
vi.mock('@/lib/owned-recycle-bin', () => ({ createWebRecycleBinPort: (_ownerId: number, identity: { isCurrent: () => boolean }) => ({
  isCurrent: identity.isCurrent,
  readPage: async () => ({ success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [{ id: 'owned-card', type: 'character', name: '待确认卡片', description: '', is_public: 0, review_status: null, created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false }], total: 1, filteredCount: 1, nextOffset: null }),
  readDetail: async () => { throw new Error('unexpected body read'); },
}) }));

import { CharacterManagerPage } from '@/components/character/CharacterManagerPage';
import { writeCharacterManagerPageDraft } from '@/lib/character-manager-page-draft';

let root: Root;
let host: HTMLDivElement;
const findButton = (text: string, scope: ParentNode = document) => {
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')];
  const found = buttons.find((node) => node.textContent?.trim() === text)
    ?? buttons.find((node) => node.textContent?.includes(text));
  expect(found, `按钮 ${text}`).toBeTruthy();
  return found!;
};
const findDialog = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find((node) => document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent === name);
const imagePreview = () => findDialog('图片预览');
async function click(node: HTMLElement) { await act(async () => { node.click(); }); }
async function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document).dispatchEvent(event); });
  return event;
}
beforeEach(() => {
  localStorage.clear(); boundary.finishExport = null;
  boundary.deleteWrite.mockReset(); boundary.save.mockReset(); boundary.download.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (url === '/api/data-card-meta-batch') return Response.json({ success: true, items: {} });
    throw new Error(`Unexpected request: ${String(url)}`);
  }));
  const card = { templateId: '通用角色', name: '雾灯', content: '角色正文' };
  writeCharacterManagerPageDraft({ pastedJson: '', characterData: card, originalData: card, isNative: false, selectedTemplate: 'general' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals();
});

it.each(['active', 'recycle'] as const)('Manager suspends late image preview during %s deletion and restores it after the list closes', async (kind) => {
  await act(async () => { root.render(<CharacterManagerPage />); });
  const exportButton = findButton('导出测试卡片图片'); exportButton.focus(); await click(exportButton);
  expect(boundary.finishExport).toBeTypeOf('function');
  await click(findButton('我的数据卡'));
  if (kind === 'recycle') await click(findButton('回收站'));
  const list = findDialog(kind === 'active' ? '我的数据卡' : '云端回收站')!;
  expect(list).toBeTruthy();
  const deleteLabel = kind === 'active' ? '删除' : '永久删除…';
  const deleteTitle = kind === 'active' ? '删除数据卡' : '确认永久删除';
  await click(findButton(deleteLabel, list));
  const deletion = findDialog(deleteTitle)!;
  expect(deletion).toBeTruthy();
  expect(deletion.textContent).toContain('待确认卡片');
  const cancel = deletion.querySelector<HTMLButtonElement>('button[aria-label="取消"]')!;
  expect(document.activeElement).toBe(cancel);
  await act(async () => { boundary.finishExport!(); });
  expect(document.activeElement, '图片完成不能抢走删除确认初始焦点').toBe(cancel);
  expect(imagePreview()).toBeUndefined();

  const confirm = findButton(kind === 'active' ? '移入回收站' : '确认永久删除', deletion);
  confirm.focus();
  expect((await key('Tab')).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(cancel);
  expect((await key('Tab', true)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(confirm);
  await key('Escape');
  expect(findDialog(deleteTitle)).toBeUndefined();
  expect(document.contains(list)).toBe(true);
  expect(imagePreview()).toBeUndefined();

  await click(findButton(deleteLabel, list));
  await click(findDialog(deleteTitle)!.querySelector<HTMLButtonElement>('button[aria-label="取消"]')!);
  expect(findDialog(deleteTitle)).toBeUndefined();
  expect(imagePreview()).toBeUndefined();
  await click(list.querySelector<HTMLButtonElement>('button[aria-label="关闭对话框"], button[aria-label="关闭"]')!);
  expect(document.contains(list)).toBe(false);
  const preview = imagePreview()!;
  expect(preview.querySelector('img')?.getAttribute('src')).toBe(boundary.imageUrl);
  expect(document.activeElement).toBe(preview.querySelector('button'));
  await key('Escape');
  expect(imagePreview()).toBeUndefined();
  expect(boundary.deleteWrite).not.toHaveBeenCalled();
  expect(boundary.save).not.toHaveBeenCalled();
  expect(boundary.download).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/data-card-meta-batch')).toBe(true);
});
