export type ArenaRoomJoinCodeParseResult = (
  | { readonly ok: true; readonly roomId: string }
  | { readonly ok: false; readonly error: string }
);

const SINGLE_TOKEN_PATTERN = /^[\w-]{1,128}$/u;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ROOM_ID_LABEL_PATTERN = /(?:房间码|房间\s*ID|room\s*id)\s*[:：=]\s*([^\s，。；、！？（）【】《》「」『』""'']+)/iu;

const asRoomId = (value: string): string | null => {
  const candidate = value.trim();
  return SINGLE_TOKEN_PATTERN.test(candidate) ? candidate : null;
};

/**
 * 解析「凭房间码加入」输入：
 * - 纯 token（UUID 或简单房间 ID）直接使用，保持旧行为兼容；
 * - 整段邀请文案优先识别「房间码：xxx / 房间ID=xxx / room id: xxx」标签；
 * - 未识别到标签时，任意文本中恰好一个不同 UUID 则抽取（忽略大小写去重）；
 * - 未识别到标签且出现多个不同 UUID 时拒绝猜测，提示用户只保留一个。
 * 返回的 roomId 是提取后的 ID；调用方不得把整段原文当 roomId 提交给 API。
 */
export const parseArenaRoomJoinCode = (input: string): ArenaRoomJoinCodeParseResult => {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: '请输入房间码或直接粘贴邀请文案' };
  const bareToken = asRoomId(trimmed);
  if (bareToken !== null) return { ok: true, roomId: bareToken };
  const labeled = trimmed.match(ROOM_ID_LABEL_PATTERN)?.[1];
  if (labeled) {
    const labeledRoomId = asRoomId(labeled);
    if (labeledRoomId !== null) return { ok: true, roomId: labeledRoomId };
  }
  const uuids = [...new Set(Array.from(trimmed.matchAll(UUID_PATTERN), match => match[0].toLowerCase()))];
  if (uuids.length === 1 && uuids[0]) return { ok: true, roomId: uuids[0] };
  if (uuids.length > 1) {
    return { ok: false, error: '检测到多个房间码，请只保留一个后重试' };
  }
  return { ok: false, error: '未识别到有效房间码；请粘贴完整邀请文案或房间码' };
};
