// @vitest-environment jsdom
import React, { act, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the page owners and the real shared modal. Only export rendering, accounts,
// navigation and unrelated remote panels are isolated from this assembly test.
const boundary = vi.hoisted(() => ({
  imageUrl: 'data:image/png;base64,cHJldmlldw==',
  delayImageExport: false,
  pendingExport: null as (() => void) | null,
  authenticated: false,
  login: vi.fn(),
  dispatch: vi.fn(),
  capture: vi.fn(),
  download: vi.fn(),
  revoke: vi.fn(),
  create: vi.fn(),
}));
type ExportProps = { onSaveImage?: (url: string) => void };
function ExportCard({ onSaveImage }: ExportProps) {
  return <button type="button" onClick={() => {
    const imageUrl = boundary.imageUrl;
    if (boundary.delayImageExport) boundary.pendingExport = () => onSaveImage?.(imageUrl);
    else onSaveImage?.(imageUrl);
  }}>导出测试卡片图片</button>;
}
vi.mock('@/components/MagicalGirlCard', () => ({ default: ExportCard }));
vi.mock('@/components/CanshouCard', () => ({ default: ExportCard }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: ExportCard }));
vi.mock('@zumer/snapdom', () => ({ snapdom: { toBlob: boundary.capture } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({
  user: boundary.authenticated ? { id: 'test-user', username: 'tester' } : null,
  identityEpoch: 1, authSource: 'legacy-bearer', loading: false,
  isAuthenticated: boundary.authenticated, login: boundary.login,
}) }));
vi.mock('@/components/me/authMigrationStatus', () => ({ loadAuthMigrationStatus: async () => ({
  migrationRequired: true, legacyOnly: true, authSource: 'legacy-bearer',
  hasAuthLink: false, authUserId: null, hasPassword: false, emailVerified: false,
}) }));
vi.mock('@/lib/auth', () => ({
  dataCardApi: { getUserCapacity: async () => ({ capacity: 10, usedSlots: 0 }) },
  authStorage: { getActivityHeaders: async () => ({}), fetch: async () => Response.json({ success: true, badges: [] }) },
}));
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
vi.mock('@/components/SaveToCloudButton', () => ({ default: () => null }));
vi.mock('@/components/BattleDataModal', () => ({ default: () => null }));
vi.mock('@/components/DataCardDetailsModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/AuthModal', () => ({
  default: ({ isOpen, onClose, onLogin }: {
    isOpen: boolean;
    onClose: () => void;
    onLogin: (identifier: string, credential: string, token: string, mode: 'legacy') => Promise<unknown>;
  }) => isOpen ? <section aria-label="测试登录边界">
    <button type="button" onClick={() => { void onLogin('test-user', 'test-credential', '', 'legacy'); }}>提交测试旧密钥登录</button>
    <button type="button" onClick={onClose}>关闭测试登录</button>
  </section> : null,
}));
vi.mock('@/components/CharManager/SaveCardModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/DataCardsModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/RecycleBinModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/NarrativeHistoryCardEditorModal', () => ({ default: () => null }));
vi.mock('@/components/CharManager/QuestionnaireCompatModal', () => ({ default: () => null }));
vi.mock('@/components/UserTitle', () => ({ UserWithTitle: () => null }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/ai/AiReasoningPanel', () => ({ default: () => null }));
vi.mock('@/components/ai/ProviderCooldownNotice', () => ({ ProviderCooldownNotice: () => null }));


import { DetailsPage } from '@/components/creation/DetailsPage';
import { NamePage } from '@/components/creation/NamePage';
import { CharacterManagerPage } from '@/components/character/CharacterManagerPage';
import { writeCharacterManagerPageDraft } from '@/lib/character-manager-page-draft';
import { magicalQuestionnaire } from '@/lib/questionnaire-presets';

const source = { templateId: '通用角色', name: '雾灯', content: '角色正文' };
const generatedName = {
  flowerName: '铃兰', flowerDescription: '幸福归来',
  appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' },
  spell: '花よ', signature: 'server', templateId: 'server-template',
};
let host: HTMLDivElement;
let root: Root;
const button = (label: string, scope: ParentNode = host) => {
  const target = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label));
  expect(target, `按钮 ${label}`).toBeTruthy();
  return target!;
};
async function click(target: HTMLElement) { await act(async () => { target.click(); }); }
async function setValue(element: HTMLInputElement, value: string) {
  const prototype = HTMLInputElement.prototype;
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
  boundary.imageUrl = 'data:image/png;base64,cHJldmlldw==';
  boundary.authenticated = false;
  boundary.delayImageExport = false;
  boundary.pendingExport = null;
  boundary.login.mockReset().mockResolvedValue({ success: true });
  boundary.create.mockReset().mockReturnValueOnce('blob:name-first').mockReturnValueOnce('blob:name-second').mockReturnValue('blob:name-third');
  boundary.revoke.mockReset();
  boundary.capture.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  boundary.dispatch.mockImplementation(async (path: string) => {
    if (path === '/api/generate-magical-girl') return Response.json(generatedName);
    throw new Error(`Unexpected generation boundary: ${path}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/languages.json') return Response.json([{ code: 'zh-CN', name: '简体中文' }]);
    if (url === '/questionnaires/presets/index.json') return Response.json({ presets: [magicalQuestionnaire].map((questionnaire) => ({ id: questionnaire.id, kind: questionnaire.kind, title: questionnaire.title, path: `/questionnaires/${questionnaire.id}.json`, isDefault: true })) });
    if (url === `/questionnaires/${magicalQuestionnaire.id}.json`) return Response.json(magicalQuestionnaire);
    throw new Error(`Unexpected fetch boundary: ${url}`);
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mobi test');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: boundary.create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: boundary.revoke });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

const legacyDeferKey = 'mahoshojo_auth_migration_defer_count';
const legacyReminder = () => [...host.querySelectorAll('h3')]
  .find((heading) => heading.textContent === '旧密钥登录迁移提醒')?.parentElement ?? null;

describe('CharacterManager image preview yields to the existing legacy migration reminder', () => {
  it.each([
    ['reminder-first', 0], ['reminder-first', 3],
    ['image-first', 0], ['image-first', 3],
  ] as const)('%s preserves reminder controls and defer count %i', async (order, deferCount) => {
    localStorage.setItem(legacyDeferKey, String(deferCount));
    boundary.authenticated = order === 'reminder-first';
    boundary.delayImageExport = order === 'reminder-first';
    const imageUrl = boundary.imageUrl;
    writeCharacterManagerPageDraft({ pastedJson: '', characterData: source, originalData: source, isNative: false, selectedTemplate: 'general' });
    await mount(<CharacterManagerPage />);

    if (order === 'reminder-first') {
      const opener = exportImage(); opener.focus(); await click(opener);
      expect(boundary.pendingExport).toBeTypeOf('function');
      expect(dialog()).toBeNull();
      const trigger = button('查看迁移说明'); trigger.focus(); await click(trigger);
      const link = legacyReminder()!.querySelector<HTMLAnchorElement>('a[href="/settings?section=account"]')!;
      link.focus();
      await act(async () => { boundary.pendingExport!(); });
      expect(document.activeElement, '迟到图片不能抢走提醒里的焦点').toBe(link);
    } else {
      let completeLogin!: (result: { success: true }) => void;
      boundary.login.mockImplementationOnce(() => new Promise((resolve) => { completeLogin = resolve; }));
      await click(button('登录 / 注册'));
      await click(button('提交测试旧密钥登录'));
      expect(boundary.login).toHaveBeenCalledWith('test-user', 'test-credential', '', 'legacy');
      // The real AuthModal also permits closing while login is pending.
      await click(button('关闭测试登录'));
      const opener = exportImage(); opener.focus(); await click(opener);
      expect(dialog()!.querySelector('img')?.getAttribute('src')).toBe(imageUrl);
      await act(async () => { boundary.authenticated = true; completeLogin({ success: true }); });
    }

    const reminder = legacyReminder();
    expect(reminder).not.toBeNull();
    expect(dialog(), '提醒出现时图片预览应暂停其焦点约束').toBeNull();
    const migrationLink = reminder!.querySelector<HTMLAnchorElement>('a[href="/settings?section=account"]')!;
    migrationLink.focus();
    expect((await key('Tab')).defaultPrevented, '不能由隐藏图片捕获 Tab').toBe(false);
    expect(document.activeElement).toBe(migrationLink);
    expect((await key('Tab', true)).defaultPrevented).toBe(false);
    await key('Escape');
    expect(legacyReminder()).toBe(reminder);
    expect(localStorage.getItem(legacyDeferKey)).toBe(String(deferCount));
    expect(boundary.revoke).not.toHaveBeenCalled();

    const deferButton = [...reminder!.querySelectorAll('button')].find((node) => node.textContent === '稍后处理');
    if (deferCount >= 3) {
      expect(deferButton).toBeUndefined();
      expect(reminder!.textContent).toContain('本次登录需先完成迁移设置后再继续使用');
      await key('Escape');
      expect(legacyReminder()).toBe(reminder);
      expect(dialog()).toBeNull();
      expect(localStorage.getItem(legacyDeferKey)).toBe('3');
    } else {
      expect(deferButton).toBeTruthy();
      await click(deferButton!);
      expect(legacyReminder()).toBeNull();
      expect(localStorage.getItem(legacyDeferKey)).toBe('1');
      const preview = dialog()!;
      expect(preview.querySelector('img')?.getAttribute('src')).toBe(imageUrl);
      expect(document.activeElement).toBe(preview.querySelector('button'));
      await key('Escape');
      expect(dialog()).toBeNull();
      expect(legacyReminder()).toBeNull();
      expect(localStorage.getItem(legacyDeferKey)).toBe('1');
      expect(boundary.revoke).not.toHaveBeenCalled();
    }
  });
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
  options: { imageUrl?: string; layer?: string; afterFirstClose?: () => void } = {},
) {
  opener.focus();
  await click(opener);
  const image = document.querySelector<HTMLImageElement>(`img[alt="${imageAlt}"]`);
  expect(image, 'owner 导出回调确已显示预览图片').not.toBeNull();
  expect(image!.getAttribute('src')).toBe(options.imageUrl ?? boundary.imageUrl);
  const preview = dialog();
  expect(preview, `${imageAlt} 应装配真实共享对话框`).not.toBeNull();
  expect(preview!.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(preview!.getAttribute('aria-labelledby')!)?.textContent).toBe('图片预览');
  expect(preview!.querySelector<HTMLImageElement>('img')?.alt).toBe(imageAlt);
  if (options.layer) expect(preview!.parentElement!.classList.contains(options.layer)).toBe(true);
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
  options.afterFirstClose?.();
  opener.focus(); await click(opener);
  await click(dialog()!.querySelector('button')!);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe('');
  expect((await key('Escape')).defaultPrevented).toBe(false);
}

describe('Web image preview assembly through real page owners', () => {
  it('Details quick-local result exports to the modal and keeps its dismiss policy', async () => {
    await mount(<DetailsPage />);
    await click(button('快速随机生成'));
    await expectPreviewLifecycle(exportImage(), '魔法少女详细档案', false, { layer: 'z-[1000]' });
    expect(boundary.dispatch).not.toHaveBeenCalled();
    expect(boundary.revoke).not.toHaveBeenCalled();
  });

  it('Name uses its real PNG export, keeps mobile blobs until replacement/unmount, and restores focus', async () => {
    await mount(<NamePage />);
    await setValue(host.querySelector<HTMLInputElement>('#name')!, '小满');
    await click(button('へんしん'));
    const opener = button('保存为图片');
    await expectPreviewLifecycle(opener, '魔法少女登记表', false, {
      imageUrl: 'blob:name-first',
      afterFirstClose: () => expect(boundary.revoke).not.toHaveBeenCalled(),
    });
    expect(boundary.capture).toHaveBeenCalledTimes(2);
    expect(boundary.create).toHaveBeenCalledTimes(2);
    expect(boundary.revoke.mock.calls).toEqual([['blob:name-first']]);
    expect(boundary.download).not.toHaveBeenCalled();
    await mount(null);
    expect(boundary.revoke.mock.calls).toEqual([['blob:name-first'], ['blob:name-second']]);
  });

  it('Name desktop PNG export still downloads without opening or owning a preview URL', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Desktop test');
    await mount(<NamePage />);
    await setValue(host.querySelector<HTMLInputElement>('#name')!, '小满');
    await click(button('へんしん'));
    await click(button('保存为图片'));
    expect(dialog()).toBeNull();
    expect(boundary.capture).toHaveBeenCalledOnce();
    expect(boundary.download).toHaveBeenCalledWith(expect.any(Blob), '铃兰.png');
    expect(boundary.create).not.toHaveBeenCalled();
    expect(boundary.revoke).not.toHaveBeenCalled();
  });

  it('Manager keeps restored draft export and backdrop dismissal', async () => {
    writeCharacterManagerPageDraft({ pastedJson: '', characterData: source, originalData: source, isNative: false, selectedTemplate: 'general' });
    await mount(<CharacterManagerPage />);
    await expectPreviewLifecycle(exportImage(), '角色卡片', true);
    expect(boundary.revoke).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('#editor-field-name')?.value).toBe(source.name);
  });

});
