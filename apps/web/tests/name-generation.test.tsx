// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNameGenerationResult, nameResultGradient, serializeNameGenerationResult } from '@mahoshojo/domain/name-generation';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), download: vi.fn(), cooldown: vi.fn(), safety: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({ tryAcquire: () => ({ dispatch: mocks.dispatch }) }) }));
vi.mock('@/lib/auth', () => ({ authStorage: { getActivityHeaders: async () => ({}) } }));
vi.mock('@/lib/cooldown', () => ({ useCooldown: () => ({ isCooldown: false, startCooldown: mocks.cooldown, remainingTime: 0 }) }));
vi.mock('@/lib/content-safety/client', () => ({ getSensitiveWordRedirectTarget: mocks.safety }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download }));
vi.mock('@/components/TachieGenerator', () => ({ default: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/shared/GeneratedByUserBadge', () => ({ GeneratedByUserBadge: () => null }));
vi.mock('@/components/shared/CreatorEntryLink', () => ({ CreatorEntryLink: () => null }));
vi.mock('@/components/encyclopedia/EncyclopediaLinks', () => ({ EncyclopediaLinks: () => null }));
import { NamePage } from '@/components/creation/NamePage';
const generated = { flowerName: '铃兰', flowerDescription: '幸福归来', appearance: { height: '155cm', weight: '45kg', hairColor: '银白色', hairStyle: '长发', eyeColor: '绿色', skinTone: '白皙', wearing: '礼服', specialFeature: '微笑', mainColor: '绿色', firstPageColor: '#123456', secondPageColor: '#654321' }, spell: '花よ\n花啊', signature: 'server', templateId: 'server-template' };
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); mocks.safety.mockResolvedValue(null); mocks.dispatch.mockImplementation(async () => Response.json(generated));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ code: 'zh-CN', name: '简体中文' }, { code: 'ja', name: '日本語' }])));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () => element.dispatchEvent(new Event('change', { bubbles: true })));
}
const button = (text: string) => [...host.querySelectorAll('button')].find(el => el.textContent?.includes(text))!;
async function mount(name: string) { await act(async () => root.render(<NamePage />)); await change(host.querySelector<HTMLInputElement>('#name')!, name); }
const readBlob = (blob: Blob): Promise<string> => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });

describe('Web name page actually consumes the shared form/result projection', () => {
  it.each(['小满', '鹿目圆香', 'Alice', '🌸', 'مريم'])('preserves fields, deterministic level, color and JSON for %s', async name => {
    await mount(` ${name} `);
    await change(host.querySelector<HTMLSelectElement>('#language-select')!, 'ja');
    await act(async () => button('へんしん').click());
    expect(mocks.dispatch).toHaveBeenCalledWith('/api/generate-magical-girl', expect.objectContaining({ body: JSON.stringify({ name, language: 'ja' }) }));
    const expected = buildNameGenerationResult(name, generated);
    expect(host.querySelector('.level-badge')?.textContent).toBe(`${expected.levelEmoji} ${expected.level}`);
    const element = host.querySelector<HTMLElement>('.result-card')!;
    const probe = document.createElement('div'); probe.style.background = nameResultGradient(expected);
    expect(element.style.background).toBe(probe.style.background);
    await act(async () => button('下载设定文件').click());
    expect(mocks.download.mock.calls[0]![1]).toBe('魔法少女_铃兰.json');
    expect(await readBlob(mocks.download.mock.calls[0]![0])).toBe(serializeNameGenerationResult(expected));
    expect(mocks.cooldown).toHaveBeenCalledWith(60_000);
  });
  it.each(['名'.repeat(301), ' '+ '名'.repeat(300), '🌸'.repeat(151)])('keeps the original raw UTF-16 length boundary', async name => {
    await mount(name); await act(async () => button('へんしん').click());
    expect(host.textContent).toContain('名字太长啦'); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('keeps language preference and the server rate-limit cooldown', async () => {
    localStorage.setItem('mahoshojo.name.preferences.v1', JSON.stringify({ selectedLanguage: 'ja' }));
    mocks.dispatch.mockResolvedValue(Response.json({ retryAfterSeconds: 123 }, { status: 429 }));
    await mount('小满'); expect(host.querySelector<HTMLSelectElement>('#language-select')!.value).toBe('ja');
    await act(async () => button('へんしん').click());
    expect(mocks.cooldown).toHaveBeenCalledWith(123_000); expect(host.textContent).toContain('123 秒');
  });
});
