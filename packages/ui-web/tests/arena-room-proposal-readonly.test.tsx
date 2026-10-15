// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-room-session.json';
import { PROPOSAL_VERSION, type ArenaProposal, type ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { RoomProposalReadOnlyList } from '../src/arena-room/RoomProposalReadOnlyList';
let root: Root, container: HTMLDivElement;
const makeSession = () => structuredClone(fixture.operations.create.success.result) as ArenaRoomSessionResponse;
const proposal = (session: ArenaRoomSessionResponse, expected = session.snapshot.sharedConfig.userGuidance): ArenaProposal => ({
  proposalVersion: PROPOSAL_VERSION, proposalId: 'proposal-view', roomId: session.roomId, authorUserId: session.self.userId,
  baseRevision: session.snapshot.revision, status: 'submitted', createdAt: '2026-10-15T12:00:00Z',
  changes: [{ changeId: 'guidance', type: 'setUserGuidance', expectedBase: { kind: 'value', value: expected }, value: '<img src=x>提案目标' }],
});
const freeze = <T,>(value: T): T => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('previews the received proposal immutably without write controls, network or unsafe markup', async () => {
  const session = makeSession(); session.snapshot.proposals = [proposal(session)]; const before = structuredClone(session); freeze(session);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive />));
  expect(container.textContent).toContain('全局引导改为');
  expect(container.textContent).toContain('这不代表服务器已接受或允许采纳');
  expect(container.querySelector('button, input, select, textarea, img')).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(session).toEqual(before);
});
it('marks stale snapshot and revision mismatch while showing genuine target-base conflicts', async () => {
  const session = makeSession(); const p = proposal(session, '旧基准'); p.baseRevision = Math.max(0, session.snapshot.revision - 1); session.snapshot.revision = p.baseRevision + 2; session.snapshot.proposals = [p];
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive={false} />));
  expect(container.textContent).toContain('最后已收到的房间快照（当前未同步）'); expect(container.textContent).toContain(`修订 ${session.snapshot.revision}`);
  expect(container.textContent).toContain('提案基准版本与所见快照不同'); expect(container.textContent).toContain('目标基准冲突'); expect(container.textContent).toContain('预览时的目标值');
});
it('distinguishes an already satisfied target from a proposal receipt', async () => {
  const session = makeSession(); const p = proposal(session, '旧基准'); session.snapshot.sharedConfig.userGuidance = '<img src=x>提案目标'; session.snapshot.proposals = [p];
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive />));
  expect(container.textContent).toContain('按提案依赖顺序预览时，此项目标已满足；这不表示当前房间已应用或返回处理回执');
});
it('cannot claim a successful preview without a usable config', async () => {
  const session = makeSession(); session.snapshot.proposals = [proposal(session)]; session.snapshot.sharedConfig = null as unknown as typeof session.snapshot.sharedConfig;
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive={false} />));
  expect(container.textContent).toContain('不能完成预览'); expect(container.textContent).not.toContain('未发现目标基准冲突');
});
it('uses original IDs for unknown references without fetching names', async () => {
  const session = makeSession(); const p = proposal(session); p.changes = [{ changeId: 'add', type: 'addCombatant', expectedBase: { kind: 'absent' }, key: 'data-card:unknown-card', ref: { kind: 'character', id: 'unknown-card', versionToken: 'v1' } }]; session.snapshot.proposals = [p];
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive />));
  expect(container.textContent).toContain('unknown-card'); expect(fetch).not.toHaveBeenCalled();
});
it('removes the old account proposals when its session disappears, and describes empty viewer-projected lists truthfully', async () => {
  const session = makeSession(); session.snapshot.proposals = [proposal(session)];
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive />));
  await act(async () => root.render(<RoomProposalReadOnlyList session={null} isLive={false} />)); expect(container.textContent).toBe('');
  const next = makeSession(); next.snapshot.proposals = [];
  await act(async () => root.render(<RoomProposalReadOnlyList session={next} isLive />));
  expect(container.textContent).toContain('此快照没有当前账号可见的待处理提案'); expect(container.textContent).not.toContain('proposal-view');
});

it('does not mistake a target satisfied by a preceding preview step for current room state', async () => {
  const session = makeSession(); const p = proposal(session); const original = session.snapshot.sharedConfig.userGuidance;
  p.changes = [p.changes[0]!, { ...p.changes[0]!, changeId: 'dependent-guidance', dependsOn: ['guidance'] }]; session.snapshot.proposals = [p]; freeze(session);
  await act(async () => root.render(<RoomProposalReadOnlyList session={session} isLive />));
  expect(container.textContent).toContain('按提案依赖顺序预览时，此项目标已满足');
  expect(container.textContent).toContain('这不表示当前房间已应用');
  expect(session.snapshot.sharedConfig.userGuidance).toBe(original); expect(original).not.toBe('<img src=x>提案目标');
});
