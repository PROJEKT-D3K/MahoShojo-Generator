// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomMember, RoomPresenceSnapshot } from '@mahoshojo/contracts/arena-room';
import {
  projectRoomMembers,
  RoomLobbyContent,
  RoomMembersView,
  RoomExitActions,
  type RoomExitConfirmation,
  type RoomLobbyContentProps,
} from '../src/arena-room';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const members: readonly RoomMember[] = [
  { userId: 'host', role: 'host', displayName: '房主甲', membershipState: 'active' },
  { userId: 'member', role: 'member', displayName: '成员乙', membershipState: 'active' },
  { userId: 'revoked', role: 'member', displayName: '已移除', membershipState: 'revoked' },
];
const presence: RoomPresenceSnapshot = {
  protocolVersion: 1, type: 'room.presence', roomId: 'room-1', roomEpoch: 'epoch-1', onlineUserIds: ['host'],
};
const projection = (overrides: Partial<Parameters<typeof projectRoomMembers>[0]> = {}) => projectRoomMembers({
  roomId: 'room-1', roomEpoch: 'epoch-1', members, presence, presenceEligible: true, ...overrides,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const lobbyProps = (): RoomLobbyContentProps => ({
  roomTitle: '房间标题', visibility: 'public', joinCode: '  room-1  ', rooms: [], loading: false,
  busy: false, onRoomTitleChange: vi.fn(), onVisibilityChange: vi.fn(), onJoinCodeChange: vi.fn(),
  onCreate: vi.fn(), onDiscover: vi.fn(), onDiscoverMore: vi.fn(), onJoin: vi.fn(),
});

describe('shared Room membership projection', () => {
  it('只统计 active 成员，与实际在线人数分开，保持原输入不变', () => {
    const view = projection();
    expect(view.activeMembers.map(({ userId, presence: status }) => [userId, status]))
      .toEqual([['host', 'online'], ['member', 'offline']]);
    expect(view).toMatchObject({ activeCount: 2, onlineCount: 1, host: members[0], summary: '当前 2 位成员，1 人在线，1 人离线。' });
    expect(members).toHaveLength(3);
    expect(members[0]).not.toHaveProperty('presence');
    expect(projection({ presence: { ...presence, onlineUserIds: ['revoked', 'unknown'] } }).onlineCount).toBe(0);
  });

  it.each([
    { presenceEligible: false },
    { presence: null },
    { roomId: null },
    { roomEpoch: null },
    { presence: { ...presence, roomId: 'other-room' } },
    { presence: { ...presence, roomEpoch: 'old-epoch' } },
  ])('宿主不可用、无 presence 或房间/epoch 不匹配时保守显示 unknown：%j', (overrides) => {
    const view = projection(overrides);
    expect(view.onlineCount).toBeNull();
    expect(view.activeMembers.every((member) => member.presence === 'unknown')).toBe(true);
    expect(view.summary).toBe('当前 2 位成员；在线状态暂不可用。');
  });

  it('空在线列表表示全员离线，不把有效的零人数误判为 unknown', () => {
    expect(projection({ presence: { ...presence, onlineUserIds: [] } }))
      .toMatchObject({ onlineCount: 0, summary: '当前 2 位成员，0 人在线，2 人离线。' });
  });
});

describe('shared controlled Room lobby', () => {
  it('将标题、可发现性与房间码编辑交给宿主，加入只 trim 不解析邀请', async () => {
    const props = lobbyProps();
    await act(async () => root.render(<RoomLobbyContent {...props} />));
    for (const [id, value, callback] of [
      ['arena-room-title', '新标题', props.onRoomTitleChange],
      ['arena-room-join-code', '邀请文字 room-1', props.onJoinCodeChange],
    ] as const) {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(callback).toHaveBeenCalledWith(value);
    }
    const select = container.querySelector<HTMLSelectElement>('#arena-room-visibility')!;
    await act(async () => {
      select.value = 'unlisted';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(props.onVisibilityChange).toHaveBeenCalledWith('unlisted');
    await act(async () => button('创建多人房间').click());
    expect(props.onCreate).toHaveBeenCalledOnce();
    await act(async () => button('加入房间').click());
    expect(props.onJoin).toHaveBeenCalledWith('room-1');
    expect(container.textContent).not.toContain('自动识别');
    await act(async () => root.render(<RoomLobbyContent {...props} joinCode="  邀请文字 room-1  " joinCodeHint="宿主邀请码提示" />));
    await act(async () => button('加入房间').click());
    expect(props.onJoin).toHaveBeenLastCalledWith('邀请文字 room-1');
    expect(container.textContent).toContain('宿主邀请码提示');
  });

  it('保留空态、加载态、错误重试、分页与原 busy/空输入禁用规则', async () => {
    const props = lobbyProps();
    await act(async () => root.render(<RoomLobbyContent {...props} roomTitle=" " joinCode=" " />));
    expect(container.textContent).toContain('暂无公开房间');
    expect(button('创建多人房间').disabled).toBe(true);
    expect(button('加入房间').disabled).toBe(true);
    await act(async () => root.render(<RoomLobbyContent {...props} loading busy />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('正在加载公开房间…');
    expect(button('正在加载…').disabled).toBe(true);
    expect(button('创建多人房间').disabled).toBe(true);
    expect(button('加入房间').disabled).toBe(true);
    await act(async () => root.render(<RoomLobbyContent {...props} error="目录暂不可用" nextCursor="next" />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('目录暂不可用');
    await act(async () => button('重试').click());
    await act(async () => button('加载更多').click());
    expect(props.onDiscover).toHaveBeenCalledOnce();
    expect(props.onDiscoverMore).toHaveBeenCalledOnce();
    await act(async () => root.render(<RoomLobbyContent {...props} nextCursor="next" nextPageLabel="下一页" />));
    await act(async () => button('下一页').click());
    expect(props.onDiscoverMore).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('加载更多');
    await act(async () => root.render(<RoomLobbyContent {...props} nextCursor="next" loadingMore />));
    expect(button('正在加载更多…').disabled).toBe(true);
  });

  it('公开目录保留元信息、可滚动布局与按房间 ID 加入', async () => {
    const props = lobbyProps();
    await act(async () => root.render(<RoomLobbyContent {...props} rooms={[{
      roomId: 'listed-room', title: '公开房间甲', visibility: 'public', status: 'open',
      createdAt: '2026-10-01T00:00:00.000Z', lastActivityAt: new Date().toISOString(),
      hostDisplayName: '房主甲', memberCount: 2, memberLimit: 32,
    }]} />));
    expect(container.textContent).toContain('房主甲 · 2/32 人');
    expect(container.textContent).toContain('刚刚活跃');
    expect(container.querySelector('[aria-label="公开房间列表"]')?.className).toContain('max-h-64');
    await act(async () => button('加入').click());
    expect(props.onJoin).toHaveBeenCalledWith('listed-room');
  });
});

describe('shared Room members and exit actions', () => {
  it('共享展示不默认暴露 kick/提案能力，Web 可注入自己的提示与成员动作', async () => {
    const view = projection();
    await act(async () => root.render(<RoomMembersView view={view} />));
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('[data-member-presence="offline"]')?.textContent).toBe('离线（保留席位）');
    expect(container.textContent).not.toContain('提案');
    expect(container.querySelector('button')).toBeNull();
    const kick = vi.fn();
    await act(async () => root.render(<RoomMembersView view={view} selfUserId="host" onKick={kick} membershipHint="宿主成员提示" />));
    const trigger = button('移除');
    await act(async () => trigger.click());
    expect(kick).toHaveBeenCalledWith(view.activeMembers[1], trigger);
    expect(container.textContent).toContain('宿主成员提示');
    await act(async () => root.render(<RoomMembersView view={view} selfUserId="member" onKick={kick} />));
    expect(container.querySelector('button')).toBeNull();
  });

  it.each(['host', 'member'] as const)('%s 的确认与取消受控，聚焦、恢复焦点及 busy 行为保持一致', async (role) => {
    const onClose = vi.fn();
    const onLeave = vi.fn();
    let setBusy: (value: boolean) => void = () => undefined;
    function Harness() {
      const [confirmation, setConfirmation] = useState<RoomExitConfirmation>(null);
      const [busy, updateBusy] = useState(false);
      setBusy = updateBusy;
      return <RoomExitActions role={role} confirmation={confirmation} onConfirmationChange={setConfirmation} busy={busy} onClose={onClose} onLeave={onLeave} />;
    }
    await act(async () => root.render(<Harness />));
    const action = role === 'host' ? '关闭房间' : '离开房间';
    const confirm = `确认${action}`;
    await act(async () => button(action).click());
    expect(document.activeElement).toBe(button(confirm));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
    await act(async () => button('取消').click());
    expect(document.activeElement).toBe(button(action));
    await act(async () => button(action).click());
    await act(async () => setBusy(true));
    expect(button(confirm).disabled).toBe(true);
    await act(async () => button(confirm).click());
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
    await act(async () => setBusy(false));
    await act(async () => button(confirm).click());
    expect(role === 'host' ? onClose : onLeave).toHaveBeenCalledOnce();
    expect(role === 'host' ? onLeave : onClose).not.toHaveBeenCalled();
  });

  it('Web 专属的停止生成按钮/确认由宿主插槽保留，默认无该能力', async () => {
    const props = { role: 'host' as const, confirmation: null, busy: false, onConfirmationChange: vi.fn(), onClose: vi.fn(), onLeave: vi.fn() };
    await act(async () => root.render(<RoomExitActions {...props} />));
    expect(container.textContent).not.toContain('生成');
    await act(async () => root.render(<RoomExitActions {...props} extraActions={<button>宿主停止生成</button>} />));
    expect(button('宿主停止生成')).toBeDefined();
    await act(async () => root.render(<RoomExitActions {...props} extraConfirmation={<p>宿主生成确认</p>} />));
    expect(container.textContent).toContain('宿主生成确认');
    expect(container.textContent).not.toContain('关闭房间');
  });
});
