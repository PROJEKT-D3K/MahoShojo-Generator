export type ArenaRoomInviteDetails = {
  readonly roomTitle?: string | null;
  readonly hostDisplayName?: string | null;
  readonly memberCount?: number | null;
  readonly memberLimit?: number | null;
};

const normalizeInviteLineValue = (value: string | null | undefined): string | null => {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized : null;
};

const normalizeInviteCount = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

export const buildArenaRoomInviteText = (
  origin: string,
  roomId: string,
  details: ArenaRoomInviteDetails = {},
): string => {
  const roomTitle = normalizeInviteLineValue(details.roomTitle);
  const hostDisplayName = normalizeInviteLineValue(details.hostDisplayName);
  const memberCount = normalizeInviteCount(details.memberCount);
  const memberLimit = normalizeInviteCount(details.memberLimit);
  const detailLines = [
    roomTitle ? `房间：${roomTitle}` : null,
    hostDisplayName ? `房主：${hostDisplayName}` : null,
    memberCount !== null
      ? `当前成员：${memberCount}${memberLimit !== null ? `/${memberLimit}` : ''} 人`
      : null,
  ].filter((line): line is string => line !== null);

  return [
    '魔法少女竞技场邀请你加入多人房间！',
    // 解析器保留首标签优先；可信房间码必须先于用户标题、昵称中的任意标签。
    `房间码：${roomId}`,
    ...detailLines,
    '',
    `打开 ${origin.replace(/\/+$/u, '')}/arena ，在「多人房间」的「凭房间码加入」中`,
    '直接粘贴整段邀请即可加入。',
  ].join('\n');
};
