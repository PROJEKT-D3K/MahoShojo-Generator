// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTavernCloudSavePayload } from '@mahoshojo/domain/tavern-card/cloud';
import { TavernImportPanel } from '@/components/tavern/TavernImportPanel';

type CloudProps = { data: unknown; getData: () => Promise<unknown>; cardType: string; defaultName: string };
const mocks = vi.hoisted(() => ({ cloud: null as CloudProps | null, download: vi.fn<(blob: Blob, name: string) => void>() }));
vi.mock('@/components/AiProviderSelector', () => ({ default: () => null }));
vi.mock('@/components/TachieGenerator', () => ({ default: () => null }));
vi.mock('@/components/SaveToCloudButton', () => ({ default: (props: CloudProps) => { mocks.cloud = props; return <button type="button">宿主云保存</button>; } }));
vi.mock('@/components/GeneralCharacterCard', () => ({ default: () => null }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: 42, username: '作者🌸' } }) }));
vi.mock('@/lib/cooldown', () => ({ useCooldown: () => ({ isCooldown: false, remainingTime: 0, startCooldown: vi.fn() }) }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/client/blobUrl', () => ({ downloadBlob: mocks.download, revokeBlobUrl: vi.fn() }));
vi.mock('@/lib/local-library/card-repository', () => ({ getLocalCardRepository: () => ({}) }));

let root: Root; let container: HTMLDivElement;
const button = (text: string) => [...container.querySelectorAll('button')].find(element => element.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function upload(raw: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'cloud.json', size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.cloud = null;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Web Tavern uses the shared cloud controls and payload', () => {
  it('passes each explicitly selected cloud copy to the original save owner while download keeps raw and full body', async () => {
    await act(async () => root.render(<TavernImportPanel />));
    const raw = { name: '云副本测试', description: '文'.repeat(25_000), mes_example: '样例'.repeat(8_000), extensions: { retained: true } };
    await upload(raw);
    const keepRaw = [...container.querySelectorAll('label')].find(element => element.textContent?.includes('同时保存'))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => keepRaw.click());
    await click('生成角色卡');
    const source = mocks.cloud!.data;
    const original = JSON.stringify(source);
    expect(source).toHaveProperty('_tavern.raw', raw);
    expect(mocks.cloud!.cardType).toBe('character');
    expect(container.querySelector('[aria-label="云端保存预设"]')).not.toBeNull();
    expect(button('标准').getAttribute('aria-pressed')).toBe('true');
    for (const [label, preset] of [['标准', 'standard'], ['轻量', 'light'], ['极简', 'minimal']] as const) {
      await click(label);
      const expected = buildTavernCloudSavePayload(source, { id: 42, username: '作者🌸' }, preset);
      if ('error' in expected) throw new Error(expected.error);
      expect(await mocks.cloud!.getData()).toEqual(expected.data);
      expect(await mocks.cloud!.getData()).not.toHaveProperty('_tavern.raw');
      expect(button(label).getAttribute('aria-pressed')).toBe('true');
      expect(JSON.stringify(mocks.cloud!.data)).toBe(original);
    }
    await click('下载数据卡 JSON');
    expect(JSON.parse(await mocks.download.mock.calls[0][0].text())).toEqual(source);
    expect(container.textContent).not.toContain('300KB 上限');
    expect(container.textContent).toContain('1024KB');
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/languages.json')).toBe(true);
  });
});
