// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_LIST } from '@mahoshojo/domain/presets';
import { PUBLIC_DATA_CARD_NOT_FOUND_CODE } from '@mahoshojo/contracts/desktop-cloud';
import type { CardLibraryDetailsModalProps, CardLibraryHost } from '@mahoshojo/ui-web/card-library';
const mocks = vi.hoisted(() => ({ download: vi.fn(), open: vi.fn() }));
vi.mock('../src/platform/download-text-file', () => ({ downloadTextFile: mocks.download }));
vi.mock('../src/features/external-links/external-links-provider', () => ({ useExternalLinks: () => ({ openContent: mocks.open }) }));
import { DesktopCardDetailsModal } from '../src/features/card-details/card-details-modal';
import { canOpenDesktopRankingDetails, DesktopRankingDetailsModal, loadDesktopRankingDetails } from '../src/features/card-details/ranking-details-modal';
const card = { id: '00000000-0000-4000-8000-000000000001', name: '桌面详情', description: '简介', type: 'character' as const, data: '{"name":"角色正文","content":"[外链](https://example.com/a) [相对链接](relative.md) ![外部图片](https://example.com/image.png)"}', isPublic: true, author: '作者', updatedAt: '2026-10-01T00:00:00Z', tagIds: ['tag-unknown'] };
const target = { entityType: 'data_card' as const, entityId: card.id, displayName: card.name, authorName: '作者', pendingNotice: '历史快照：旧赛季分数' };
const read = vi.fn();
const host = { online: { fetchPublicCardById: read }, local: { repository: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } } } as unknown as Pick<CardLibraryHost, 'online' | 'local'>;
let root: Root; let container: HTMLDivElement;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)!;
const render = (props: Partial<CardLibraryDetailsModalProps> = {}) => act(async () => root.render(<DesktopCardDetailsModal isOpen onClose={() => {}} card={card} source={{ kind: 'local', label: '本地库' }} {...props} />));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); read.mockResolvedValue({ ok: true, status: 200, data: { success: true, card: { ...card, username: '作者', updated_at: card.updatedAt } } }); vi.stubGlobal('fetch', vi.fn()); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe('Desktop 真实基础详情', () => {
  it('本地 UUID 无在线请求，媒体不加载，链接走既有确认端口，动作按能力显示', async () => {
    await render(); expect(fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(container.querySelector('img')).toBeNull(); expect(container.textContent).toContain('本机未验证'); expect(container.textContent).toContain('标签 ID（未取得名称）'); expect(button('存到本地库')).toBeUndefined();
    const region = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(region.tabIndex).toBe(0); region.focus(); expect(document.activeElement).toBe(region);
    await act(async () => container.querySelector<HTMLAnchorElement>('a')!.click()); expect(mocks.open).toHaveBeenCalledWith('https://example.com/a');
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="relative.md"]')!.click()); expect(mocks.open).toHaveBeenCalledWith('relative.md');
    await act(async () => button('下载 JSON').click()); expect(mocks.download).toHaveBeenCalledWith('桌面详情.json', JSON.stringify(JSON.parse(card.data), null, 2));
  });
  it.each([{ kind: 'local' }, { kind: 'cache', lastSuccessAt: null }, { kind: 'owned' }, { kind: 'public' }, { kind: 'preset' }] as const)('generic $kind details never infer history from the card ID or source', async (source) => {
    await render({ source }); expect(button('最近严格排位')).toBeUndefined(); expect(read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('下载/保存失败直接在详情内可见', async () => {
    mocks.download.mockImplementationOnce(() => { throw new Error('磁盘下载失败'); }); await render({ onSaveCopyToLocalLibrary: async () => { throw new Error('本地存储写入失败'); } });
    await act(async () => button('下载 JSON').click()); expect(container.textContent).toContain('磁盘下载失败');
    await act(async () => button('存到本地库').click()); expect(container.textContent).toContain('本地存储写入失败');
  });
  it.each(['source', 'body', 'close'] as const)('保存迟到错误不能进入同 ID 的新 %s 作用域', async (change) => {
    let reject!: (error: Error) => void;
    const saving = new Promise<void>((_resolve, no) => { reject = no; });
    await render({ onSaveCopyToLocalLibrary: () => saving });
    await act(async () => button('存到本地库').click());
    if (change === 'source') await render({ source: { kind: 'cache', lastSuccessAt: null } });
    if (change === 'body') await render({ card: { ...card, data: '{"name":"新的编辑正文"}' } });
    if (change === 'close') await render({ isOpen: false });
    await act(async () => reject(new Error('旧操作错误不可见')));
    expect(container.textContent).not.toContain('旧操作错误不可见');
  });
  it('榜单现 public 主记录直读并解释历史来源，不查 meta，保存复用 unsigned/downloaded/去重路径', async () => {
    const saved = deferred<void>();
    vi.mocked(host.local.repository.put).mockImplementationOnce(async () => { saved.resolve(); });
    await act(async () => root.render(<DesktopRankingDetailsModal entity={target} host={host} onClose={() => {}} />));
    expect(read).toHaveBeenCalledWith(card.id, expect.any(AbortSignal)); expect(container.textContent).toContain('不代表历史赛季正文快照'); expect(container.textContent).toContain('角色正文'); expect(fetch).not.toHaveBeenCalled();
    // click() returns void; act alone cannot await the external WebCrypto task.
    await act(async () => { button('存到本地库').click(); await saved.promise; });
    expect(host.local.repository.put).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: JSON.parse(card.data), provenance: { kind: 'unsigned', execution: 'downloaded' }, cloudRef: expect.objectContaining({ cardId: card.id }) })); expect(container.textContent).toContain('已保存到本地库');
  });
  it('保存等待真实摘要和写入回执；点击 act 完成不代表保存完成', async () => {
    const releaseDigest = deferred<void>(), writeEntered = deferred<void>(), acknowledgeWrite = deferred<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      await releaseDigest.promise;
      return digest(...args);
    });
    vi.mocked(host.local.repository.put).mockImplementationOnce(async () => {
      writeEntered.resolve();
      await acknowledgeWrite.promise;
    });
    try {
      await act(async () => root.render(<DesktopRankingDetailsModal entity={target} host={host} onClose={() => {}} />));
      await act(async () => button('存到本地库').click());
      expect(digestSpy).toHaveBeenCalledTimes(1);
      expect(host.local.repository.get).not.toHaveBeenCalled();
      expect(host.local.repository.put).not.toHaveBeenCalled();
      expect(button('处理中…').disabled).toBe(true);
      expect(container.textContent).not.toContain('已保存到本地库');

      await act(async () => { releaseDigest.resolve(); await writeEntered.promise; });
      expect(host.local.repository.put).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: JSON.parse(card.data), provenance: { kind: 'unsigned', execution: 'downloaded' }, cloudRef: expect.objectContaining({ cardId: card.id }) }));
      expect(button('处理中…').disabled).toBe(true);
      expect(container.textContent).not.toContain('已保存到本地库');

      await act(async () => { acknowledgeWrite.resolve(); });
      expect(container.textContent).toContain('已保存到本地库');
      expect(button('存到本地库').disabled).toBe(false);
      expect(host.local.repository.put).toHaveBeenCalledTimes(1);
    } finally {
      releaseDigest.resolve(); acknowledgeWrite.resolve(); digestSpy.mockRestore();
    }
  });
  it.each([{ status: 404, data: { success: false, code: PUBLIC_DATA_CARD_NOT_FOUND_CODE }, text: '已撤回' }, { status: 503, data: { success: false }, text: 'HTTP 503' }, { status: 500, data: { success: false }, text: 'HTTP 500' }, { status: 404, data: { success: false }, text: 'HTTP 404' }, { status: 200, data: { success: true, card: { id: card.id } }, text: '缺少数据卡正文' }])('榜单错误分态 $text', async ({ status, data, text }) => {
    read.mockResolvedValue({ ok: status === 200, status, data }); await act(async () => root.render(<DesktopRankingDetailsModal entity={target} host={host} onClose={() => {}} />)); expect(document.body.textContent).toContain(text); expect(button('重试')).toBeDefined(); expect(button('下载 JSON')).toBeUndefined();
  });
  it('切卡和关闭后忽略迟到正文', async () => {
    const old = deferred<unknown>(); read.mockReturnValueOnce(old.promise);
    await act(async () => root.render(<DesktopRankingDetailsModal entity={target} host={host} onClose={() => {}} />));
    const next = { ...target, entityId: 'another' }; read.mockResolvedValue({ ok: true, status: 200, data: { success: true, card: { ...card, id: 'another', name: '新正文卡' } } });
    await act(async () => root.render(<DesktopRankingDetailsModal entity={next} host={host} onClose={() => {}} />));
    await act(async () => old.resolve({ ok: true, status: 200, data: { success: true, card } })); expect(container.textContent).toContain('新正文卡'); expect(container.textContent).not.toContain('桌面详情');
    await act(async () => root.render(<DesktopRankingDetailsModal entity={null} host={host} onClose={() => {}} />)); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('预设按打包白名单读取，未知路径没有入口也没有请求', async () => {
    expect(canOpenDesktopRankingDetails({ entityType: 'preset', entityId: '../arbitrary.json' })).toBe(false);
    await expect(loadDesktopRankingDetails({ ...target, entityType: 'preset', entityId: '../arbitrary.json' }, host.online, new AbortController().signal)).rejects.toThrow('未收录'); expect(fetch).not.toHaveBeenCalled();
    const preset = PRESET_LIST[0]!; vi.mocked(fetch).mockResolvedValue(new Response('{"name":"预设正文"}', { status: 200 }));
    const loaded = await loadDesktopRankingDetails({ ...target, entityType: 'preset', entityId: preset.filename }, host.online, new AbortController().signal);
    expect(loaded.source.kind).toBe('preset'); expect(fetch).toHaveBeenCalledWith(`/presets/${preset.filename}`, expect.objectContaining({ credentials: 'omit', redirect: 'error' })); expect(read).not.toHaveBeenCalled();
  });
});
