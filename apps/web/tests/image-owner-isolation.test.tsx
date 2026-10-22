// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CharacterPortraitAssetPanel } from '@/components/shared/CharacterPortraitAssetPanel';
import { BattleIllustrationPanel } from '@/components/arena/components/BattleIllustrationPanel';
import { MagicTeaPartyTachiePanel } from '@/components/magic-tea-party/TachiePanel';
import { DEFAULT_MAGIC_TEA_PARTY_PREFERENCES } from '@/lib/magic-tea-party/preferences';
import type TachieGenerator from '@/components/TachieGenerator';

const boundary = vi.hoisted(() => ({
  generators: [] as ComponentProps<typeof TachieGenerator>[],
  readImage: vi.fn(), listAssets: vi.fn(), putAsset: vi.fn(), putBlob: vi.fn(),
}));
vi.mock('@/components/TachieGenerator', () => ({ default: (props: ComponentProps<typeof TachieGenerator>) => {
  boundary.generators.push(props);
  return <div data-testid="image-generator" />;
} }));
vi.mock('@/lib/client/visualAsset', () => ({
  readImageFileAsDataUrl: boundary.readImage,
  resolveProxyImageUrl: (value: string) => value,
}));
vi.mock('@/lib/crypto', () => ({ randomUUID: () => 'generated-asset' }));
vi.mock('@/lib/magic-tea-party/storage', () => ({
  listMagicTeaPartyTachieAssets: boundary.listAssets,
  listAllMagicTeaPartyTachieAssets: async () => [],
  putMagicTeaPartyTachieAsset: boundary.putAsset,
  putMagicTeaPartyTachieBlob: boundary.putBlob,
  deleteMagicTeaPartyTachieAsset: async () => {},
  deleteMagicTeaPartyTachieAssetsByIds: async () => {},
  deleteMagicTeaPartyTachieAssets: async () => {},
}));

let container: HTMLDivElement;
let root: Root;
const generator = () => boundary.generators.at(-1)!;
const image = 'data:image/png;base64,cG9ydHJhaXQ=';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const clickButton = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;
  await act(async () => button.click());
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  boundary.generators.length = 0; boundary.readImage.mockReset(); boundary.putAsset.mockReset();
  boundary.putBlob.mockReset(); boundary.listAssets.mockReset().mockResolvedValue([]);
  localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

it('角色同 owner 修改提示词保留图片，同提示词换 owner 清除图片并拒绝旧生成回调', async () => {
  const changed = vi.fn(); const first = {}; const second = {};
  await act(async () => root.render(<CharacterPortraitAssetPanel ownerKey={first} prompt="相同描述" onPortraitAssetChange={changed} />));
  const old = generator(); expect(old.ownerKey).toBe(first);
  await act(async () => old.onImageUrlChange?.(image));
  expect(changed).toHaveBeenLastCalledWith({ imageUrl: image, source: 'generated' });
  await act(async () => root.render(<CharacterPortraitAssetPanel ownerKey={first} prompt="下一次生成提示词" onPortraitAssetChange={changed} />));
  expect(container.querySelector('img')?.src).toBe(image);
  await act(async () => root.render(<CharacterPortraitAssetPanel ownerKey={second} prompt="下一次生成提示词" onPortraitAssetChange={changed} />));
  expect(generator().ownerKey).toBe(second); expect(changed).toHaveBeenLastCalledWith(null);
  await act(async () => old.onImageUrlChange?.(image));
  expect(container.querySelector('img')).toBeNull(); expect(changed).toHaveBeenLastCalledWith(null);
});

it('角色上传读取晚于 owner 切换时不能把旧图片放入新角色', async () => {
  let finish!: (value: string) => void;
  boundary.readImage.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  const changed = vi.fn();
  await act(async () => root.render(<CharacterPortraitAssetPanel ownerKey="a" prompt="同提示词" onPortraitAssetChange={changed} />));
  const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'old.png', { type: 'image/png' })] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => root.render(<CharacterPortraitAssetPanel ownerKey="b" prompt="同提示词" onPortraitAssetChange={changed} />));
  await act(async () => finish(image));
  expect(container.querySelector('img')).toBeNull(); expect(changed).toHaveBeenLastCalledWith(null);
});

it('战报插图使用报告 owner，不随推荐提示词变化换目标；换报告后清图', async () => {
  const changed = vi.fn();
  const render = (ownerKey: string, reportBody: string) => <BattleIllustrationPanel ownerKey={ownerKey} headline="相同标题"
    reportBody={reportBody} combatants={[]} aiImpacts={null} onIllustrationAssetChange={changed} />;
  await act(async () => root.render(render('report-a', '正文')));
  if (!container.querySelector('[data-testid=image-generator]')) await clickButton('战报插图');
  const old = generator(); expect(old.ownerKey).toBe('report-a');
  await act(async () => old.onImageUrlChange?.(image));
  await act(async () => root.render(render('report-a', '同报告的正文更新')));
  expect(changed).toHaveBeenLastCalledWith({ imageUrl: image, source: 'generated' });
  await act(async () => root.render(render('report-b', '同报告的正文更新')));
  expect(changed).toHaveBeenLastCalledWith(null);
  await act(async () => old.onImageUrlChange?.(image));
  expect(changed).toHaveBeenLastCalledWith(null);
});

it('茶会相同提示词切会话或锚点也更换 owner，迟到生成回调不会保存到新会话', async () => {
  const changed = vi.fn(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const render = (id: string, anchorMessageId: string) => <MagicTeaPartyTachiePanel
    session={{ id, roles: [] }} preferences={DEFAULT_MAGIC_TEA_PARTY_PREFERENCES} messages={[]}
    referenceText="相同剧情" anchorMessageId={anchorMessageId} onAssetsUpdated={changed} />;
  await act(async () => root.render(render('session-a', 'message-a')));
  await clickButton('展开'); const first = generator();
  await act(async () => root.render(render('session-b', 'message-a')));
  await clickButton('展开'); const second = generator();
  expect(first.prompt).toBe(second.prompt); expect(first.ownerKey).not.toBe(second.ownerKey);
  await act(async () => first.onResult?.({ success: true, imageUrl: image }));
  expect(boundary.putAsset).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await act(async () => root.render(render('session-b', 'message-b')));
  expect(second.ownerKey).not.toBe(generator().ownerKey);
  expect(second.prompt).toBe(generator().prompt);
  await act(async () => second.onResult?.({ success: true, imageUrl: image }));
  expect(boundary.putAsset).not.toHaveBeenCalled();
});

it('茶会已开始的旧目标保存只写原 owner，落盘迟到不把旧资产列表发布给新会话', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: async () => new ArrayBuffer(32) } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  let finishSave!: () => void;
  boundary.putAsset.mockImplementation(() => new Promise<void>(resolve => { finishSave = resolve; }));
  const changed = vi.fn();
  const render = (id: string) => <MagicTeaPartyTachiePanel session={{ id, roles: [] }}
    preferences={DEFAULT_MAGIC_TEA_PARTY_PREFERENCES} messages={[]} referenceText="相同剧情" onAssetsUpdated={changed} />;
  await act(async () => root.render(render('session-a'))); await clickButton('展开');
  await act(async () => { generator().onResult?.({ success: true, imageUrl: image }); await flush(); });
  expect(boundary.putAsset).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', imageUrl: image }));
  await act(async () => root.render(render('session-b'))); changed.mockClear();
  await act(async () => { finishSave(); await flush(); });
  expect(changed).not.toHaveBeenCalled();
  expect(boundary.putAsset).toHaveBeenCalledTimes(1);
});
