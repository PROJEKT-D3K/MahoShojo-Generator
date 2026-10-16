// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomInviteShareButton, useRoomInviteCopy } from '../src/arena-room';
import { copyTextToClipboard } from '../src/client/clipboard';

let container: HTMLDivElement, root: Root;
let copyLatest: () => Promise<void>;
let originalClipboard: PropertyDescriptor | undefined, originalExecCommand: PropertyDescriptor | undefined;
const click = async () => { await act(async () => container.querySelector('button')!.click()); };
function Host({ scope }: { scope: string }) {
  const control = useRoomInviteCopy({ scope, prepare: () => ({ text: `邀请 ${scope}`, isCurrent: () => true }) });
  copyLatest = control.copy;
  return <RoomInviteShareButton status={control.status} onCopy={() => { void control.copy(); }} />;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand); else Reflect.deleteProperty(document, 'execCommand');
});

it('退休 A 的原生写入迟到失败不得 fallback 覆盖已经复制的 B', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  let clipboardText = '';
  const writeText = vi.fn((text: string) => {
    if (text === '邀请 A') return pending;
    clipboardText = text; return Promise.resolve();
  });
  const fallback = vi.fn(() => { clipboardText = document.querySelector('textarea')?.value ?? ''; return true; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  await act(async () => root.render(<Host scope="A" />)); await click();
  await act(async () => root.render(<Host scope="B" />)); await click();
  expect(clipboardText).toBe('邀请 B');
  await act(async () => reject(new Error('late clipboard rejection')));
  expect(fallback).not.toHaveBeenCalled();
  expect(clipboardText).toBe('邀请 B');
  expect(container.textContent).toBe('已复制邀请');
});

it('同 scope 较新请求成功后，旧请求拒绝不得再 fallback', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => { reject = no; });
  const writeText = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined);
  const fallback = vi.fn(() => true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  await act(async () => root.render(<Host scope="A" />)); await click();
  await act(async () => { await copyLatest(); });
  expect(container.textContent).toBe('已复制邀请');
  await act(async () => reject(new Error('older request failed')));
  expect(fallback).not.toHaveBeenCalled(); expect(container.textContent).toBe('已复制邀请');
});

it('复制前已失效的能力既不写原生剪贴板，也不 fallback', async () => {
  const writeText = vi.fn(async () => {}), fallback = vi.fn(() => true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  expect(await copyTextToClipboard('旧邀请', () => false)).toBe(false);
  expect(writeText).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
});

it('当前能力的普通 clipboard 拒绝仍可 fallback，默认旧调用保持兼容', async () => {
  const writeText = vi.fn(async () => { throw new Error('clipboard denied'); }), fallback = vi.fn(() => true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: fallback });
  expect(await copyTextToClipboard('当前邀请', () => true)).toBe(true);
  expect(await copyTextToClipboard('旧入口')).toBe(true);
  expect(fallback).toHaveBeenCalledTimes(2);
  expect(document.querySelector('textarea')).toBeNull();
});
