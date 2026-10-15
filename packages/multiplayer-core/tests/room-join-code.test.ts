import { describe, expect, it } from 'vitest';
import { parseArenaRoomJoinCode } from '@mahoshojo/multiplayer-core/room-join-code';

const UUID = '5f0c9a2e-3b1d-4c8a-9e2f-7a6b5c4d3e2f';
const OTHER_UUID = '0f0c9a2e-3b1d-4c8a-9e2f-7a6b5c4d3e20';

describe('shared room join code parser', () => {
  it.each([UUID, UUID.toUpperCase(), 'room-1', 'room_2', 'a'.repeat(128)])('preserves an explicit bare token: %s', roomId => {
    expect(parseArenaRoomJoinCode(`  ${roomId}  `)).toEqual({ ok: true, roomId });
  });

  it.each(['房间码：', '房间ID=', '房间 ID: ', 'Room Id: '])('reads the existing label %s', label => {
    expect(parseArenaRoomJoinCode(`欢迎加入！\n${label}room-9（快来）`)).toEqual({ ok: true, roomId: 'room-9' });
  });

  it('keeps a valid explicit label ahead of unrelated UUID references', () => {
    expect(parseArenaRoomJoinCode(`房间码：room-9\n附件：${UUID} ${OTHER_UUID}`)).toEqual({ ok: true, roomId: 'room-9' });
    expect(parseArenaRoomJoinCode(`room id: ${UUID.toUpperCase()}`)).toEqual({ ok: true, roomId: UUID.toUpperCase() });
  });

  it('extracts a single UUID without treating its surrounding URL as an origin or command', () => {
    expect(parseArenaRoomJoinCode(`https://untrusted.invalid/redirect?room=${UUID.toUpperCase()}&action=join`))
      .toEqual({ ok: true, roomId: UUID });
  });

  it('deduplicates repeated UUID references case-insensitively and stays stateless across calls', () => {
    const text = `请加入 ${UUID}，再次确认 ${UUID.toUpperCase()}`;
    expect(parseArenaRoomJoinCode(text)).toEqual({ ok: true, roomId: UUID });
    expect(parseArenaRoomJoinCode(text)).toEqual({ ok: true, roomId: UUID });
  });

  it('rejects multiple distinct unlabelled UUIDs rather than guessing', () => {
    expect(parseArenaRoomJoinCode(`${UUID} ${UUID.toUpperCase()} ${OTHER_UUID}`))
      .toEqual({ ok: false, error: '检测到多个房间码，请只保留一个后重试' });
  });

  it.each(['没有房间码的邀请', 'https://untrusted.invalid/room', 'room id: not/a/code', 'a'.repeat(129)])('rejects invalid input: %s', input => {
    expect(parseArenaRoomJoinCode(input)).toEqual({ ok: false, error: '未识别到有效房间码；请粘贴完整邀请文案或房间码' });
  });

  it('explains empty input', () => {
    expect(parseArenaRoomJoinCode(' \n\t ')).toEqual({ ok: false, error: '请输入房间码或直接粘贴邀请文案' });
  });
});
