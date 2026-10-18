'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { readMagicTeaPartyRoleDraft, sameMagicTeaPartyRoleDraft, sameMagicTeaPartyRoleSource, type MagicTeaPartyRoleDraft } from '@mahoshojo/domain/magic-tea-party/role-editor';
import type { MagicTeaPartyRole } from '@mahoshojo/domain/magic-tea-party/types';

type DraftEntry = { observed?: MagicTeaPartyRole; source: MagicTeaPartyRole; draft: MagicTeaPartyRoleDraft; error: string | null; notice: string | null };
export type MagicTeaPartyRoleEditorProps = {
  scope: string;
  role: MagicTeaPartyRole | null;
  disabled?: boolean;
  hidden?: boolean;
  /** Keep a recovery action reachable when the edited role/session is removed. */
  allowDiscardAll?: boolean;
  /** Resolve only after the host's local commit. Null rejects the save while retaining the draft. */
  onSave: (source: MagicTeaPartyRole, draft: MagicTeaPartyRoleDraft) => Promise<MagicTeaPartyRole | null>;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Existing host-only advanced editor; it does not become a shared capability. */
  children?: ReactNode;
  additionalDirty?: boolean;
  onReset?: () => void;
};

export function MagicTeaPartyRoleEditor({ scope, role, disabled = false, hidden = false, onSave, onDirtyChange,
  onBusyChange, children, additionalDirty = false, onReset, allowDiscardAll = false }: MagicTeaPartyRoleEditorProps) {
  const id = useId();
  const entries = useRef(new Map<string, DraftEntry>());
  const [, render] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const alive = useRef(false);
  const key = JSON.stringify([scope, role?.id ?? null]);
  const current = useRef({ key, epoch: 0 });
  if (current.current.key !== key) current.current = { key, epoch: current.current.epoch + 1 };
  const callbacks = useRef({ onDirtyChange, onBusyChange }); callbacks.current = { onDirtyChange, onBusyChange };
  const entryDirty = (item: DraftEntry) => !sameMagicTeaPartyRoleDraft(item.draft, readMagicTeaPartyRoleDraft(item.source));
  const cached = entries.current.get(key);
  // The old props are tolerated only until the host first absorbs this receipt.
  if (cached?.observed && role && sameMagicTeaPartyRoleSource(cached.source, role)) delete cached.observed;
  const entry = cached && (entryDirty(cached) || additionalDirty || !role || sameMagicTeaPartyRoleSource(cached.source, role) || sameMagicTeaPartyRoleSource(cached.observed, role)) ? cached
    : role ? { source: role, draft: readMagicTeaPartyRoleDraft(role), error: null, notice: null } : null;
  // Host-only fields share the same frozen source while dirty; an external change must
  // conflict rather than silently rebase a raw-card draft onto a new role.
  if (cached && entry !== cached) entries.current.delete(key);
  if (entry && additionalDirty && entry !== cached) entries.current.set(key, entry);
  const allDirty = () => additionalDirty || [...entries.current.values()].some(entryDirty);
  const notify = () => { callbacks.current.onDirtyChange?.(allDirty()); render(value => value + 1); };
  useEffect(() => { callbacks.current.onDirtyChange?.(allDirty()); });
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; callbacks.current.onDirtyChange?.(false); callbacks.current.onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!savingRef.current && !allDirty()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  });
  const discardAll = allowDiscardAll && allDirty() ? <button type="button" disabled={saving || disabled}
    className="text-xs text-amber-700 underline" onClick={() => {
      if (savingRef.current || disabled || !window.confirm('确认放弃全部未保存的角色草稿？已保存的会话内容不会改变。')) return;
      entries.current.clear(); onReset?.(); notify();
    }}>放弃全部角色草稿</button> : null;
  if (!role || !entry) return discardAll;
  const dirty = entryDirty(entry) || additionalDirty;
  const edit = (patch: Partial<MagicTeaPartyRoleDraft>) => {
    if (disabled || savingRef.current) return;
    entries.current.set(key, { ...entry, draft: { ...entry.draft, ...patch }, error: null, notice: null }); notify();
  };
  const reset = () => {
    if (disabled || savingRef.current) return;
    entries.current.delete(key); onReset?.(); notify();
  };
  const save = async () => {
    if (disabled || savingRef.current || !dirty) return;
    if (!entry.draft.name.trim()) {
      entries.current.set(key, { ...entry, error: '角色名称不能为空。', notice: null }); notify(); return;
    }
    const view = current.current;
    const frozen = { ...entry, error: null, notice: null };
    entries.current.set(key, frozen); savingRef.current = true; setSaving(true); callbacks.current.onBusyChange?.(true);
    try {
      const saved = await onSave(frozen.source, frozen.draft);
      if (!alive.current || current.current !== view || entries.current.get(key) !== frozen) return;
      entries.current.set(key, saved ? { observed: frozen.source, source: saved, draft: readMagicTeaPartyRoleDraft(saved), error: null, notice: '角色修改已保存到本地会话。' }
        : { ...frozen, error: '保存未完成，草稿已保留；请核对原保存或重试。' });
    } catch (error) {
      if (alive.current && current.current === view && entries.current.get(key) === frozen) {
        entries.current.set(key, { ...frozen, error: error instanceof Error ? error.message : '保存未完成，草稿已保留。' });
      }
    } finally {
      savingRef.current = false;
      if (alive.current) { setSaving(false); callbacks.current.onBusyChange?.(false); notify(); }
    }
  };
  return <><form hidden={hidden} className="space-y-3" aria-label="会话角色基础编辑" aria-busy={saving}
    onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}>
    {entry.notice ? <div role="status" className="text-xs text-emerald-600">{entry.notice}</div> : null}
    {entry.error ? <div role="alert" className="text-xs text-red-600">{entry.error}</div> : null}
    <fieldset disabled={disabled || saving} className="min-w-0 space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2"><label htmlFor={`${id}-name`} className="text-xs font-semibold text-gray-600">角色名称</label>
          <input id={`${id}-name`} aria-label="角色名称" className="input-field" value={entry.draft.name} onChange={event => edit({ name: event.target.value })} /></div>
        <div className="space-y-2"><label htmlFor={`${id}-notes`} className="text-xs font-semibold text-gray-600">角色备注</label>
          <input id={`${id}-notes`} aria-label="角色备注" className="input-field" value={entry.draft.notes} onChange={event => edit({ notes: event.target.value })} placeholder="可选" /></div>
      </div>
      <div className="space-y-2"><label htmlFor={`${id}-state`} className="text-xs font-semibold text-gray-600">当前状态摘要</label>
        <textarea id={`${id}-state`} aria-label="当前状态摘要" className="input-field h-24 resize-y" value={entry.draft.currentState}
          onChange={event => edit({ currentState: event.target.value })} placeholder="更新角色当前状态摘要" /></div>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!dirty} className="rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? '保存中…' : '保存修改'}</button>
        <button type="button" disabled={!dirty} onClick={reset} className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50">重置</button>
        {dirty ? <span className="text-xs text-amber-700">有未保存修改</span> : null}
      </div>
    </fieldset>
  </form>{discardAll}</>;
}
