import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CombatantRepairPanel } from '@mahoshojo/ui-web/arena-report';
import type { ArenaSessionState, DesktopArenaSession } from './session';

export function seedDesktopManualRepairDraft(state: ArenaSessionState, generationId: string | null): string {
  if (!generationId) return '';
  const impacts = state.draft.combatants.flatMap((item, combatantIndex) => {
    const history = item.data.arena_history as { entries?: { impact?: string; metadata?: { generation_id?: string } }[] } | undefined;
    const entries = Array.isArray(history?.entries) ? history.entries.filter(entry => entry?.metadata?.generation_id === generationId) : [];
    const current = item.data.current_state as { summary?: string; generation_id?: string } | undefined;
    const impact = entries.length === 1 ? entries[0]?.impact : undefined;
    const currentStateSummary = current?.generation_id === generationId ? current.summary : undefined;
    return impact || currentStateSummary ? [{ combatantIndex, characterName: String(item.data.codename || item.data.name || ''),
      ...(impact ? { impact } : {}), ...(currentStateSummary ? { currentStateSummary } : {}) }] : [];
  });
  return impacts.length ? JSON.stringify({ impacts }, null, 2) : '';
}

/** Mount once per generation. Draft text stays in this page, never persisted. */
export function DesktopManualRepairPanel({ session, disabled, canApply }: {
  session: DesktopArenaSession; disabled: boolean; canApply: () => boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const generationId = session.manualRepairGenerationId();
  const [draft, setDraft] = useState(() => seedDesktopManualRepairDraft(state, generationId));
  const seeded = useRef(Boolean(draft)), userEdited = useRef(false);
  useEffect(() => {
    if (seeded.current || userEdited.current) return;
    const text = seedDesktopManualRepairDraft(state, generationId);
    if (!text) return;
    seeded.current = true; setDraft(text);
  }, [state, generationId]);
  const [applying, setApplying] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const apply = async () => {
    if (disabled || applying || !canApply() || session.isBusy()) return;
    setApplying(true); setError(null); setNotice(null);
    try { setNotice(await session.applyManualRepair(draft, { canApply,
      confirmTrustDowngrade: names => window.confirm(`角色「${names.join('、')}」具有原生或 canonical 来源。继续会创建非原生可编辑版本，服务器不会重新签名，源角色不会被自动覆盖。是否继续？`),
      confirmCreateMissingEffects: () => window.confirm('部分角色未找到本次 generation 的历战记录或当前状态。是否为本次战报创建明确标记的自定义 effect？'),
    })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '应用角色修复失败。'); }
    finally { setApplying(false); }
  };
  return <CombatantRepairPanel draft={draft} onDraftChange={value => { userEdited.current = true; setDraft(value); }} onApply={() => { void apply(); }}
    disabled={disabled} applying={applying} applied={!!state.repairs} error={error} notice={notice} />;
}
