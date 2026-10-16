// @vitest-environment jsdom
import React, { act, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Keep the page owners and the real shared modal. Only export rendering, accounts,
// navigation and unrelated remote panels are isolated from this assembly test.
const boundary = vi.hoisted(() => ({
  imageUrl: 'data:image/png;base64,cHJldmlldw==',
  pendingExport: null as null | (() => void),
  authenticated: true,
  delayImage: false,
  deleteWrite: vi.fn(),
  dispatch: vi.fn(),
  capture: vi.fn(),
  download: vi.fn(),
  revoke: vi.fn(),
  create: vi.fn(),
}));
type ExportProps = { onSaveImage?: (url: string) => void };
function ExportCard({ onSaveImage }: ExportProps) {
  return <button type="button" onClick={() => { if (boundary.delayImage) boundary.pendingExport = () => onSaveImage?.(boundary.imageUrl); else onSaveImage?.(boundary.imageUrl); }}>导出测试卡片图片</button>;
}
vi.mock('@/components/MagicalGirlCard', () => ({ default: ExportCard }));
vi.mock('@/components/CanshouCard', () => ({ default: ExportCard }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ExportCard }));
vi.mock('@/components/arena/components/BattleResult', () => ({ BattleResult: ExportCard }));
vi.mock('@/components/arena/components/BattleStorySessionPanel', () => ({ BattleStorySessionPanel: () => null }));
vi.mock('@zumer/snapdom', () => ({ snapdom: { toBlob: boundary.capture } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: boundary.authenticated ? { id: 7, username: 'tester' } : null, identityEpoch: 1, authSource: 'legacy-bearer', loading: false, isAuthenticated: boundary.authenticated }) }));
vi.mock('@/lib/auth', () => ({ dataCardApi: { getUserCapacity: async () => ({ capacity: 10, usedSlots: 0 }) }, authStorage: { getAuth: async () => null, getAuthHeader: async () => null, getActivityHeaders: async () => ({}), fetch: async () => Response.json({ success: true, badges: [] }) } }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: boundary.dispatch }) }) }));
vi.mock('@/lib/cooldown', () => ({
  useCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }),
  useProviderModeCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }),
}));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: async () => null }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: async () => ({ hasSensitiveWords: false, matchDetails: [] }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: boundary.download }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/TachieGenerator', () => ({ default: () => null }));
vi.mock('@/components/shared/CharacterPortraitAssetPanel', () => ({ CharacterPortraitAssetPanel: () => null }));

vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));

vi.mock('@/components/UserTitle', () => ({ UserWithTitle: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryModal', () => ({ NarrativeHistoryModal: () => null }));
vi.mock('@/components/arena/components/NarrativeHistoryPickerModal', () => ({ NarrativeHistoryPickerModal: () => null }));
vi.mock('@/components/arena/components/BattleActions', () => ({ BattleActions: () => null }));
vi.mock('@/components/arena/components/CombatantList', () => ({ CombatantList: () => null }));
vi.mock('@/components/arena/components/DatabaseSelector', () => ({ DatabaseSelector: () => null }));
vi.mock('@/components/arena/components/MaterialPanel', () => ({ MaterialPanel: () => null }));
vi.mock('@/components/arena/components/PresetSelector', () => ({ PresetSelector: () => null }));
vi.mock('@/components/arena/components/RosterUploader', () => ({ RosterUploader: () => null }));
vi.mock('@/components/arena-lite/BattleLiteHeader', () => ({ BattleLiteHeader: () => null }));
vi.mock('@/components/arena-lite/BattleLiteScenarioSection', () => ({ BattleLiteScenarioSection: () => null }));
vi.mock('@/components/arena/hooks/useBattleActions', () => ({ useBattleActions: () => ({
  handleSelectDataCard: vi.fn(), handleRandomMatch: vi.fn(), handleToggleCombatantDataCard: vi.fn(), handleToggleMaterialDataCard: vi.fn(),
}) }));

import { EntityRatingHistoryModal } from '@mahoshojo/ui-web/ranking';
import { DataCardReportModal } from '@/components/data-card-reports/DataCardReportModal';
import { CanshouPage } from '@/components/creation/CanshouPage';
import { CharacterPartyPage } from '@/components/character/CharacterPartyPage';
import { SublimationPage } from '@/components/competition/SublimationPage';
import { BattleLitePage } from '@/components/arena-lite/BattleLitePage';
import { magicalQuestionnaire, canshouQuestionnaire } from '@/lib/questionnaire-presets';
import { ClientRouteAdapterProvider } from '@/lib/client-route-adapter';

const source = { templateId: '通用角色', name: '雾灯', content: '角色正文' };
let host: HTMLDivElement;
let root: Root;
const button = (label: string, scope: ParentNode = host) => {
  const target = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label));
  expect(target, `按钮 ${label}`).toBeTruthy();
  return target!;
};
async function click(target: HTMLElement) { await act(async () => { target.click(); }); }
async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(page: React.ReactNode) { await act(async () => { root.render(page); }); }
async function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { (document.activeElement ?? document).dispatchEvent(event); });
  return event;
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const exportImage = () => button('导出测试卡片图片');

beforeEach(() => {
  localStorage.clear();
  boundary.delayImage = false; boundary.pendingExport = null; boundary.deleteWrite.mockReset();
  boundary.imageUrl = 'data:image/png;base64,cHJldmlldw==';
  boundary.create.mockReset().mockReturnValueOnce('blob:name-first').mockReturnValueOnce('blob:name-second').mockReturnValue('blob:name-third');
  boundary.revoke.mockReset();
  boundary.capture.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  boundary.dispatch.mockImplementation(async (path: string) => {
    if (path === '/api/generate-sublimation') return Response.json({ targetTemplate: 'general', sublimatedData: { ...source, content: '升华正文' } });
    throw new Error(`Unexpected generation boundary: ${path}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/api/data-card-meta-batch') return Response.json({ success: true, items: {} });
    if (url === '/languages.json') return Response.json([{ code: 'zh-CN', name: '简体中文' }]);
    if (url === '/questionnaires/presets/index.json') return Response.json({ presets: [magicalQuestionnaire, canshouQuestionnaire].map((questionnaire) => ({ id: questionnaire.id, kind: questionnaire.kind, title: questionnaire.title, path: `/questionnaires/${questionnaire.id}.json`, isDefault: true })) });
    if (url === `/questionnaires/${magicalQuestionnaire.id}.json`) return Response.json(magicalQuestionnaire);
    if (url === `/questionnaires/${canshouQuestionnaire.id}.json`) return Response.json(canshouQuestionnaire);
    if (url === '/api/verify-origin') return Response.json({ isValid: false, isNative: false });
    throw new Error(`Unexpected fetch boundary: ${url}`);
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mobi test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: boundary.create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: boundary.revoke });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function expectPreviewLifecycle(
  opener: HTMLButtonElement,
  imageAlt: string,
  closeOnBackdrop: boolean,
) {
  opener.focus();
  await click(opener);
  const image = document.querySelector<HTMLImageElement>(`img[alt="${imageAlt}"]`);
  expect(image, 'owner 导出回调确已显示预览图片').not.toBeNull();
  expect(image!.getAttribute('src')).toBe(boundary.imageUrl);
  const preview = dialog();
  expect(preview, `${imageAlt} 应装配真实共享对话框`).not.toBeNull();
  expect(preview!.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(preview!.getAttribute('aria-labelledby')!)?.textContent).toBe('图片预览');
  expect(preview!.querySelector<HTMLImageElement>('img')?.alt).toBe(imageAlt);
  const close = preview!.querySelector<HTMLButtonElement>('button')!;
  expect(close.getAttribute('aria-label')).toBe('关闭');
  expect(document.activeElement).toBe(close);
  expect(document.body.style.overflow).toBe('hidden');
  const region = preview!.querySelector<HTMLElement>('[role="region"]')!;
  region.focus();
  expect((await key('Tab')).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);
  expect((await key('Tab', true)).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(region);
  await click(preview!.querySelector('img')!);
  expect(dialog()).toBe(preview);
  await click(preview!.parentElement!.querySelector<HTMLButtonElement>(':scope > button')!);
  if (closeOnBackdrop) {
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.focus(); await click(opener);
  } else expect(dialog()).toBe(preview);
  await key('Escape');
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
  opener.focus(); await click(opener);
  await click(dialog()!.querySelector('button')!);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
  expect((await key('Escape')).defaultPrevented).toBe(false);
}

vi.mock('@/lib/data-card-list-client', () => ({
  getDataCardSummaryPage: async () => ({ success: true, cards: [{ id: 'owned-card', name: '待确认卡片', type: 'character', description: '原描述', is_public: 1, review_status: 'approved', usage_count: 0, like_count: 0, favorite_count: 0 }], total: 1, nextOffset: null }),
  loadFullDataCard: async () => { throw new Error('unexpected body read'); },
}));
vi.mock('@/lib/owned-card-delete', () => ({ createWebOwnedCardDeletePort: (expectedUserId: number, identity: { isCurrent: () => boolean }, options: object) => ({
  ...options, expectedUserId, isCurrent: identity.isCurrent,
  preview: async (scope: string) => ({ status: 200, body: { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: expectedUserId, operation: `preview-${scope}`, targets: [{ id: 'owned-card', type: 'character', name: '待确认卡片', description: null, version: 'a'.repeat(64) }], total: 1, recycleLimit: 5 } }),
  write: boundary.deleteWrite,
}) }));
vi.mock('@/lib/owned-recycle-bin', () => ({ createWebRecycleBinPort: () => ({
  isCurrent: () => true,
  readPage: async () => ({ success: true, accountFenceVersion: 1, ownerUserId: 7, cards: [{ id: 'owned-card', type: 'character', name: '待确认卡片', description: '', is_public: 0, review_status: null, created_at: null, updated_at: null, deleted_at: 'now', usage_count: 0, like_count: 0, isLegacyQuestionnaire: false }], total: 1, filteredCount: 1, nextOffset: null }),
  readDetail: async () => { throw new Error('unexpected body read'); },
}) }));

async function preparePage(page: 'Canshou' | 'Party' | 'Sublimation' | 'BattleLite') {
  if (page === 'Canshou') {
    await mount(<CanshouPage />); await click(button('快速随机生成'));
  } else if (page === 'Party') {
    await mount(<CharacterPartyPage />);
    await setValue(host.querySelector<HTMLTextAreaElement>('#team-paste-json')!, JSON.stringify([source]));
    await click(button('解析并添加'));
  } else if (page === 'Sublimation') {
    localStorage.setItem('mahoshojo.sublimation.preferences.v1', JSON.stringify({ generationMode: 'non-stream', targetTemplate: 'general' }));
    await mount(<ClientRouteAdapterProvider adapter={{ isReady: true, query: {}, push: async () => {}, replace: async () => {} }}><SublimationPage /></ClientRouteAdapterProvider>);
    const upload = host.querySelector<HTMLInputElement>('#character-upload')!;
    Object.defineProperty(upload, 'files', { value: [{ type: 'application/json', name: 'source.json', text: async () => JSON.stringify(source) }] });
    await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('开始升华'));
  } else await mount(<BattleLitePage />);
}

it.each([
  ['Canshou', '残兽档案', false], ['Party', '角色卡片', true],
  ['Sublimation', '角色卡片', false], ['BattleLite', '魔法少女战斗报告', false],
] as const)('%s uses the shared accessible preview and preserves its dismiss policy', async (page, alt, backdrop) => {
  await preparePage(page);
  const generationCalls = boundary.dispatch.mock.calls.length;
  await expectPreviewLifecycle(exportImage(), alt, backdrop);
  expect(boundary.dispatch.mock.calls.length, '关闭图片不能重新生成').toBe(generationCalls);
});

it.each(['active', 'recycle'] as const)('late Canshou PNG yields to real SaveToCloud %s deletion until the entire modal chain closes', async kind => {
  await preparePage('Canshou');
  boundary.delayImage = true;
  const opener = exportImage(); opener.focus(); await click(opener);
  expect(boundary.pendingExport).toBeTypeOf('function');
  await click(button('替换已有'));
  if (kind === 'recycle') await click(button('回收站', document));
  const deleteTrigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === (kind === 'active' ? '删除' : '永久删除…'))!;
  expect(deleteTrigger).toBeTruthy(); deleteTrigger.focus(); await click(deleteTrigger);
  const deletion = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(node => node.textContent?.includes(kind === 'active' ? '确认将以下数据卡移入回收站' : '以下数据卡及其关联记录将永久删除'))!;
  expect(deletion).toBeTruthy();
  const initialFocus = document.activeElement;
  await act(async () => boundary.pendingExport!());
  expect(document.querySelector('img[alt="残兽档案"]'), '迟到图片保留于 owner，不遮住确认框').toBeNull();
  expect(document.activeElement).toBe(initialFocus);
  const cancel = deletion.querySelector<HTMLButtonElement>('button[aria-label="取消"]')!;
  cancel.focus(); await key('Tab', true);
  expect(deletion.contains(document.activeElement)).toBe(true);
  await key('Escape');
  expect(document.contains(deletion)).toBe(false);
  expect(document.querySelector('img[alt="残兽档案"]')).toBeNull();
  expect(document.body.style.overflow).toBe('hidden');
  await key('Escape');
  const preview = dialog()!;
  expect(preview.querySelector('img')?.getAttribute('src')).toBe(boundary.imageUrl);
  expect(preview.contains(document.activeElement)).toBe(true);
  await key('Escape');
  expect(dialog()).toBeNull();
  expect(document.activeElement?.isConnected).toBe(true);
  expect(document.body.style.overflow).toBe('');
  expect(boundary.deleteWrite).not.toHaveBeenCalled();
  expect(boundary.revoke).not.toHaveBeenCalled();
});

it('BattleLite releases its Blob only on actual close or owner unmount', async () => {
  boundary.imageUrl = 'blob:battle-first';
  await preparePage('BattleLite');
  const opener = exportImage(); opener.focus(); await click(opener);
  expect(dialog()).not.toBeNull();
  await key('Escape'); expect(dialog()).toBeNull();
  expect(boundary.revoke.mock.calls).toEqual([['blob:battle-first']]);
  boundary.imageUrl = 'blob:battle-second';
  opener.focus(); await click(opener);
  await mount(null);
  expect(boundary.revoke.mock.calls).toEqual([['blob:battle-first'], ['blob:battle-second']]);
});


it.each([
  ['report', 'image-first'], ['report', 'modal-first'],
  ['rating', 'image-first'], ['rating', 'modal-first'],
] as const)('BattleLite retains its Blob while the real %s layer is foreground (%s)', async (kind, order) => {
  boundary.imageUrl = 'blob:retained-report';
  boundary.delayImage = order === 'modal-first';
  const close = vi.fn(); const submit = vi.fn();
  const view = (open: boolean) => <>
    <BattleLitePage />
    {kind === 'report' ? <DataCardReportModal isOpen={open} cardName="待查看卡片" reasons={[]} initialReport={null} submitting={false} error={null} onClose={close} onSubmit={submit} />
      : <EntityRatingHistoryModal isOpen={open} onClose={close} loading={false} error={null} items={[]} onRetry={() => {}} />}
  </>;
  await mount(view(false));
  const opener = exportImage(); opener.focus(); await click(opener);
  await mount(view(true));
  const foreground = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(node => !node.querySelector('img'))!;
  expect(foreground).toBeTruthy();
  const foregroundFocus = document.activeElement;
  if (boundary.pendingExport) await act(async () => boundary.pendingExport!());
  expect(document.querySelector('img[alt="魔法少女战斗报告"]')).toBeNull();
  expect(document.activeElement).toBe(foregroundFocus);
  expect(foreground.contains(document.activeElement)).toBe(true);
  await key('Escape'); expect(close).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled(); expect(boundary.revoke).not.toHaveBeenCalled();
  await mount(view(false));
  expect(dialog()!.querySelector('img')?.getAttribute('src')).toBe('blob:retained-report');
  await key('Escape');
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(opener);
  expect(boundary.revoke.mock.calls).toEqual([['blob:retained-report']]);
});

it('closing a late Sublimation preview never aborts or repeats an in-flight generation', async () => {
  await preparePage('Sublimation');
  boundary.delayImage = true;
  await click(exportImage());
  const stream = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === '流式')!;
  expect(stream).toBeTruthy(); await click(stream);
  let settle!: (response: Response) => void;
  boundary.dispatch.mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }));
  await click(button('开始升华'));
  const [, request] = boundary.dispatch.mock.calls.at(-1)!;
  const signal = request.signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  const callCount = boundary.dispatch.mock.calls.length;
  await act(async () => boundary.pendingExport!());
  expect(dialog()!.querySelector('img')?.getAttribute('src')).toBe(boundary.imageUrl);
  await key('Escape');
  expect(dialog()).toBeNull(); expect(button('升华中...').disabled).toBe(true);
  expect(signal.aborted).toBe(false); expect(boundary.dispatch.mock.calls).toHaveLength(callCount);
  await act(async () => { settle(Response.json({ error: '测试结束' }, { status: 503 })); });
});

it('a late preview cannot dismiss or abort the real cloud deletion while its write is pending', async () => {
  await preparePage('Canshou');
  boundary.delayImage = true; await click(exportImage());
  await click(button('替换已有'));
  const deletionTrigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === '删除')!;
  await click(deletionTrigger);
  let settle!: (response: { status: number; body: unknown }) => void;
  boundary.deleteWrite.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  await click(button('移入回收站', document));
  const signal = boundary.deleteWrite.mock.calls[0]![1] as AbortSignal;
  await act(async () => boundary.pendingExport!());
  expect(document.querySelector('img[alt="残兽档案"]')).toBeNull();
  await key('Escape'); await key('Escape');
  expect(document.body.textContent).toContain('正在处理，请等待结果');
  expect(signal.aborted).toBe(false); expect(boundary.deleteWrite).toHaveBeenCalledOnce();
  await act(async () => { settle({ status: 500, body: {} }); });
  expect(document.body.textContent).toContain('删除结果不确定');
  await key('Escape');
  expect(document.querySelector('img[alt="残兽档案"]')).toBeNull();
  await key('Escape');
  expect(dialog()!.querySelector('img')?.getAttribute('src')).toBe(boundary.imageUrl);
  await key('Escape');
  expect(dialog()).toBeNull(); expect(boundary.deleteWrite).toHaveBeenCalledOnce();
  expect(document.body.style.overflow).toBe('');
});
