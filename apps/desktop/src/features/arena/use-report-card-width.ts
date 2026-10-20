import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeBattleReportCardWidthMode, normalizeBattleReportCardWidthPx, type BattleReportCardWidthSettingsValue } from '@mahoshojo/ui-web/arena';

/** 两路由共用设备展示偏好；不进入独立草稿、生成输入或房间 wire。 */
export const ARENA_REPORT_CARD_WIDTH_KEY = 'mahoshojo.desktop.arena.report-card-width.v1';
const changedEvent = `${ARENA_REPORT_CARD_WIDTH_KEY}:changed`;
type Value = Required<BattleReportCardWidthSettingsValue>;
const normalize = (value: BattleReportCardWidthSettingsValue): Value => ({
  battleReportCardWidthMode: normalizeBattleReportCardWidthMode(value.battleReportCardWidthMode),
  battleReportCardWidthPx: normalizeBattleReportCardWidthPx(value.battleReportCardWidthPx),
});
const readDocument = (): Record<string, unknown> => {
  const raw = window.localStorage.getItem(ARENA_REPORT_CARD_WIDTH_KEY);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid width preferences');
  return parsed as Record<string, unknown>;
};
const read = () => {
  try { return { value: normalize(readDocument()), error: null }; }
  catch { return { value: normalize({}), error: '未能读取战报宽度偏好，原记录保持不变；当前使用自动宽度。' }; }
};

export function useDesktopReportCardWidth() {
  const [state, setState] = useState(read);
  const current = useRef(state.value);
  useEffect(() => {
    const refresh = () => { const next = read(); current.current = next.value; setState(next); };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === ARENA_REPORT_CARD_WIDTH_KEY) refresh();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(changedEvent, refresh);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener(changedEvent, refresh); };
  }, []);
  const onChange = useCallback((patch: Partial<BattleReportCardWidthSettingsValue>) => {
    const value = normalize({ ...current.current, ...patch });
    current.current = value;
    try {
      // 只在用户操作时写入，保留未知扩展；坏记录和拒读/拒写均不覆盖。
      window.localStorage.setItem(ARENA_REPORT_CARD_WIDTH_KEY, JSON.stringify({ ...readDocument(), ...value }));
      setState({ value, error: null });
      window.dispatchEvent(new Event(changedEvent));
    } catch {
      setState({ value, error: '战报宽度偏好未能保存；本次页面已应用，离开后可能恢复原设置。' });
    }
  }, []);
  return { ...state, onChange };
}
