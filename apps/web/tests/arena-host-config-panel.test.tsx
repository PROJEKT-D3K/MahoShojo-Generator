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
