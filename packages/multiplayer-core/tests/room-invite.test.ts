import { describe, expect, it } from 'vitest';
import { buildArenaRoomInviteText } from '../src/room-invite';
import { parseArenaRoomJoinCode } from '../src/room-join-code';

const roomId = 'room-actual';
const firstUuid = '5f0c9a2e-3b1d-4c8a-9e2f-7a6b5c4d3e2f';
const secondUuid = '0f0c9a2e-3b1d-4c8a-9e2f-7a6b5c4d3e20';

describe('buildArenaRoomInviteText', () => {
  it.each([
    { roomTitle: '周末茶会', hostDisplayName: 'Alice' },
    { roomTitle: '回顾上周房间码：room-last-week', hostDisplayName: 'Alice' },
    { roomTitle: '房间码：other-room', hostDisplayName: 'Alice' },
    { roomTitle: '周末茶会', hostDisplayName: 'room id: other-room' },
    { roomTitle: `曾用 ${firstUuid}`, hostDisplayName: `曾用 ${secondUuid}` },
    { roomTitle: `房间码：${firstUuid}`, hostDisplayName: secondUuid },
  ])('可信房间码先于用户详情，整段邀请往返不受 $roomTitle / $hostDisplayName 影响', details => {
    const text = buildArenaRoomInviteText('https://preview.example.test/', roomId, details);
    expect(text.split('\n')[1]).toBe(`房间码：${roomId}`);
    expect(text.indexOf(`房间码：${roomId}`)).toBeLessThan(text.indexOf(`房间：${details.roomTitle}`));
    expect(parseArenaRoomJoinCode(text)).toEqual({ ok: true, roomId });
    expect(text).toContain('https://preview.example.test/arena');
  });

  it('成员数不冒充在线人数，详情折叠空白且不改变 origin', () => {
    const text = buildArenaRoomInviteText('http://localhost:3000///', roomId, {
      roomTitle: '  夜战\n测试房  ', hostDisplayName: '房主\tAlice', memberCount: 2, memberLimit: 8,
    });
    expect(text).toContain('房间：夜战 测试房');
    expect(text).toContain('房主：房主 Alice');
    expect(text).toContain('当前成员：2/8 人');
    expect(text).not.toContain('当前在线');
    expect(text).toContain('http://localhost:3000/arena');
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('非法人数 %s 不产生误导统计', memberCount => {
    const text = buildArenaRoomInviteText('https://example.test', roomId, { memberCount, memberLimit: 8 });
    expect(text).not.toContain('当前成员');
  });

  it('零成员可展示，非法上限省略，缺省详情保持可往返', () => {
    expect(buildArenaRoomInviteText('https://example.test', roomId, { memberCount: 0, memberLimit: -1 })).toContain('当前成员：0 人');
    const text = buildArenaRoomInviteText('https://example.test', roomId);
    expect(text).not.toContain('当前成员');
    expect(parseArenaRoomJoinCode(text)).toEqual({ ok: true, roomId });
  });
});
