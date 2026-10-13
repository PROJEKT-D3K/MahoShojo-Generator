import type { RoomMember, RoomPresenceSnapshot } from '@mahoshojo/contracts/arena-room';

export type RoomMemberView = RoomMember & {
  readonly presence: 'online' | 'offline' | 'unknown';
};

export type RoomMembersViewModel = {
  readonly activeMembers: readonly RoomMemberView[];
  readonly host: RoomMemberView | undefined;
  readonly activeCount: number;
  readonly onlineCount: number | null;
  readonly summary: string;
};

export type RoomMembersProjectionInput = {
  readonly roomId: string | null;
  readonly roomEpoch: string | null;
  readonly members: readonly RoomMember[];
  readonly presence: RoomPresenceSnapshot | null;
  /** 宿主连接状态可用只代表允许使用匹配的 presence，不代表成员在线。 */
  readonly presenceEligible: boolean;
};

export function projectRoomMembers(input: RoomMembersProjectionInput): RoomMembersViewModel {
  const presence = input.presenceEligible && input.roomId !== null && input.roomEpoch !== null
    && input.presence?.roomId === input.roomId && input.presence.roomEpoch === input.roomEpoch
    ? input.presence : null;
  const onlineIds = presence ? new Set(presence.onlineUserIds) : null;
  const activeMembers: RoomMemberView[] = input.members
    .filter((member) => member.membershipState === 'active')
    .map((member) => ({
      ...member,
      presence: onlineIds === null ? 'unknown' : onlineIds.has(member.userId) ? 'online' : 'offline',
    }));
  const activeCount = activeMembers.length;
  const onlineCount = onlineIds === null
    ? null : activeMembers.filter((member) => member.presence === 'online').length;
  return {
    activeMembers,
    host: activeMembers.find((member) => member.role === 'host'),
    activeCount,
    onlineCount,
    summary: onlineCount === null
      ? `当前 ${activeCount} 位成员；在线状态暂不可用。`
      : `当前 ${activeCount} 位成员，${onlineCount} 人在线，${activeCount - onlineCount} 人离线。`,
  };
}
