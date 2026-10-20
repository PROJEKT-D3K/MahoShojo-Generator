'use client';

import { type ChangeEvent, useEffect, useRef, useState } from 'react';

import { resolveMagicTeaPartyPlayerIdentity } from '@mahoshojo/domain/magic-tea-party/player-identity';
import type { MagicTeaPartyRole, MagicTeaPartyScenario, MagicTeaPartySession } from '@mahoshojo/domain/magic-tea-party/types';

export type MagicTeaPartyPlayerOption = { value: string; label: string };

export type MagicTeaPartySessionSetupPanelProps = {
  activeSession: MagicTeaPartySession | null;
  disabled?: boolean;
  readOnly?: boolean;
  roleFileAccept?: string;
  roleImportHint?: string;
  rolePickerLabel?: string;
  scenarioPickerLabel?: string;
  /** Host incarnation, so a late paste result cannot clear a replacement editor. */
  importScope?: string;
  onDirtyChange?: (dirty: boolean) => void;
  playerOptions: MagicTeaPartyPlayerOption[];
  onOpenRoleModal: () => void;
  onEditRole?: (roleId: string, trigger: HTMLButtonElement) => void;
  onOpenScenarioModal: () => void;
  onUploadRoles: (event: ChangeEvent<HTMLInputElement>) => void;
  onUploadScenarios: (event: ChangeEvent<HTMLInputElement>) => void;
  onUpdateRoles: (roles: MagicTeaPartyRole[]) => void;
  onUpdateScenarios: (scenario: MagicTeaPartyScenario | undefined, auxScenarios: MagicTeaPartyScenario[]) => void;
  onUpdatePlayerRole: (roleId: string | null) => void;
  onUpdateTitle: (title: string) => void;
  onLockTitle: () => void;
  onCreateSession?: () => void;
  onImportRolesText: (text: string) => void | boolean | Promise<void | boolean>;
  onImportScenariosText: (text: string) => void | boolean | Promise<void | boolean>;
  onDropRoles: (files: File[]) => void;
  onDropScenarios: (files: File[]) => void;
};

export function MagicTeaPartySessionSetupPanel(props: MagicTeaPartySessionSetupPanelProps) {
  const {
    activeSession,
    disabled = false,
    readOnly = false,
    roleFileAccept = '.json',
    roleImportHint = '粘贴 / 拖拽导入角色卡（JSON）',
    rolePickerLabel = '选择角色卡',
    scenarioPickerLabel = '选择情景卡',
    playerOptions,
    onOpenRoleModal,
    onOpenScenarioModal,
    onUploadRoles,
    onUploadScenarios,
    onUpdateRoles,
    onUpdateScenarios,
    onUpdatePlayerRole,
    onUpdateTitle,
    onLockTitle,
    onCreateSession,
    onImportRolesText,
    onImportScenariosText,
    onDropRoles,
    onDropScenarios,
    onDirtyChange,
  } = props;

  const roles = activeSession?.roles ?? [];
  const scenario = activeSession?.scenario;
  const auxScenarios = activeSession?.auxScenarios ?? [];
  const [rolePasteText, setRolePasteText] = useState('');
  const [scenarioPasteText, setScenarioPasteText] = useState('');
  useEffect(() => { onDirtyChange?.(Boolean(rolePasteText || scenarioPasteText)); }, [rolePasteText, scenarioPasteText, onDirtyChange]);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pastePending = useRef(false);
  const pasteVersions = useRef({ roles: 0, scenarios: 0 });
  const pasteLifecycle = useRef(0);
  const pasteScope = useRef(props.importScope ?? activeSession?.id ?? null);
  pasteScope.current = props.importScope ?? activeSession?.id ?? null;
  useEffect(() => () => { pasteLifecycle.current += 1; }, []);
  useEffect(() => {
    pastePending.current = false;
    setPasteBusy(false); setPasteError(null);
  }, [props.importScope, activeSession?.id]);
  const [collapsed, setCollapsed] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [isTitleFocused, setIsTitleFocused] = useState(false);
  const [isTitleComposing, setIsTitleComposing] = useState(false);
  const lastCommittedTitleRef = useRef('');
  const compositionRef = useRef(false);
  const prevSessionIdRef = useRef<string | null>(null);
  const hasSession = Boolean(activeSession);
  const canEdit = hasSession && !disabled && !readOnly;
  const canClearPaste = !disabled && !readOnly && !pasteBusy;
  const sessionId = activeSession?.id ?? null;
  const sessionTitle = activeSession?.title ?? '';
  const importPaste = (kind: 'roles' | 'scenarios') => {
    if (!canEdit || pastePending.current) return;
    const text = kind === 'roles' ? rolePasteText : scenarioPasteText;
    const version = pasteVersions.current[kind];
    const lifecycle = pasteLifecycle.current;
    const scope = pasteScope.current;
    const current = () => lifecycle === pasteLifecycle.current && scope === pasteScope.current;
    pastePending.current = true; setPasteBusy(true); setPasteError(null);
    const finish = (accepted: void | boolean) => {
      if (!current()) return;
      pastePending.current = false; setPasteBusy(false);
      if (accepted === false) { setPasteError('导入未完成，粘贴原文已保留。'); return; }
      if (version !== pasteVersions.current[kind]) return;
      pasteVersions.current[kind] += 1;
      (kind === 'roles' ? setRolePasteText : setScenarioPasteText)('');
      onDirtyChange?.(Boolean(kind === 'roles' ? scenarioPasteText : rolePasteText));
    };
    const failure = () => { if (current()) { pastePending.current = false; setPasteBusy(false); setPasteError('导入未完成，粘贴原文已保留。'); } };
    try {
      const result = (kind === 'roles' ? onImportRolesText : onImportScenariosText)(text);
      if (result && typeof result === 'object') void result.then(finish, failure);
      else finish(result);
    } catch { failure(); }
  };

  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      setTitleDraft('');
      setIsTitleComposing(false);
      setIsTitleFocused(false);
      lastCommittedTitleRef.current = '';
      compositionRef.current = false;
      return;
    }

    setTitleDraft(sessionTitle);
    setIsTitleComposing(false);
    setIsTitleFocused(false);
    compositionRef.current = false;
    lastCommittedTitleRef.current = sessionTitle;
  }, [sessionId, sessionTitle]);

  useEffect(() => {
    if (!sessionId) return;
    if (isTitleFocused || isTitleComposing) return;
    const nextTitle = sessionTitle;
    setTitleDraft(nextTitle);
    lastCommittedTitleRef.current = nextTitle;
  }, [sessionId, sessionTitle, isTitleFocused, isTitleComposing]);

  const commitTitle = (nextTitle: string) => {
    if (!canEdit) return;
    if (nextTitle === lastCommittedTitleRef.current) return;
    lastCommittedTitleRef.current = nextTitle;
    onUpdateTitle(nextTitle);
  };

  return (
    <fieldset disabled={disabled || readOnly} className="min-w-0 rounded-xl border border-pink-100 bg-white p-4 space-y-4">
      {pasteError ? <p role="alert" className="text-xs text-red-700">{pasteError}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-gray-800">会话设置</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-gray-600 hover:underline"
            onClick={() => { if (canEdit) onLockTitle(); }}
            title="标记为手动标题（阻止自动覆盖）"
            disabled={!canEdit}
          >
            锁定标题
          </button>
          <button
            type="button"
            className="text-xs text-pink-700 hover:underline"
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </div>

      {collapsed ? (
        <div className="text-xs text-gray-500">
          {hasSession
            ? `角色 ${roles.length} · 情景 ${scenario ? '已选' : '未选'} · 追加情景 ${auxScenarios.length}`
            : '尚未选择会话，展开可新建或选择。'}
        </div>
      ) : (
        <>
          {!hasSession ? (
            <div className="rounded-lg border border-dashed border-pink-200 bg-pink-50/60 px-3 py-3 text-xs text-pink-800">
              <div className="font-semibold">还没有会话</div>
              <div className="mt-1 text-pink-700">先新建或选择会话，才能编辑角色/情景与继续对话。</div>
              {onCreateSession ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md bg-pink-600 px-3 py-1 text-xs font-semibold text-white hover:bg-pink-700"
                    onClick={() => { if (!disabled && !readOnly) onCreateSession?.(); }}
                  >
                    新建会话
                  </button>
                  <span className="text-[11px] text-pink-600">或在左侧会话列表中选择已有会话</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-gray-600">角色</div>
            <button
              type="button"
              className="text-xs text-pink-700 hover:underline"
              onClick={() => { if (canEdit) onOpenRoleModal(); }}
              disabled={!canEdit}
            >
              {rolePickerLabel}
            </button>
          </div>
          <input type="file" accept={roleFileAccept} multiple className="input-field" onChange={(event) => { if (canEdit) onUploadRoles(event); }} disabled={!canEdit} />
          <div
            className="rounded-lg border border-dashed border-pink-200 bg-pink-50/40 p-3 text-xs text-gray-600"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!canEdit) return;
              const files = Array.from(event.dataTransfer.files || []);
              if (files.length === 0) return;
              void onDropRoles(files);
            }}
          >
            <div className="text-xs font-semibold text-gray-600">{roleImportHint}</div>
            <textarea
              className="input-field mt-2 h-20 resize-y"
              value={rolePasteText}
              onChange={(event) => { pasteVersions.current.roles += 1; setRolePasteText(event.target.value); onDirtyChange?.(Boolean(event.target.value || scenarioPasteText)); }}
              placeholder="粘贴角色卡 JSON（单卡/数组，支持 SillyTavern JSON）"
              disabled={!canEdit}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-pink-200 bg-white px-3 py-1 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canEdit || pasteBusy || !rolePasteText.trim()}
                onClick={() => importPaste('roles')}
              >
                导入
              </button>
              <button
                type="button"
                className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canClearPaste || !rolePasteText}
                onClick={() => {
                  if (!canClearPaste || pastePending.current) return;
                  pasteVersions.current.roles += 1; setRolePasteText(''); onDirtyChange?.(Boolean(scenarioPasteText));
                }}
              >
                清空
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {roles.length === 0 ? (
              <div className="text-xs text-gray-500">未选择角色（可选）</div>
            ) : (
              roles.map((role) => (
                <span key={role.id} className="inline-flex items-center gap-2 rounded-full bg-pink-50 px-3 py-1 text-xs text-pink-800">
                  {props.onEditRole ? <button type="button" className="hover:underline" disabled={!canEdit}
                    onClick={event => { if (canEdit) props.onEditRole?.(role.id, event.currentTarget); }} aria-label={`编辑角色：${role.name}`}>{role.name} · 编辑</button> : role.name}
                  <button
                    type="button"
                    className="text-pink-700 hover:text-pink-900"
                    onClick={() => { if (canEdit) onUpdateRoles(roles.filter((item) => item.id !== role.id)); }}
                    disabled={!canEdit}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-gray-600">情景</div>
            <button
              type="button"
              className="text-xs text-pink-700 hover:underline"
              onClick={() => { if (canEdit) onOpenScenarioModal(); }}
              disabled={!canEdit}
            >
              {scenarioPickerLabel}
            </button>
          </div>
          <input type="file" accept=".json" multiple className="input-field" onChange={(event) => { if (canEdit) onUploadScenarios(event); }} disabled={!canEdit} />
          <div
            className="rounded-lg border border-dashed border-pink-200 bg-pink-50/40 p-3 text-xs text-gray-600"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!canEdit) return;
              const files = Array.from(event.dataTransfer.files || []);
              if (files.length === 0) return;
              void onDropScenarios(files);
            }}
          >
            <div className="text-xs font-semibold text-gray-600">粘贴 / 拖拽导入情景卡</div>
            <textarea
              className="input-field mt-2 h-20 resize-y"
              value={scenarioPasteText}
              onChange={(event) => { pasteVersions.current.scenarios += 1; setScenarioPasteText(event.target.value); onDirtyChange?.(Boolean(event.target.value || rolePasteText)); }}
              placeholder="粘贴情景卡 JSON（单卡或数组）"
              disabled={!canEdit}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-pink-200 bg-white px-3 py-1 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canEdit || pasteBusy || !scenarioPasteText.trim()}
                onClick={() => importPaste('scenarios')}
              >
                导入
              </button>
              <button
                type="button"
                className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canClearPaste || !scenarioPasteText}
                onClick={() => {
                  if (!canClearPaste || pastePending.current) return;
                  pasteVersions.current.scenarios += 1; setScenarioPasteText(''); onDirtyChange?.(Boolean(rolePasteText));
                }}
              >
                清空
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {scenario ? (
              <div className="rounded-lg border border-pink-100 bg-pink-50 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-pink-800">主情景：{scenario.title}</div>
                  <button
                    type="button"
                    className="text-xs text-pink-700 hover:underline"
                    onClick={() => { if (canEdit) onUpdateScenarios(undefined, auxScenarios); }}
                    disabled={!canEdit}
                    title="移除主情景以便重新选择"
                  >
                    移除主情景
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-500">未选择主情景（可选）</div>
            )}
            {auxScenarios.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {auxScenarios.map((item) => (
                  <span key={item.id} className="inline-flex items-center gap-2 rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-700">
                    {item.title}
                    <button
                      type="button"
                      className="text-gray-500 hover:text-gray-700"
                      onClick={() => { if (canEdit) onUpdateScenarios(scenario, auxScenarios.filter((scn) => scn.id !== item.id)); }}
                      disabled={!canEdit}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label className="text-xs font-semibold text-gray-600">扮演方式</label>
          <select
            className="input-field"
            value={resolveMagicTeaPartyPlayerIdentity({ roles, playerRoleId: activeSession?.playerRoleId }).playerRoleId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              if (canEdit) onUpdatePlayerRole(value ? value : null);
            }}
            disabled={!canEdit}
          >
            {playerOptions.map((opt) => (
              <option key={opt.value || 'user'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <label className="text-xs font-semibold text-gray-600">会话标题</label>
          <input
            className="input-field"
            value={titleDraft}
            onFocus={() => setIsTitleFocused(true)}
            onBlur={() => {
              setIsTitleFocused(false);
              if (!compositionRef.current) {
                commitTitle(titleDraft);
              }
            }}
            onCompositionStart={() => {
              compositionRef.current = true;
              setIsTitleComposing(true);
            }}
            onCompositionEnd={(event) => {
              compositionRef.current = false;
              setIsTitleComposing(false);
              const nextTitle = event.currentTarget.value;
              setTitleDraft(nextTitle);
              commitTitle(nextTitle);
            }}
            onChange={(event) => {
              const nextTitle = event.target.value;
              setTitleDraft(nextTitle);
              const composing = (event.nativeEvent as InputEvent | undefined)?.isComposing || compositionRef.current;
              if (!composing) {
                commitTitle(nextTitle);
              }
            }}
            placeholder="输入会话标题"
            disabled={!canEdit}
          />
        </div>
      </div>
        </>
      )}
    </fieldset>
  );
}
