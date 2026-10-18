import { DESKTOP_ROOM_SESSION_LIMITS, isDesktopRoomStartWithinNodeBudget } from '@mahoshojo/contracts/desktop-room-session';

/** Start-only source budget, before cloning, hashing, or the complete-source preview.
 * Counts compact JSON UTF-8 without constructing a serialized string/byte array.
 * Undefined object properties are omitted; undefined array entries become null.
 * Keys, quotes, escapes, separators and lone surrogates follow JSON.stringify.
 */
export function desktopRoomStartSourceBudget(input: unknown): 'complexity' | 'bytes' | null {
  if (!isDesktopRoomStartWithinNodeBudget(input)) return 'complexity';
  let remaining = DESKTOP_ROOM_SESSION_LIMITS.generationStartOriginalBytes;
  const add = (bytes: number) => (remaining -= bytes) >= 0;
  const string = (value: string): boolean => {
    if (value.length > remaining || !add(2)) return false;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      let bytes: number;
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes = 2;
      else if (code < 32) bytes = 6;
      else if (code < 128) bytes = 1;
      else if (code < 2048) bytes = 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes = 4; i += 1; }
      else if (code >= 0xd800 && code <= 0xdfff) bytes = 6;
      else bytes = 3;
      if (!add(bytes)) return false;
    }
    return true;
  };
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined) return add(4);
    if (typeof value === 'string') return string(value);
    if (typeof value === 'boolean') return add(value ? 4 : 5);
    if (typeof value === 'number') return add(Number.isFinite(value) ? String(value).length : 4);
    if (typeof value !== 'object') return false;
    if (!add(2)) return false;
    let comma = false;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (comma && !add(1) || !visit(value[i])) return false;
        comma = true;
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || property.get || property.set) return false;
        if (property.value === undefined) continue;
        if (comma && !add(1) || !string(key) || !add(1) || !visit(property.value)) return false;
        comma = true;
      }
    }
    return true;
  };
  try { return visit(input) ? null : 'bytes'; } catch { return 'bytes'; }
}
