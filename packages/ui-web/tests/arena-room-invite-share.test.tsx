// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomInviteShareButton, useRoomInviteCopy, type RoomInviteCopyIntent, type RoomInviteCopyStatus } from '../src/arena-room';
import { copyTextToClipboard } from '../src/client/clipboard';

vi.mock('../src/client/clipboard', () => ({ copyTextToClipboard: vi.fn() }));
const clipboard = vi.mocked(copyTextToClipboard);
const deferred = () => {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let container: HTMLDivElement, root: Root;
let copy: () => Promise<void>;
function Host({ scope, prepare }: { scope: unknown; prepare: () => RoomInviteCopyIntent | null }) {
  const control = useRoomInviteCopy({ scope, prepare });
  copy = control.copy;
  return <RoomInviteShareButton status={control.status} onCopy={() => { void control.copy(); }} />;
}
const render = async (scope: unknown = 'A', prepare = () => ({ text: '邀请 A', isCurrent: () => true })) => {
  await act(async () => root.render(<StrictMode><Host scope={scope} prepare={prepare} /></StrictMode>));
};
const button = () => container.querySelector('button')!;
const click = async () => { await act(async () => button().click()); };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); clipboard.mockReset(); clipboard.mockResolvedValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('RoomInviteShareButton', () => {
  it.each([
    ['idle', '分享房间', false], ['copying', '复制中…', true], ['copied', '已复制邀请', false], ['error', '复制失败，请重试', false],
  ] as const)('受控状态 %s 保持既有复制标签与按钮语义', async (status: RoomInviteCopyStatus, text, disabled) => {
    const onCopy = vi.fn();
    await act(async () => root.render(<RoomInviteShareButton status={status} onCopy={onCopy} />));
    expect(button().type).toBe('button');
    expect(button().getAttribute('aria-label')).toBe('复制房间邀请文案');
    expect(button().querySelector('[aria-live="polite"]')?.textContent).toBe(text);
    expect(button().disabled).toBe(disabled); expect(onCopy).not.toHaveBeenCalled();
    await click(); expect(onCopy).toHaveBeenCalledTimes(disabled ? 0 : 1);
  });
});

describe('useRoomInviteCopy', () => {
  it.each([true, false])('仅明确点击写入，成功=%s 有同源反馈且定时归位不重写', async ok => {
    clipboard.mockResolvedValue(ok); await render();
    expect(clipboard).not.toHaveBeenCalled(); await click();
    expect(clipboard).toHaveBeenCalledExactlyOnceWith('邀请 A', expect.any(Function));
    expect(button().textContent).toBe(ok ? '已复制邀请' : '复制失败，请重试');
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(button().textContent).toBe('分享房间'); expect(clipboard).toHaveBeenCalledTimes(1);
  });

  it('拒绝失效或缺失意图，不写入剪贴板', async () => {
    await act(async () => root.render(<Host scope="A" prepare={() => null} />)); await click();
    await render('A', () => ({ text: '失效邀请', isCurrent: () => false })); await click();
    expect(clipboard).not.toHaveBeenCalled(); expect(button().textContent).toBe('分享房间');
  });

  it.each(['success', 'failure', 'throw'] as const)('scope A→B→A 后丢弃迟到 %s，不复活旧反馈', async result => {
    const pending = deferred(); clipboard.mockReturnValueOnce(pending.promise);
    await render(); await click(); expect(button().textContent).toBe('复制中…');
    await render('B'); await render('A');
    await act(async () => { if (result === 'throw') pending.reject(new Error('clipboard unavailable')); else pending.resolve(result === 'success'); });
    expect(button().textContent).toBe('分享房间'); expect(vi.getTimerCount()).toBe(0);
    expect(clipboard).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('宿主能力失效时丢弃迟到 %s，即使外观 scope 不变', async ok => {
    let current = true; const pending = deferred(); clipboard.mockReturnValueOnce(pending.promise);
    const prepare = () => ({ text: '邀请 A', isCurrent: () => current });
    await render('A', prepare); await click(); current = false;
    await act(async () => pending.resolve(ok)); await render('A', prepare);
    expect(button().textContent).toBe('分享房间'); expect(vi.getTimerCount()).toBe(0);
  });

  it('重复调用只认领最新请求，旧失败不能覆盖新成功', async () => {
    const old = deferred(); clipboard.mockReturnValueOnce(old.promise).mockResolvedValueOnce(true);
    await render(); await click();
    await act(async () => { await copy(); });
    expect(button().textContent).toBe('已复制邀请');
    await act(async () => old.resolve(false)); expect(button().textContent).toBe('已复制邀请');
  });

  it('旧 timer 不清除同 scope 的新反馈，也不跨 scope 清除反馈', async () => {
    await render(); await click(); await act(async () => vi.advanceTimersByTime(1_000));
    clipboard.mockResolvedValueOnce(false); await click();
    await act(async () => vi.advanceTimersByTime(1_000)); expect(button().textContent).toBe('复制失败，请重试');
    await render('B'); await click(); await act(async () => vi.advanceTimersByTime(1_000));
    expect(button().textContent).toBe('已复制邀请');
    await act(async () => vi.advanceTimersByTime(1_000)); expect(button().textContent).toBe('分享房间');
  });

  it('能力失效后的 timer 不污染新身份，卸载时不留 timer 或认领迟到结果', async () => {
    let current = true; await render('A', () => ({ text: '邀请 A', isCurrent: () => current })); await click();
    current = false; await render('B'); await click();
    await act(async () => vi.advanceTimersByTime(2_000)); expect(button().textContent).toBe('分享房间');
    const pending = deferred(); clipboard.mockReturnValueOnce(pending.promise); await click();
    await act(async () => root.render(null)); await act(async () => pending.resolve(true));
    expect(vi.getTimerCount()).toBe(0);
  });
});
