import { useEffect, useRef, useState } from 'react';
import { MagicTeaPartySummaryBody } from '@mahoshojo/ui-web/magic-tea-party';

import { ErrorMessage } from '@/components/ErrorMessage';

import type { MagicTeaPartySummaryPatch } from '@/lib/magic-tea-party/storage';
import type { MagicTeaPartySession, MagicTeaPartyUpdateDraft } from '@/lib/magic-tea-party/types';

type MagicTeaPartySummaryPanelProps = {
  activeSession: MagicTeaPartySession | null;
  isGenerating: boolean;
  isSummarizing: boolean;
  summaryError: string | null;
  hasMessages: boolean;
  onGenerateSummary: () => Promise<boolean>;
  onClearSummary: () => Promise<boolean>;
  onSaveSummary: (patch: MagicTeaPartySummaryPatch) => Promise<boolean>;
  onSummaryIntent: () => void;
  onStopSummary: () => void;
  onAutoSummaryEnabledChange: (enabled: boolean) => void;
  updateDrafts: MagicTeaPartyUpdateDraft[] | null;
  updateRangeSize: number;
  isGeneratingUpdates: boolean;
  isApplyingUpdates: boolean;
  updateError: string | null;
  updateApplyMode: 'auto' | 'confirm' | 'draft';
  updateSnapshot?: { createdAt: number; revertedAt?: number } | null;
  onUpdateRangeSizeChange: (value: number) => void;
  onGenerateUpdates: () => void;
  onApplyUpdates: () => void;
  onClearUpdateDrafts: () => void;
  onRollbackUpdates: () => void;
};

const InlineSpinner = () => (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-pink-200 border-t-pink-600" aria-hidden="true" />
);

export function MagicTeaPartySummaryPanel(props: MagicTeaPartySummaryPanelProps) {
  const {
    activeSession,
    isGenerating,
    isSummarizing,
    summaryError,
    hasMessages,
    onGenerateSummary,
    onClearSummary,
    onSaveSummary,
    onSummaryIntent,
    onStopSummary,
    onAutoSummaryEnabledChange,
    updateDrafts,
    updateRangeSize,
    isGeneratingUpdates,
    isApplyingUpdates,
    updateError,
    updateApplyMode,
    updateSnapshot,
    onUpdateRangeSizeChange,
    onGenerateUpdates,
    onApplyUpdates,
    onClearUpdateDrafts,
    onRollbackUpdates,
  } = props;

  const disableActions = !activeSession || isGenerating;
  const canGenerate = !disableActions && hasMessages;
  const writeArenaHistory = Boolean(activeSession?.settings.writeArenaHistory);
  const writeCurrentState = Boolean(activeSession?.settings.writeCurrentState);
  const hasWriteEnabled = writeArenaHistory || writeCurrentState;
  const hasDrafts = Boolean(updateDrafts && updateDrafts.length > 0);
  const canRollback = Boolean(updateSnapshot && !updateSnapshot.revertedAt);
  const [draft, setDraft] = useState({ sessionId: activeSession?.id, text: activeSession?.summary ?? '',
    sections: activeSession?.summarySections, dirty: false });
  const draftsRef = useRef(new Map<string, typeof draft>());
  if (draft.sessionId) {
    if (draft.dirty) draftsRef.current.set(draft.sessionId, draft);
    else draftsRef.current.delete(draft.sessionId);
  }
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    setDraft(current => current.sessionId !== activeSession?.id
      ? draftsRef.current.get(activeSession?.id ?? '') ?? { sessionId: activeSession?.id, text: activeSession?.summary ?? '', sections: activeSession?.summarySections, dirty: false }
      : !current.dirty ? { sessionId: activeSession?.id, text: activeSession?.summary ?? '', sections: activeSession?.summarySections, dirty: false } : current);
  }, [activeSession?.id, activeSession?.summary, activeSession?.summarySections, draft.dirty]);
  const currentDraft = draft.sessionId === activeSession?.id ? draft : draftsRef.current.get(activeSession?.id ?? '') ?? {
    sessionId: activeSession?.id, text: activeSession?.summary ?? '', sections: activeSession?.summarySections, dirty: false };
  const summarySections = currentDraft.sections ?? {};
  const sectionEntries = Object.entries(summarySections);
  const hasSections = sectionEntries.length > 0;
  const disableSummaryEditing = !activeSession || (isSummarizing && isGenerating);
  const [collapsed, setCollapsed] = useState(false);

  const summaryUpdatedAt = activeSession?.summaryMeta?.updatedAt;

  const buildUniqueSectionKey = (base: string, used: Set<string>): string => {
    const normalizedBase = base.trim() || '小节';
    let candidate = normalizedBase;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${normalizedBase} ${index}`;
      index += 1;
    }
    return candidate;
  };

  const buildSectionsRecord = (entries: Array<[string, string]>): Record<string, string> | undefined => {
    if (entries.length === 0) return undefined;
    const record: Record<string, string> = {};
    const used = new Set<string>();
    entries.forEach(([title, text], index) => {
      const base = title.trim() || `小节 ${index + 1}`;
      const key = buildUniqueSectionKey(base, used);
      used.add(key);
      record[key] = typeof text === 'string' ? text : '';
    });
    return Object.keys(record).length > 0 ? record : undefined;
  };

  const persistSummarySections = (entries: Array<[string, string]>): void => {
    if (!activeSession) return;
    onSummaryIntent();
    setDraft({ ...currentDraft, sections: buildSectionsRecord(entries), dirty: true });
  };

  const saveDraft = async () => {
    if (!activeSession || !currentDraft.dirty || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const submitted = currentDraft;
    const { coverage: _coverage, tokenCount: _tokenCount, ...metadata } = activeSession.summaryMeta ?? {};
    try {
      const saved = await onSaveSummary({ summary: submitted.text.trim() || undefined,
      summarySections: submitted.sections, summaryMeta: { ...metadata, updatedAt: Date.now() } });
      if (saved && draftRef.current === submitted) setDraft(current => ({ ...current, dirty: false }));
    } finally { savingRef.current = false; setIsSaving(false); }
  };

  const replaceDraft = async (action: () => Promise<boolean>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const submitted = currentDraft;
    try {
      if (await action() && draftRef.current === submitted) setDraft(current => ({ ...current, dirty: false }));
    } finally { savingRef.current = false; setIsSaving(false); }
  };

  const handleAddSection = () => {
    if (!activeSession) return;
    const used = new Set(sectionEntries.map(([title]) => title));
    const nextKey = buildUniqueSectionKey('新小节', used);
    persistSummarySections([...sectionEntries, [nextKey, '']]);
  };

  const handleUpdateSection = (index: number, nextTitle?: string, nextText?: string) => {
    const nextEntries = sectionEntries.map((entry, idx) => {
      if (idx !== index) return entry;
      const [title, text] = entry;
      return [nextTitle ?? title, nextText ?? text] as [string, string];
    });
    persistSummarySections(nextEntries);
  };

  const handleRemoveSection = (index: number) => {
    const nextEntries = sectionEntries.filter((_, idx) => idx !== index);
    persistSummarySections(nextEntries);
  };

  return (
    <MagicTeaPartySummaryBody active={Boolean(activeSession)} summary={currentDraft.text} updatedAt={summaryUpdatedAt}
      disabled={disableActions || isSaving} editingDisabled={disableSummaryEditing} isSummarizing={isSummarizing} hasMessages={hasMessages}
      error={summaryError} description="用于长对话压缩（仅保存在本地浏览器）。生成摘要会消耗额外 Token。后续剧情最多读取摘要前 10000 字，保存正文不截断。编辑后请点击“保存摘要”；未保存草稿可在本页切换会话后继续编辑。"
      autoSummaryEnabled={activeSession?.settings.autoSummaryEnabled === true} onAutoSummaryEnabledChange={onAutoSummaryEnabledChange}
      onSave={() => void saveDraft()} dirty={currentDraft.dirty && !isSaving}
      collapsed={collapsed} onCollapsedChange={setCollapsed} onStopSummary={onStopSummary} onGenerate={() => void replaceDraft(onGenerateSummary)} onClear={() => void replaceDraft(onClearSummary)}
      collapsedDetails={<> · 分段 {sectionEntries.length} · 更新草案 {updateDrafts?.length ?? 0}{updateError ? <div className="text-xs text-red-600">更新错误：{updateError}</div> : null}</>}
      renderError={message => <ErrorMessage message={message} className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" linkClassName="text-red-700 underline underline-offset-2 hover:opacity-95" />}
      onChange={value => {
        if (!activeSession) return;
        onSummaryIntent();
        setDraft({ ...currentDraft, text: value, dirty: true });
      }}>
          {currentDraft.dirty ? <div className="text-xs text-amber-700">有未保存的摘要草稿。生成或清空成功后会替换草稿；失败时保留。</div> : null}
          <div className="rounded-lg border border-pink-100 bg-pink-50/60 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-pink-800">结构化摘要</div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disableSummaryEditing}
                  onClick={handleAddSection}
                >
                  新增小节
                </button>
                {hasSections ? (
                  <button
                    type="button"
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={disableSummaryEditing}
                    onClick={() => persistSummarySections([])}
                  >
                    清空分段
                  </button>
                ) : null}
              </div>
            </div>
            <div className="text-[11px] text-gray-500">用于侧信道结构化摘要；编辑正文不会自动同步分段。</div>
            {hasSections ? (
              <div className="space-y-2">
                {sectionEntries.map(([title, text], index) => (
                  <div key={`section-${index}`} className="rounded-md border border-pink-100 bg-white p-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="input-field !h-8 flex-1 text-xs"
                        value={title}
                        onChange={(event) => handleUpdateSection(index, event.target.value)}
                        placeholder="小节标题"
                        disabled={disableSummaryEditing}
                      />
                      <button
                        type="button"
                        className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={disableSummaryEditing}
                        onClick={() => handleRemoveSection(index)}
                      >
                        删除
                      </button>
                    </div>
                    <textarea
                      className="input-field h-20 resize-y text-xs"
                      value={text}
                      onChange={(event) => handleUpdateSection(index, undefined, event.target.value)}
                      placeholder="填写小节内容"
                      disabled={disableSummaryEditing}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-500">暂无分段摘要，可点击“新增小节”。</div>
            )}
          </div>

          <div className="rounded-lg border border-pink-100 bg-pink-50/60 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-pink-800">角色更新</div>
              {isGeneratingUpdates || isApplyingUpdates ? (
                <div className="flex items-center gap-2 text-xs font-semibold text-pink-700">
                  <InlineSpinner />
                  <span>{isApplyingUpdates ? '写入中…' : '草案生成中…'}</span>
                </div>
              ) : null}
            </div>

            <div className="text-xs text-gray-600">基于对话历史生成更新草案。茶会写入会移除签名并标记为非原生。</div>
            <div className="text-[11px] text-gray-500">当前策略：{updateApplyMode === 'auto' ? '自动写入' : updateApplyMode === 'confirm' ? '确认写入' : '仅草案'}。</div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="text-xs font-semibold text-gray-600">对话范围</label>
              <select
                className="input-field !h-8 !py-1 text-xs"
                value={String(updateRangeSize)}
                onChange={(event) => onUpdateRangeSizeChange(Number(event.target.value))}
                disabled={disableActions}
              >
                <option value="10">最近 10 轮</option>
                <option value="20">最近 20 轮</option>
                <option value="40">最近 40 轮</option>
                <option value="80">最近 80 轮</option>
              </select>
            </div>

            {!hasWriteEnabled ? (
              <div className="text-xs text-red-600">请先在“资料读写”中开启写入历战记录或当前状态。</div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-700 hover:bg-pink-50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canGenerate || !hasWriteEnabled || isGeneratingUpdates || isApplyingUpdates}
                onClick={onGenerateUpdates}
              >
                生成更新草案
              </button>
              <button
                type="button"
                className="rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!hasDrafts || disableActions || isGeneratingUpdates || isApplyingUpdates}
                onClick={onApplyUpdates}
              >
                确认写入
              </button>
              {hasDrafts ? (
                <button
                  type="button"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disableActions || isGeneratingUpdates || isApplyingUpdates}
                  onClick={onClearUpdateDrafts}
                >
                  清空草案
                </button>
              ) : null}
              {canRollback ? (
                <button
                  type="button"
                  className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disableActions || isGeneratingUpdates || isApplyingUpdates}
                  onClick={onRollbackUpdates}
                >
                  撤销上次自动写入
                </button>
              ) : null}
            </div>
            {updateSnapshot ? (
              <div className="text-[11px] text-gray-500">
                自动写入时间：{new Date(updateSnapshot.createdAt).toLocaleString()}
                {updateSnapshot.revertedAt ? `（已于 ${new Date(updateSnapshot.revertedAt).toLocaleString()} 撤销）` : ''}
              </div>
            ) : null}

            {updateError ? (
              <ErrorMessage
                message={updateError}
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                linkClassName="text-red-700 underline underline-offset-2 hover:opacity-95"
              />
            ) : null}

            {hasDrafts ? (
              <div className="space-y-2 text-xs text-gray-700">
                {updateDrafts?.map((draft) => (
                  <div key={draft.roleId ?? draft.characterName} className="rounded-md border border-pink-100 bg-white px-3 py-2">
                    <div className="font-semibold text-gray-800">{draft.characterName}</div>
                    {draft.impact ? <div className="mt-1 text-gray-600">历战影响：{draft.impact}</div> : null}
                    {draft.currentStateSummary ? (
                      <div className="mt-1 text-gray-600">状态摘要：{draft.currentStateSummary}</div>
                    ) : null}
                    {!draft.impact && !draft.currentStateSummary ? (
                      <div className="mt-1 text-gray-500">无可写入更新（可能因协议冲突而跳过）。</div>
                    ) : null}
                    {draft.impact || draft.currentStateSummary ? (
                      <div className="mt-1 text-gray-500">胜者：{draft.winner || '不适用'}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-500">暂无更新草案。</div>
            )}
          </div>
    </MagicTeaPartySummaryBody>
  );
}
