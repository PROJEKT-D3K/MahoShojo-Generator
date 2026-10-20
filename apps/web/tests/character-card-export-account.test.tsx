// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MagicalGirlCard from '@/components/MagicalGirlCard';
import CanshouCard from '@/components/CanshouCard';
import GeneralCharacterCard from '@/components/GeneralCharacterCard';
import { GeneratedByUserBadge } from '@/components/shared/GeneratedByUserBadge';
import { CreatorStructuredResultCard } from '@mahoshojo/ui-web/creator';
import { CHARACTER_CARD_EXPORTER_LABEL } from '@mahoshojo/ui-web/character-card';
import { buildUnsignedMagicalGirlDetailsCard } from '@mahoshojo/ai-core/magical-girl-details-generation';
import { captureCharacterCardExportGuard } from '@/lib/character-card-export';
import { ensureAuthState, loginAndSyncAuthState, logoutAndSyncAuthState, resetAuthStoreForTests } from '@/lib/auth-client-store';
import type { UserBadge } from '@/types/badge';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), account: null as null | { id: number; username: string }, badges: [] as unknown[] }));
vi.mock('@/lib/auth', () => ({
  authApi: {
    verify: vi.fn(async () => mocks.account ? { success: true, user: mocks.account, badges: mocks.badges } : { success: false }),
    login: vi.fn(async () => ({ success: true, user: mocks.account })),
    logout: vi.fn(async () => undefined), register: vi.fn(),
  },
  authStorage: { getAuth: vi.fn(async () => null), clearAuth: vi.fn() },
}));
vi.mock('@/lib/userBadges', () => ({ getUserBadges: async () => mocks.badges }));
vi.mock('@/components/MarkdownBlock', () => ({ MarkdownBlock: ({ content }: { content: string }) => <span>{content}</span> }));
// 保留共享 useCardImageSave 与三种真实卡片，仅替换截图函数，不能视作 PNG 视觉验证。
vi.mock('../../../packages/ui-web/src/client/snapdomCapture', async original => ({ ...await original<object>(), capturePngBlob: mocks.capture }));
const general = { name: '原角色', content: '原作者：作者甲\n\n原文', author: '作者甲', signature: 'synthetic-signature' };
const magical = buildUnsignedMagicalGirlDetailsCard({
  codename: '原角色', appearance: { outfit: '礼服', accessories: '', colorScheme: '蓝色', overallLook: '' },
  magicConstruct: { name: '', form: '', basicAbilities: [], description: '' },
  wonderlandRule: { name: '', description: '', tendency: '', activation: '' },
  blooming: { name: '', evolvedAbilities: [], evolvedForm: '', evolvedOutfit: '', powerLevel: '' },
  analysis: { personalityAnalysis: '', abilityReasoning: '', coreTraits: [], predictionBasis: '', background: { belief: '', bonds: '' } },
}, []);
const canshou = { name: '原角色', coreConcept: '镜', coreEmotion: '平静', evolutionStage: '蛹', appearance: '', materialAndSkin: '', featuresAndAppendages: '', attackMethod: '', specialAbility: '', origin: '', birthEnvironment: '', researcherNotes: '' };
const accountA = { id: 701, username: '测试导出甲' }, accountB = { id: 702, username: '测试导出乙' };
let root: Root, container: HTMLDivElement, captured: string[];
const render = async (node: ReactNode) => { await act(async () => root.render(<StrictMode>{node}</StrictMode>)); };
const exportImage = async () => { await act(async () => container.querySelector<HTMLButtonElement>('button.save-button')!.click()); };
const signIn = async (account: typeof accountA) => {
  mocks.account = account;
  await act(async () => { await loginAndSyncAuthState('synthetic@example.test', 'synthetic-fixture', ''); });
};
const fixtures = [
  ['魔法少女', () => <MagicalGirlCard magicalGirl={magical} gradientStyle="linear-gradient(to right, #123456, #456789)" />],
  ['残兽', () => <CanshouCard canshou={canshou} />],
  ['通用角色', () => <GeneralCharacterCard general={general} />],
  ['Creator 魔法少女', () => <CreatorStructuredResultCard template="magical-girl" result={magical} captureExportGuard={captureCharacterCardExportGuard} generatedByBadge={<GeneratedByUserBadge label={CHARACTER_CARD_EXPORTER_LABEL} className="mt-3" />} />],
  ['Creator 残兽', () => <CreatorStructuredResultCard template="canshou" result={canshou} captureExportGuard={captureCharacterCardExportGuard} generatedByBadge={<GeneratedByUserBadge label={CHARACTER_CARD_EXPORTER_LABEL} className="mt-3" />} />],
] as const;
beforeEach(() => {
  localStorage.clear(); mocks.account = accountA; mocks.badges = []; captured = [];
  resetAuthStoreForTests(); vi.clearAllMocks();
  mocks.capture.mockImplementation(async (element: HTMLElement) => {
    expect(element.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('flex');
    captured.push(element.querySelector('.logo-placeholder')?.textContent ?? '');
    return new Blob(['mock capture'], { type: 'image/png' });
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:synthetic'), revokeObjectURL: vi.fn() }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Web 角色卡导出账号（真实账户 store 与共享截图入口）', () => {
  it.each(fixtures)('%s 使用当前导出账号，切换身份不改卡片原作者/签名', async (_name, fixture) => {
    const source = JSON.stringify({ general, magical, canshou });
    await render(fixture()); await exportImage(); expect(captured.at(-1)).toBe('导出者：测试导出甲');
    await signIn(accountB); await exportImage(); expect(captured.at(-1)).toBe('导出者：测试导出乙');
    mocks.account = null; await act(async () => { await logoutAndSyncAuthState(); });
    await exportImage(); expect(captured.at(-1)).toBe('');
    expect(JSON.stringify({ general, magical, canshou })).toBe(source);
    expect(container.querySelector<HTMLElement>('.logo-placeholder')?.style.display).toBe('none');
  });

  it('保留已装备徽章的显示和顺序，不展示未装备徽章；换号清理旧徽章', async () => {
    const makeBadge = (id: string, isEquipped: boolean, displayOrder: number): UserBadge => ({
      id: displayOrder + 1, userId: 701, badgeId: id, isEquipped, displayOrder, obtainedAt: '2026-01-01',
      badge: { id, name: id, description: id, icon: { type: 'emoji', value: '🌟' }, textColor: { type: 'solid', value: '#ffffff' }, backgroundColor: { type: 'solid', value: '#123456' }, rarity: 1, sortOrder: displayOrder, isActive: true },
    });
    mocks.badges = [makeBadge('后徽章', true, 2), makeBadge('未装备', false, 0), makeBadge('前徽章', true, 1)];
    await render(<GeneralCharacterCard general={general} />); await exportImage();
    expect(captured[0]).toContain('前徽章'); expect(captured[0]).toContain('后徽章');
    expect(captured[0]).not.toContain('未装备'); expect(captured[0].indexOf('前徽章')).toBeLessThan(captured[0].indexOf('后徽章'));
    mocks.badges = []; await signIn(accountB); await exportImage();
    expect(captured.at(-1)).toBe('导出者：测试导出乙');
  });

  it.each(['switch', 'signout', 'late-error'] as const)('在途 %s 不交付旧账号截图/错误，下次当前身份正常导出', async action => {
    await render(<GeneralCharacterCard general={general} />);
    let finish!: (blob: Blob) => void, fail!: (error: Error) => void;
    mocks.capture.mockImplementationOnce(() => new Promise<Blob>((resolve, reject) => { finish = resolve; fail = reject; }));
    await exportImage(); expect(container.querySelector<HTMLButtonElement>('button.save-button')?.disabled).toBe(true);
    if (action === 'signout') { mocks.account = null; await act(async () => { await logoutAndSyncAuthState(); }); }
    else await signIn(accountB);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await act(async () => { if (action === 'late-error') fail(new Error('旧截图失败')); else finish(new Blob(['old'])); });
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button.save-button')?.disabled).toBe(false);
    await exportImage(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('存储不可用的稳定匿名状态仍可截图，存储恢复后的旧在途截图失效', async () => {
    mocks.account = null;
    const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    await render(<GeneralCharacterCard general={general} />); await act(async () => ensureAuthState());
    await exportImage(); expect(captured.at(-1)).toBe(''); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    let finish!: (blob: Blob) => void;
    mocks.capture.mockImplementationOnce(() => new Promise<Blob>(resolve => { finish = resolve; }));
    await exportImage(); storage.mockRestore();
    await act(async () => finish(new Blob(['old anonymous'])));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await act(async () => ensureAuthState()); await exportImage(); expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('其他消费者的默认“生成者”语义与显式匿名隐藏均不改变', async () => {
    await render(<GeneratedByUserBadge />); expect(container.textContent).toContain('生成者：');
    expect(container.textContent).not.toContain('导出者：');
    mocks.account = null; await act(async () => { await logoutAndSyncAuthState(); }); expect(container.textContent).toBe('');
  });

  it('下一帧前换号不启动旧截图；当前账号下次导出仍正常', async () => {
    await render(<GeneralCharacterCard general={general} />);
    let paint!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1; });
    await exportImage(); expect(mocks.capture).not.toHaveBeenCalled();
    await signIn(accountB); await act(async () => paint(0));
    expect(mocks.capture).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button.save-button')?.disabled).toBe(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    await exportImage(); expect(captured.at(-1)).toBe('导出者：测试导出乙');
  });

});
