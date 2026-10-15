// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataCardsModal, type DataCardsModalHost, type OwnedCardMetadataPort, type OwnedCardMetadataOutcome } from '../src/cloud-save';
const target = { id: 'c', type: 'character' as const, name: '权威名称', description: '权威描述', isPublic: 1 as const, reviewStatus: 'approved' as const, hasPendingUpdate: true, version: 'a'.repeat(64) };
const row = { id: 'c', user_id: 7, type: 'character', name: '摘要名称', description: '', is_public: 1, review_status: 'approved', favorite_count: 0, usage_count: 0 };
let root: Root; let container: HTMLDivElement; let port: OwnedCardMetadataPort; let host: DataCardsModalHost;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());
const field = () => document.querySelector<HTMLInputElement>('input[aria-label="名称"]')!;
const edit = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const close = vi.fn();
const render = (scopeKey = '7:1', isOpen = true) => act(async () => root.render(<DataCardsModal host={host} metadataEditor={port} isOpen={isOpen} summaryOwnerId={7} scopeKey={scopeKey} dataCards={[]} currentPage={1} cardsPerPage={12} onPageChange={() => {}} onClose={close} />));
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); close.mockReset();
  port = { isCurrent: () => true, read: vi.fn(async () => ({ kind: 'ready' as const, target })), write: vi.fn(async () => ({ kind: 'saved' as const })), onBusyChange: vi.fn(), onSaved: vi.fn() };
  host = { defaultCapacity: 20, recycleLimit: 5, fetchSummaryPage: vi.fn(async () => ({ success: true, cards: [row], total: 1, nextOffset: null } as never)), loadFullCard: vi.fn(() => { throw new Error('不得为编辑元信息下载正文'); }), fetchCardMetaBatch: vi.fn(async () => null), downloadJson: vi.fn(), isHotCard: () => false,
    tilePlatform: { reviewHref: '/review', Link: ({ children, ...props }) => <a {...props}>{children}</a>, marks: { isLiked: () => false, markLiked: () => true }, copyText: vi.fn() } };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('摘要入口只读权威元信息，取消无写入，成功提交新信息并刷新分页', async () => {
  await render(); await click('修改信息'); expect(field().value).toBe(target.name); expect(host.loadFullCard).not.toHaveBeenCalled();
  await click('取消'); expect(port.write).not.toHaveBeenCalled();
  await click('修改信息'); await edit('新名称'); await click('保存');
  expect(port.write).toHaveBeenCalledExactlyOnceWith(target, { name: '新名称', description: target.description, isPublic: 1 });
  expect(host.fetchSummaryPage).toHaveBeenCalledTimes(2); expect(document.body.textContent).toContain('数据卡信息已更新'); expect(field()).toBeNull();
});
it('同步单飞、关闭/Escape/取消受在途保护，分页错误不会吞掉表单写入错误', async () => {
  const pending = deferred<OwnedCardMetadataOutcome>(); port.write = vi.fn(() => pending.promise);
  await render(); await click('修改信息'); await edit('保留输入');
  vi.mocked(host.fetchSummaryPage).mockRejectedValueOnce(new Error('摘要刷新离线')); await click('刷新');
  expect(document.body.textContent).toContain('摘要刷新离线');
  await act(async () => { button('保存').click(); button('保存').click(); document.querySelector<HTMLButtonElement>('[aria-label=关闭]')!.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(port.write).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(port.onBusyChange).toHaveBeenLastCalledWith(true); expect(button('取消').closest('fieldset')?.disabled).toBe(true);
  await act(async () => pending.resolve({ kind: 'rejected' as const, message: '名称需要调整' }));
  expect(field().value).toBe('保留输入'); expect(document.body.textContent).toContain('名称需要调整'); expect(document.body.textContent).toContain('摘要刷新离线'); expect(port.onBusyChange).toHaveBeenLastCalledWith(false);
});
it.each(['uncertain', 'conflict'] as const)('%s 保留输入、不重放；重新读取仅供核对，显式采用版本后才允许新提交', async (kind) => {
  port.write = vi.fn().mockResolvedValueOnce({ kind, message: kind === 'uncertain' ? '修改结果不确定' : '目标已变化' }).mockResolvedValueOnce({ kind: 'saved' as const });
  await render(); await click('修改信息'); await edit('我的草稿'); await click('保存');
  expect(button('保存').disabled).toBe(true); await click('保存'); expect(port.write).toHaveBeenCalledOnce();
  const next = { ...target, name: '我的草稿', version: 'b'.repeat(64) }; port.read = vi.fn(async () => ({ kind: 'ready' as const, target: next }));
  await click('重新读取云端信息'); expect(field().value).toBe('我的草稿'); expect(document.body.textContent).toContain('不能确认上一请求的结果'); expect(button('保存').disabled).toBe(true); expect(port.onSaved).not.toHaveBeenCalled();
  await click('已核对，使用此版本继续编辑'); expect(port.write).toHaveBeenCalledOnce(); await click('保存');
  expect(port.write).toHaveBeenLastCalledWith(next, expect.objectContaining({ name: '我的草稿' }));
});
it('unknown后的读取失败仍保留unknown和输入，不会解锁旧版本', async () => {
  port.write = vi.fn(async () => ({ kind: 'uncertain' as const, message: '修改结果不确定' }));
  await render(); await click('修改信息'); await edit('保留'); await click('保存'); port.read = vi.fn(async () => ({ kind: 'rejected' as const, message: '离线' }));
  await click('重新读取云端信息'); expect(field().value).toBe('保留'); expect(button('保存').disabled).toBe(true); expect(document.body.textContent).toContain('离线'); expect(document.body.textContent).toContain('修改结果不确定');
});
it.each(['read', 'write'] as const)('同账号epoch变化丢弃旧%s迟到响应，不移交旧稿到新作用域', async (stage) => {
  const pending = deferred<any>();
  if (stage === 'read') port.read = vi.fn(() => pending.promise); else port.write = vi.fn(() => pending.promise);
  await render(); await click('修改信息'); if (stage === 'write') { await edit('旧账号草稿'); await click('保存'); }
  await render('7:2'); await act(async () => pending.resolve(stage === 'read' ? { kind: 'ready' as const, target } : { kind: 'saved' as const }));
  expect(field()).toBeNull(); expect(document.body.textContent).not.toContain('数据卡信息已更新'); expect(port.onSaved).not.toHaveBeenCalled();
});
it('派发前动态host阻塞与身份变化均不发送；封禁重读不能被旧草稿解除', async () => {
  let blocked = false; port.isBlocked = () => blocked;
  port.read = vi.fn(async () => ({ kind: 'ready' as const, target: { ...target, isPublic: -1 as const } }));
  await render(); await click('修改信息'); expect(document.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
  blocked = true; await click('保存'); expect(port.write).not.toHaveBeenCalled(); blocked = false;
  port.isCurrent = () => false; await click('保存'); expect(port.write).not.toHaveBeenCalled();
});


it('已在读取正文的选择动作先结束，不并行开启元信息编辑', async () => {
  const pending = deferred<unknown>(); const handler = deferred<void>(); host.loadFullCard = vi.fn(() => pending.promise);
  await act(async () => root.render(<DataCardsModal host={host} metadataEditor={port} isOpen dataCards={[row]} currentPage={1} cardsPerPage={12} onPageChange={() => {}} onClose={close} onLoadCard={() => handler.promise} />));
  await act(async () => { button('编辑档案').click(); button('修改信息').click(); }); expect(port.read).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ ...row, data: '{}' })); await click('修改信息'); expect(port.read).not.toHaveBeenCalled();
  await act(async () => handler.resolve()); await click('修改信息'); expect(port.read).toHaveBeenCalledOnce();
});


it('普通关闭再打开保留未知修改与原输入，不能直接提交另一笔', async () => {
  port.write = vi.fn(async () => ({ kind: 'uncertain' as const, message: '修改结果不确定' }));
  await render(); await click('修改信息'); await edit('未核对的原输入'); await click('保存');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label=关闭]')!.click());
  expect(close).toHaveBeenCalledOnce();
  await render('7:1', false); await render();
  expect(field()?.value).toBe('未核对的原输入');
  expect(document.body.textContent).toContain('修改结果不确定');
  expect(button('保存').disabled).toBe(true);
  await click('修改信息'); await click('保存'); expect(port.write).toHaveBeenCalledOnce();
});
