// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import { ArenaHostConfigPanel } from '@/components/arena/multiplayer/ArenaHostConfigPanel';
import type { ArenaRoomHostReconciliation } from '@/components/arena/multiplayer/useArenaRoomHostReconciliation';
import type { ArenaRoomControllerState } from '@/lib/arena-room/controller';
const mocks = vi.hoisted(() => ({ names: vi.fn(() => new Map<string, string>()) }));
vi.mock('@/lib/arena-room/reference-presentation', async original => ({ ...await original<object>(), useArenaRoomReferenceNames: mocks.names }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('uses the shared difference view while keeping publish and sync explicit host actions', async () => {
  const room = fixture.operations.create.success.result.snapshot.sharedConfig;
  const local = { ...room, selectedLanguage: 'en' };
  const publishLocal = vi.fn(), syncRoom = vi.fn();
  const reconciliation = { state: { kind: 'conflicted', reasons: ['shared-config'], roomConfig: room, localConfig: local, revision: 7 }, publishLocal, syncRoom } as unknown as ArenaRoomHostReconciliation;
  const controllerState = { session: fixture.operations.create.success.result, configPublishPending: false, configPublishResultUnknown: false } as unknown as ArenaRoomControllerState;
  await act(async () => root.render(<ArenaHostConfigPanel controllerState={controllerState} reconciliation={reconciliation} />));
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
  await act(async () => button('查看差异').click());
  expect(container.textContent).toContain('与房间当前设置相比，本地修改了');
  expect(container.textContent).toContain('生成语言：'); expect(container.textContent).toContain('English');
  expect(container.textContent).toContain('当前房间 · 配置版本 7');
  expect(mocks.names).toHaveBeenCalled(); expect(publishLocal).not.toHaveBeenCalled(); expect(syncRoom).not.toHaveBeenCalled();
  await act(async () => button('收起差异').click()); expect(container.textContent).not.toContain('与房间当前设置相比，本地修改了');
  await act(async () => button('更新房间配置').click()); expect(publishLocal).toHaveBeenCalledTimes(1);
});

it('unknown 使用共享核对与二次结束确认，普通卸载不结束跟踪', async () => {
  const checkConfigPublish = vi.fn(), endConfigPublishTracking = vi.fn(), readConfigAfterEnd = vi.fn();
  const controller = { checkConfigPublish, endConfigPublishTracking, readConfigAfterEnd } as unknown as import('@/lib/arena-room/controller').ArenaRoomController;
  const reconciliation = { state: { kind: 'idle' }, publishLocal: vi.fn(), syncRoom: vi.fn() } as unknown as ArenaRoomHostReconciliation;
  const state = { session: fixture.operations.create.success.result, configPublishPending: false, configPublishResultUnknown: true,
    configTracking: { id: 'old-post', phase: 'unknown', target: null, observation: 'target-matches', checking: false } } as unknown as ArenaRoomControllerState;
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={state} reconciliation={reconciliation} />));
  expect(container.textContent).toContain('原请求结果仍无法确认');
  expect(button('更新房间配置').disabled).toBe(true);
  await act(async () => button('核对当前房间').click());
  expect(checkConfigPublish).toHaveBeenCalledOnce();
  expect(reconciliation.syncRoom).not.toHaveBeenCalled();
  await act(async () => button('结束本次跟踪').click());
  expect(endConfigPublishTracking).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(endConfigPublishTracking).not.toHaveBeenCalled();
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={state} reconciliation={reconciliation} />));
  await act(async () => button('结束本次跟踪').click());
  await act(async () => button('确认结束跟踪').click());
  expect(endConfigPublishTracking).toHaveBeenCalledWith('old-post');
  const ended = { ...state, configPublishResultUnknown: false, configTracking: { ...state.configTracking!, phase: 'ended-needs-read' as const } };
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={ended} reconciliation={reconciliation} />));
  expect(button('更新房间配置').disabled).toBe(true);
  await act(async () => button('重新读取房间').click());
  expect(readConfigAfterEnd).toHaveBeenCalledWith('old-post');
  expect(reconciliation.publishLocal).not.toHaveBeenCalled();
});

it.each(['missing-session', 'member', 'revoked-host'] as const)('%s 仍显示旧跟踪，核对/结束/新读不提供发布权限', async (scope) => {
  const original = fixture.operations.create.success.result;
  const session = scope === 'missing-session' ? null : { ...original, self: { ...original.self,
    role: scope === 'member' ? 'member' : 'host', membershipState: scope === 'revoked-host' ? 'revoked' : 'active' } };
  const checkConfigPublish = vi.fn(), endConfigPublishTracking = vi.fn(), readConfigAfterEnd = vi.fn();
  const controller = { checkConfigPublish, endConfigPublishTracking, readConfigAfterEnd } as unknown as import('@/lib/arena-room/controller').ArenaRoomController;
  const reconciliation = { state: { kind: 'idle' }, publishLocal: vi.fn(), syncRoom: vi.fn() } as unknown as ArenaRoomHostReconciliation;
  const state = { session, configPublishPending: false, configPublishResultUnknown: true,
    configTracking: { id: 'original-scope', phase: 'unknown', target: null,
      observation: scope === 'missing-session' ? 'authority-unavailable' : 'scope-changed', checking: false } } as unknown as ArenaRoomControllerState;
  const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={state} reconciliation={reconciliation} />));
  expect(container.querySelector('[aria-label="配置发布跟踪"]')).not.toBeNull();
  expect(button('更新房间配置')).toBeUndefined();
  expect(button('同步房间配置')).toBeUndefined();
  await act(async () => button('核对当前房间').click());
  await act(async () => button('结束本次跟踪').click());
  await act(async () => button('确认结束跟踪').click());
  expect(checkConfigPublish).toHaveBeenCalledOnce();
  expect(endConfigPublishTracking).toHaveBeenCalledWith('original-scope');
  const ended = { ...state, configPublishResultUnknown: false,
    configTracking: { ...state.configTracking!, phase: 'ended-needs-read' as const } };
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={ended} reconciliation={reconciliation} />));
  await act(async () => button('重新读取房间').click());
  expect(readConfigAfterEnd).toHaveBeenCalledWith('original-scope');
  await act(async () => root.render(<ArenaHostConfigPanel controller={controller} controllerState={{ ...ended, configTracking: null }} reconciliation={reconciliation} />));
  expect(container.querySelector('[aria-label="配置发布跟踪"]')).toBeNull();
  expect(container.textContent).toBe('');
  expect(reconciliation.publishLocal).not.toHaveBeenCalled();
  expect(reconciliation.syncRoom).not.toHaveBeenCalled();
});
