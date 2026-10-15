// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { RoomConfigPublishStatus } from '../src/arena-room';
let root: Root, container: HTMLDivElement;
const callbacks = () => ({ onCheck: vi.fn(), onEnd: vi.fn(), onRead: vi.fn() });
const defaults = { phase: 'unknown' as const, observation: 'unobserved' as const, trackingId: 'A', busy: false, canEnd: true };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const click = async (text: string) => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); };
it('requires explicit confirmation tied to the displayed operation, not hide or cancel', async () => {
  const c = callbacks();
  await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} />));
  await click('核对当前房间'); expect(c.onCheck).toHaveBeenCalledOnce(); expect(c.onEnd).not.toHaveBeenCalled();
  await click('结束本次跟踪'); await click('继续跟踪'); expect(c.onEnd).not.toHaveBeenCalled();
  await click('结束本次跟踪');
  await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} trackingId="B" />));
  expect(container.querySelector('[aria-label="确认结束配置跟踪"]')).toBeNull();
  await click('结束本次跟踪'); await click('确认结束跟踪'); expect(c.onEnd).toHaveBeenCalledOnce();
  await act(async () => root.render(null)); expect(c.onEnd).toHaveBeenCalledOnce();
});
it('blocks end while busy or without current token and never ends on unmount', async () => {
  const c = callbacks();
  await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} canEnd={false} />));
  await click('结束本次跟踪'); expect(container.querySelector('[role="group"]')).toBeNull();
  await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} busy />));
  await click('核对当前房间'); expect(c.onCheck).not.toHaveBeenCalled();
  await act(async () => root.render(null)); expect(c.onEnd).not.toHaveBeenCalled();
});
it('ended state offers only a new read and explicitly disclaims server cancellation', async () => {
  const c = callbacks(); await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} phase="ended-needs-read" />));
  expect(container.textContent).toContain('不会撤销服务器请求'); expect(container.querySelectorAll('button')).toHaveLength(1);
  await click('重新读取房间'); expect(c.onRead).toHaveBeenCalledOnce(); expect(c.onEnd).not.toHaveBeenCalled();
});
it.each(['target-matches', 'target-differs', 'target-unavailable', 'authority-unavailable', 'scope-changed'] as const)('keeps %s observation distinct from a write receipt', async observation => {
  const c = callbacks(); await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...c} observation={observation} />));
  expect(container.textContent).not.toContain('发布成功'); expect(container.textContent).not.toContain('同步未生效');
  expect(container.textContent).toContain('不覆盖本地草稿'); expect(c.onEnd).not.toHaveBeenCalled();
});
it('compares the frozen original target with current authority without calling it the current draft', async () => {
  const s = structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse;
  const target = { ...s.snapshot.sharedConfig!, userGuidance: 'original intent' };
  await act(async () => root.render(<RoomConfigPublishStatus {...defaults} {...callbacks()} observation="target-differs" targetConfig={target} authoritySession={s} />));
  expect(container.textContent).toContain('原发布目标（不是当前草稿）'); expect(container.textContent).toContain('original intent');
});
