// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildUnsignedMagicalGirlDetailsCard } from '@mahoshojo/ai-core/magical-girl-details-generation';
import { createDesktopRouter } from '../src/app/router';
import { DETAILS_DRAFT_KEY } from '../src/features/details/session';
import { CANSHOU_DRAFT_KEY } from '../src/features/canshou/session';
import { CREATOR_DRAFT_KEY } from '../src/features/creator/session';
import { readDesktopCharacterManagerDraft, writeDesktopCharacterManagerDraft } from '../src/features/character-manager/draft-persistence';
import { DESKTOP_AI_CONFIG_STORAGE_KEY } from '../src/features/ai-config/desktop-ai-config-store';
import { resetDesktopAiConfigStoreForTests } from '../src/features/ai-config/use-desktop-ai-config';
import { captureDesktopCharacterCardExportGuard, DesktopCharacterCardExportBadge } from '../src/features/account/character-card-export-badge';
import { getDesktopCloudSessionStore, resetDesktopCloudSessionStoreForTests } from '../src/features/account/use-desktop-cloud-session';
import { resetDesktopAnnouncementsStoreForTests } from '../src/features/announcements/use-desktop-announcements';
import { resetDesktopConfigStoreForTests } from '../src/features/config/use-desktop-config';
import { resetTopbarAvatarForTests } from '../src/features/account/use-topbar-avatar';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), generate: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) }));
vi.mock('../../../packages/ui-web/src/client/snapdomCapture', async original => ({ ...await original<object>(), capturePngBlob: mocks.capture }));
vi.mock('../src/platform/provider-profile-bridge', () => ({
  listProviderProfileIds: async () => ['local'],
  getProviderProfile: async () => ({ id: 'local', name: '测试连接', adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model' }),
}));
vi.mock('../src/features/details/generation', async original => ({ ...await original<object>(), executeDetailsGeneration: mocks.generate }));
vi.mock('../src/platform/local-card-bridge', async original => ({ ...await original<object>(), IpcLocalCardRepository: class { putIfAbsent = mocks.save; list = async () => ({ items: [] }); } }));

const general = { templateId: '通用角色', name: '原角色', content: '原作者：原作者甲\n\n角色原文', signature: 'synthetic-original-signature', author: '原作者甲' };
const magical = { ...buildUnsignedMagicalGirlDetailsCard({
  codename: '原角色', appearance: { outfit: '礼服', accessories: '', colorScheme: '蓝色', overallLook: '' },
  magicConstruct: { name: '光杖', form: '', basicAbilities: [], description: '' },
  wonderlandRule: { name: '领域', description: '', tendency: '', activation: '' },
  blooming: { name: '绽放', evolvedAbilities: [], evolvedForm: '', evolvedOutfit: '', powerLevel: '' },
  analysis: { personalityAnalysis: '', abilityReasoning: '', coreTraits: [], predictionBasis: '', background: { belief: '', bonds: '' } },
}, []), signature: 'synthetic-original-signature' };
const canshou = { userAnswers: [], templateId: '残兽', name: '原角色', coreConcept: '镜', coreEmotion: '沉静', evolutionStage: '蛹', appearance: '镜面', materialAndSkin: '玻璃', featuresAndAppendages: '', attackMethod: '', specialAbility: '', origin: '', birthEnvironment: '', researcherNotes: '', signature: 'synthetic-original-signature' };
const accountA = { userId: 701, username: '测试导出甲' };
const accountB = { userId: 702, username: '测试导出乙' };
const expires = '2099-01-01T00:00:00.000Z';
let currentAccount: typeof accountA | null;
let verification: 'active' | 'unreachable' | 'expired';
let root: Root, container: HTMLDivElement;
let captures: Array<{ badge: string; text: string; visible: string; buttonVisible: string }>;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`等待真实路由超时：${container.textContent?.slice(-1500)}`); await settle(); }
};
const refresh = async () => { await act(async () => { await getDesktopCloudSessionStore().refresh(); }); };
const mount = async (path: string, expectCard = true) => {
  window.location.hash = `#${path}`;
  const router = createDesktopRouter(); await router.load();
  await act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
  if (expectCard) await waitFor(() => container.querySelector('.result-card') !== null);
  await settle();
};
const exportImage = async () => {
  const button = container.querySelector<HTMLButtonElement>('.result-card .save-button button, .result-card button.save-button')!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
  await waitFor(() => !button.disabled);
  await settle();
  expect(captures.at(-1)?.visible).toBe('flex');
  expect(captures.at(-1)?.buttonVisible).toBe('none');
  expect(container.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('none');
};
const restoredDraft = (key: string, kind: string, card: Record<string, unknown>) => localStorage.setItem(key, JSON.stringify({
  version: 1, answers: {}, language: 'zh-CN', imageSaveMode: 'download',
  template: kind, generationMode: 'non-stream', freeformBrief: '', selectedRuleIds: [],
  questionnaireSelections: [{ source: 'preset', selectionId: 'preset:export', questionnaire: {
    id: 'export', kind: kind === 'canshou' ? 'canshou' : 'magical-girl', title: '导出测试问卷', nativeAllowed: true,
    questions: [{ id: 'first', question: '角色描述？', type: 'text' }],
  } }],
  output: { mode: 'hosted-json', phase: 'completed', cardKind: kind, card, rawText: JSON.stringify(card) },
}));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); currentAccount = accountA; verification = 'active'; captures = [];
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'cloud_cached_account') return currentAccount ? { account: currentAccount, sessionExpiresAt: expires } as never : null;
    if (command === 'cloud_auth_status') return (verification !== 'active' ? { state: verification } : currentAccount ? { state: 'active', account: currentAccount, sessionExpiresAt: expires } : { state: 'signed-out' }) as never;
    if (command === 'announcements_get_cached') return null;
    if (command === 'desktop_config_read') return { path: '/config.json', directory: '/', backupPresent: false, invalidPresent: false, file: { status: 'missing' } } as never;
    if (command === 'announcements_refresh') return { status: 'not-modified', snapshot: { fetchedAt: '2026-10-10T00:00:00Z', announcements: [] } } as never;
    return undefined;
  });
  mocks.capture.mockImplementation(async (element: HTMLElement) => {
    captures.push({ badge: element.querySelector('.logo-placeholder')?.textContent ?? '', text: element.textContent ?? '',
      visible: element.querySelector<HTMLElement>('.logo-placeholder')?.style.display ?? '', buttonVisible: element.querySelector<HTMLElement>('.save-button')?.style.display ?? '' });
    return new Blob(['synthetic capture boundary'], { type: 'image/png' });
  });
  localStorage.clear(); localStorage.setItem(DESKTOP_AI_CONFIG_STORAGE_KEY, JSON.stringify({ version: 2, selection: { executionPreference: 'client', clientConnectionId: 'local' }, hiddenPresetIds: [] }));
  resetDesktopAiConfigStoreForTests(); resetDesktopCloudSessionStoreForTests(); resetDesktopAnnouncementsStoreForTests(); resetDesktopConfigStoreForTests(); resetTopbarAvatarForTests();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ presets: [] })));
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:synthetic-export'), revokeObjectURL: vi.fn() }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('角色卡真实路由与导出入口（截图函数为 mock，不作 PNG 视觉证明）', () => {
  it('独立导出账号展示只读既有投影，不发 IPC 或账号请求', async () => {
    await act(async () => root.render(<DesktopCharacterCardExportBadge />));
    expect(container.textContent).toBe('');
    expect(captureDesktopCharacterCardExportGuard()()).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    ['/details', DETAILS_DRAFT_KEY, 'magical-girl', magical],
    ['/details', DETAILS_DRAFT_KEY, 'general', general],
    ['/canshou', CANSHOU_DRAFT_KEY, 'canshou', canshou],
    ['/creator', CREATOR_DRAFT_KEY, 'magical-girl', magical],
    ['/creator', CREATOR_DRAFT_KEY, 'canshou', canshou],
  ] as const)('%s 恢复 %s 后只标当前导出账号，不改原文/签名', async (path, key, kind, card) => {
    restoredDraft(key, kind, card); const before = JSON.parse(localStorage.getItem(key)!).output;
    currentAccount = accountB; await mount(path); await exportImage();
    expect(captures[0].badge).toBe('导出者：测试导出乙');
    expect(captures[0].text).not.toContain('生成者：');
    expect(JSON.parse(localStorage.getItem(key)!).output.card).toEqual(before.card);
    expect(JSON.parse(localStorage.getItem(key)!).output.rawText).toEqual(before.rawText);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([['magical-girl', magical], ['canshou', canshou], ['general', general]] as const)('导入 %s 预览导出只标操作者，保留原作者和签名', async (_kind, card) => {
    const source = structuredClone(card);
    writeDesktopCharacterManagerDraft({ pastedJson: '', draft: { cardType: 'character', title: '原角色', data: source, originalId: null, originalData: source } });
    currentAccount = accountB; await mount('/character-manager'); await exportImage();
    expect(captures[0].badge).toBe('导出者：测试导出乙');
    expect(source).toEqual(card); expect(mocks.save).not.toHaveBeenCalled();
    expect(readDesktopCharacterManagerDraft()?.payload.draft?.data).toEqual(card);
    expect(readDesktopCharacterManagerDraft()?.payload.draft?.originalData).toEqual(card);
    if (_kind === 'general') expect(captures[0].text).toContain('原作者：原作者甲');
  });

  it('同一卡片 A → B → 匿名/离线/过期均读取当前会话，不把生成账号当作作者', async () => {
    restoredDraft(DETAILS_DRAFT_KEY, 'general', general); await mount('/details'); await exportImage();
    expect(captures.at(-1)?.badge).toBe('导出者：测试导出甲');
    currentAccount = accountB; await refresh(); await exportImage();
    expect(captures.at(-1)?.badge).toBe('导出者：测试导出乙');
    verification = 'unreachable'; await refresh(); await exportImage(); expect(captures.at(-1)?.badge).toBe('');
    verification = 'expired'; await refresh(); await exportImage(); expect(captures.at(-1)?.badge).toBe('');
    verification = 'active'; currentAccount = null; await refresh(); await exportImage(); expect(captures.at(-1)?.badge).toBe('');
    expect(JSON.parse(localStorage.getItem(DETAILS_DRAFT_KEY)!).output.card).toEqual(general);
  });

  it('缓存身份等待验证时不署名，验证完成后才出现在下一次截图', async () => {
    let finish!: (value: unknown) => void;
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((command, args) => command === 'cloud_auth_status' ? new Promise(resolve => { finish = resolve; }) : original(command, args));
    restoredDraft(DETAILS_DRAFT_KEY, 'general', general); await mount('/details'); await exportImage();
    expect(captures.at(-1)?.badge).toBe('');
    await act(async () => finish({ state: 'active', account: accountB, sessionExpiresAt: expires })); await exportImage();
    expect(captures.at(-1)?.badge).toBe('导出者：测试导出乙');
  });

  it('A 本页新生成后切 B 导出，不冻结生成者身份也不重写生成结果', async () => {
    restoredDraft(DETAILS_DRAFT_KEY, 'general', general);
    const draft = JSON.parse(localStorage.getItem(DETAILS_DRAFT_KEY)!);
    delete draft.output; draft.answers = { 'preset:export::first': '测试角色' };
    localStorage.setItem(DETAILS_DRAFT_KEY, JSON.stringify(draft));
    mocks.generate.mockResolvedValue({ status: 'completed', mode: 'direct-local', cardKind: 'general', card: general, rawText: JSON.stringify(general),
      result: { status: 'completed', contractVersion: 1, requestId: 'synthetic', mode: 'direct-local', output: { text: JSON.stringify(general) }, finishReason: 'stop' } });
    await mount('/details', false);
    await waitFor(() => container.querySelector('[aria-label="问卷翻页操作"] button:last-child') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="问卷翻页操作"] button:last-child')!.click());
    await waitFor(() => container.querySelector('.result-card') !== null);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const output = JSON.parse(localStorage.getItem(DETAILS_DRAFT_KEY)!).output;
    currentAccount = accountB; await refresh(); await exportImage();
    expect(captures.at(-1)?.badge).toBe('导出者：测试导出乙');
    expect(JSON.parse(localStorage.getItem(DETAILS_DRAFT_KEY)!).output).toEqual(output);
  });

  it.each(['switch', 'signout', 'late-error', 'modal-switch'] as const)('截图在途 %s 退休旧结果，恢复按钮后允许新的导出', async action => {
    restoredDraft(DETAILS_DRAFT_KEY, 'general', general);
    if (action === 'modal-switch') { const draft = JSON.parse(localStorage.getItem(DETAILS_DRAFT_KEY)!); draft.imageSaveMode = 'modal'; localStorage.setItem(DETAILS_DRAFT_KEY, JSON.stringify(draft)); }
    await mount('/details');
    let finish!: (value: Blob) => void, fail!: (reason: Error) => void;
    mocks.capture.mockImplementationOnce(() => new Promise<Blob>((resolve, reject) => { finish = resolve; fail = reject; }));
    const button = container.querySelector<HTMLButtonElement>('.result-card button.save-button')!;
    await act(async () => button.click());
    expect(mocks.capture).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
    currentAccount = action === 'signout' ? null : accountB; await refresh();
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await act(async () => { if (action === 'late-error') fail(new Error('旧账号截图失败')); else finish(new Blob(['old'], { type: 'image/png' })); });
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(container.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('none');
    await exportImage();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(captures.at(-1)?.badge).toBe(action === 'signout' ? '' : '导出者：测试导出乙');
  });


  it('授权在途没有确认账号时不署名；完成授权后下一次导出显示已验证账号', async () => {
    currentAccount = null;
    const original = vi.mocked(invoke).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === 'cloud_login_begin') return Promise.resolve({ flowId: 'synthetic', authorizeUrl: 'https://example.test/auth/desktop' }) as never;
      if (command === 'cloud_login_await') return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    restoredDraft(DETAILS_DRAFT_KEY, 'general', general); await mount('/details');
    let login!: Promise<unknown>;
    await act(async () => { login = getDesktopCloudSessionStore().requestAuth(); });
    expect(getDesktopCloudSessionStore().getSnapshot().authFlow.kind).toBe('authenticating');
    await exportImage(); expect(captures.at(-1)?.badge).toBe('');
    currentAccount = accountB;
    await act(async () => { finish({ status: 'signed-in', account: accountB, sessionExpiresAt: expires }); await login; });
    await exportImage(); expect(captures.at(-1)?.badge).toBe('导出者：测试导出乙');
  });

});
