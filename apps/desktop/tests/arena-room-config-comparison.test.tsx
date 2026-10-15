// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import type { ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { DesktopRoomConfigComparison } from '../src/features/arena/room-config-comparison';
import type { DesktopArenaRoomSession } from '../src/features/arena/room-session';
import { createInitialArenaDraft, type ArenaDraft } from '../src/features/arena/session';
import type { prepareDesktopRoomSource } from '../src/features/arena/room-source';
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../src/features/arena/room-source', () => ({ prepareDesktopRoomSource: mocks.prepare }));
type Result = Awaited<ReturnType<typeof prepareDesktopRoomSource>>;
let root: Root, container: HTMLDivElement, draft: ArenaDraft, currentDraft: ArenaDraft, session: ArenaRoomSessionResponse, identity: symbol, owner: DesktopArenaRoomSession;
const render = async () => { await act(async () => root.render(<DesktopRoomConfigComparison owner={owner} session={session} draft={draft} isDraftCurrent={value => value === currentDraft} disabled={false} />)); };
const click = async () => { await act(async () => container.querySelector('button')!.click()); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  draft = createInitialArenaDraft(); currentDraft = draft; session = structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse; identity = Symbol('owner');
  owner = { confirmationOwner: () => identity, getSnapshot: () => ({ session }) } as unknown as DesktopArenaRoomSession;
  mocks.prepare.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('projects only on an explicit click and renders invalid projection as an error', async () => {
  mocks.prepare.mockResolvedValue({ ok: false, issues: ['引用缺少版本'] });
  await render(); expect(mocks.prepare).not.toHaveBeenCalled(); await click();
  expect(container.textContent).toContain('引用缺少版本'); expect(container.textContent).not.toContain('当前可共享设置一致');
});
it.each(['draft', 'room', 'credential'] as const)('discards a late comparison after %s changes', async change => {
  let finish!: (value: Result) => void;
  mocks.prepare.mockImplementation(() => new Promise<Result>(resolve => { finish = resolve; }));
  await render(); await click();
  if (change === 'draft') currentDraft = draft = { ...draft };
  if (change === 'room') session = { ...session, roomId: 'new-room' };
  if (change === 'credential') identity = Symbol('new credential');
  await render(); await act(async () => finish({ ok: true, sharedConfig: session.snapshot.sharedConfig }));
  expect(container.textContent).not.toContain('当前可共享设置一致');
  expect(container.textContent).not.toContain('与房间当前设置相比，本地修改了');
});
it('immediately hides a settled comparison when the authoritative snapshot changes', async () => {
  mocks.prepare.mockResolvedValue({ ok: true, sharedConfig: session.snapshot.sharedConfig });
  await render(); await click(); expect(container.textContent).toContain('当前可共享设置一致');
  session = { ...session, snapshot: { ...session.snapshot, revision: session.snapshot.revision + 1 } };
  await render(); expect(container.textContent).not.toContain('当前可共享设置一致');
});
it('discards an in-flight projection after unmount without displaying it in a new component', async () => {
  let finish!: (value: Result) => void;
  mocks.prepare.mockImplementation(() => new Promise<Result>(resolve => { finish = resolve; }));
  await render(); await click(); await act(async () => root.render(null));
  await act(async () => finish({ ok: true, sharedConfig: session.snapshot.sharedConfig }));
  await render(); expect(container.textContent).not.toContain('当前可共享设置一致');
});
