import { useEffect, useState } from 'react';
import { MagicTeaPartySessionList, MagicTeaPartyOutputPreferencesPanel, MagicTeaPartyPresetPicker, useSessionSidebarPreference } from '@mahoshojo/ui-web/magic-tea-party';

import AiProviderSelector, { type UserAIProviderConfig } from '@/components/AiProviderSelector';
import { MagicTeaPartyBranchChainModal } from '@/components/magic-tea-party/BranchChainModal';
import { MagicTeaPartySessionCleanupPanel } from '@/components/magic-tea-party/SessionCleanupPanel';
import { MagicTeaPartyGlobalSettingsPanel } from '@/components/magic-tea-party/GlobalSettingsPanel';
import { MagicTeaPartyImportExportPanel } from '@/components/magic-tea-party/ImportExportPanel';

import { projectMagicTeaPartyPreset, type MagicTeaPartyPresetId, type MagicTeaPartyPresetProjection } from '@mahoshojo/ai-core/magic-tea-party';
import type {
  MagicTeaPartyPreferences,
  MagicTeaPartySession,
} from '@/lib/magic-tea-party/types';

type MagicTeaPartySidebarProps = {
  sessions: MagicTeaPartySession[];
  activeSessionId: string | null;
  activeSession: MagicTeaPartySession | null;
  preferences: MagicTeaPartyPreferences;
  onCreateSession: (presetId?: MagicTeaPartyPresetId | null) => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onToggleSessionPin: (sessionId: string) => void;
  onReorderPinnedSessions: (orderedIds: string[]) => void;
  onSessionImported: (sessionId: string) => void;
  onPresetSelected: (presetId: MagicTeaPartyPresetId) => void;
  onProviderConfigChange: (config: UserAIProviderConfig | null) => void;
  onPreferenceChange: (patch: Partial<MagicTeaPartyPreferences>) => void;
  onSessionSettingChange: (patch: Partial<MagicTeaPartySession['settings']>) => void;
  onMergeSession: (sessionId?: string | null) => void;
  onCleanupSessions: (sessionIds: string[]) => Promise<void>;
};

export function MagicTeaPartySessionSidebar(props: MagicTeaPartySidebarProps) {
  const {
    sessions,
    activeSessionId,
    activeSession,
    preferences,
    onCreateSession,
    onSelectSession,
    onDeleteSession,
    onToggleSessionPin,
    onReorderPinnedSessions,
    onSessionImported,
    onPresetSelected,
    onProviderConfigChange,
    onPreferenceChange,
    onSessionSettingChange,
    onMergeSession,
    onCleanupSessions,
  } = props;
  const [showBranchModal, setShowBranchModal] = useState(false);
  const [presetPreview, setPresetPreview] = useState<{ source: MagicTeaPartySession; projection: MagicTeaPartyPresetProjection } | null>(null);
  // A changed session invalidates its confirmation, including a switch away and back.
  const currentPreview = presetPreview?.source === activeSession ? presetPreview.projection : null;
  useEffect(() => { setPresetPreview(null); }, [activeSession]);
  const { pinnedCollapsed, setPinnedCollapsed, recentCollapsed, setRecentCollapsed } = useSessionSidebarPreference();

  const selectedPresetId = activeSession ? activeSession.settings.presetId : preferences.lastPresetId;
  const readArenaHistory = activeSession?.settings.readArenaHistory ?? preferences.readArenaHistory;
  const readArenaHistoryLimit = activeSession?.settings.readArenaHistoryLimit ?? preferences.readArenaHistoryLimit;
  const isArenaHistoryUnlimited = activeSession?.settings.isArenaHistoryUnlimited ?? preferences.isArenaHistoryUnlimited;
  const readCurrentState = activeSession?.settings.readCurrentState ?? preferences.readCurrentState;
  const writeArenaHistory = activeSession?.settings.writeArenaHistory ?? preferences.writeArenaHistory;
  const writeCurrentState = activeSession?.settings.writeCurrentState ?? preferences.writeCurrentState;
  const updateApplyMode = activeSession?.settings.updateApplyMode ?? preferences.updateApplyMode;
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const branchChain: MagicTeaPartySession[] = [];
  if (activeSession?.forkedFrom?.sessionId) {
    let cursor: MagicTeaPartySession | undefined = activeSession;
    while (cursor?.forkedFrom?.sessionId) {
      const parent = sessionMap.get(cursor.forkedFrom.sessionId);
      if (!parent) break;
      branchChain.push(parent);
      cursor = parent;
    }
  }
  const branchTrail = branchChain.slice().reverse();
  const hasParent = Boolean(activeSession?.forkedFrom?.sessionId);
  const hasChildren = sessions.some((session) => session.forkedFrom?.sessionId === activeSession?.id);
  const activeTitle = activeSession?.title ?? '当前会话';

  return (
    <aside className="space-y-4 min-w-0">
      <MagicTeaPartySessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onCreateSession={() => onCreateSession(preferences.lastPresetId as MagicTeaPartyPresetId)}
        onSelectSession={onSelectSession}
        onDeleteSession={onDeleteSession}
        onToggleSessionPin={onToggleSessionPin}
        onReorderPinnedSessions={onReorderPinnedSessions}
        onMergeSession={onMergeSession}
        onReturnToParent={onSelectSession}
        pinnedCollapsed={pinnedCollapsed}
        recentCollapsed={recentCollapsed}
        onPinnedCollapsedChange={setPinnedCollapsed}
        onRecentCollapsedChange={setRecentCollapsed}
      >
        {hasParent && branchTrail.length > 0 ? (
          <div className="mt-3 rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2 text-xs text-gray-600">
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-pink-800">
              <span>分支链</span>
              <button
                type="button"
                className="text-[11px] text-pink-700 hover:underline"
                onClick={() => setShowBranchModal(true)}
              >
                查看全部
              </button>
            </div>
            <div className="mt-1 space-y-1">
              {branchTrail.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="block text-left text-xs text-gray-600 hover:underline"
                  onClick={() => onSelectSession(session.id)}
                >
                  {session.title}
                </button>
              ))}
              <div className="text-xs text-pink-700">当前：{activeTitle}</div>
            </div>
          </div>
        ) : null}

        {activeSession && !hasParent && hasChildren ? (
          <div className="mt-3 rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2 text-xs text-gray-600">
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-pink-800">
              <span>分支链</span>
              <button
                type="button"
                className="text-[11px] text-pink-700 hover:underline"
                onClick={() => setShowBranchModal(true)}
              >
                查看全部
              </button>
            </div>
            <div className="mt-1 text-[11px] text-gray-600">当前会话已有子分支，可在弹窗中快速跳转。</div>
          </div>
        ) : null}

        {activeSession && hasParent && branchTrail.length === 0 ? (
          <div className="mt-3 rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2 text-xs text-gray-600">
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-pink-800">
              <span>分支链</span>
              <button
                type="button"
                className="text-[11px] text-pink-700 hover:underline"
                onClick={() => setShowBranchModal(true)}
              >
                查看全部
              </button>
            </div>
            <div className="mt-1 text-[11px] text-gray-600">父会话已不存在，但仍可查看子分支列表。</div>
          </div>
        ) : null}
      </MagicTeaPartySessionList>

      <MagicTeaPartyImportExportPanel activeSession={activeSession} preferences={preferences} onSessionImported={onSessionImported} />

      <MagicTeaPartyPresetPicker
        selectedPresetId={selectedPresetId}
        onCreateSession={(presetId) => { setPresetPreview(null); onCreateSession(presetId); }}
        onSelectPreset={activeSession ? (presetId) => {
          const projection = projectMagicTeaPartyPreset(activeSession, presetId);
          setPresetPreview(projection ? { source: activeSession, projection } : null);
        } : undefined}
        preview={currentPreview}
        onConfirmPreset={() => {
          if (!currentPreview) return;
          setPresetPreview(null);
          onPresetSelected(currentPreview.preset.id);
        }}
        onCancelPreset={() => setPresetPreview(null)}
      />

      <div className="rounded-xl border border-pink-100 bg-white p-4">
        <AiProviderSelector
          onConfigChange={onProviderConfigChange}
          storageNamespace="magic-tea-party.customProvider"
          allowSystemProvider={false}
          label="自备 API Key（必填）"
        />
      </div>

      <MagicTeaPartyOutputPreferencesPanel
        activeSession={activeSession}
        preferences={preferences}
        outputPlanSupported
        choicesHint="Markdown 模式需配合“选项=强制”才会自动补生成"
        onChange={(patch) => {
          onPreferenceChange(patch);
          onSessionSettingChange(patch);
        }}
      />

      <div className="rounded-xl border border-pink-100 bg-white p-4 space-y-3">
        <div className="text-sm font-semibold text-gray-800">资料读写</div>
        <div className="text-xs text-gray-500">茶会写入会移除签名并标记为非原生。</div>

        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">读取</div>
          <label className="flex items-center justify-between gap-3 text-xs text-gray-700">
            <span>读取历战记录</span>
            <input
              type="checkbox"
              checked={Boolean(readArenaHistory)}
              onChange={(event) => {
                const value = Boolean(event.target.checked);
                onPreferenceChange({ readArenaHistory: value });
                onSessionSettingChange({ readArenaHistory: value });
              }}
            />
          </label>

          {readArenaHistory ? (
            <div className="grid gap-2 rounded-lg border border-pink-100 bg-pink-50/60 px-3 py-2 text-xs text-gray-600">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-gray-600">读取条数</label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  className="input-field !h-8 !w-20 !px-2 !py-1 text-xs"
                  value={String(readArenaHistoryLimit || 3)}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    const limit = Number.isFinite(nextValue) ? Math.max(1, Math.min(999, Math.floor(nextValue))) : 3;
                    onPreferenceChange({ readArenaHistoryLimit: limit });
                    onSessionSettingChange({ readArenaHistoryLimit: limit });
                  }}
                  disabled={isArenaHistoryUnlimited}
                />
              </div>
              <label className="flex items-center justify-between gap-2">
                <span>不限条数</span>
                <input
                  type="checkbox"
                  checked={Boolean(isArenaHistoryUnlimited)}
                  onChange={(event) => {
                    const value = Boolean(event.target.checked);
                    onPreferenceChange({ isArenaHistoryUnlimited: value });
                    onSessionSettingChange({ isArenaHistoryUnlimited: value });
                  }}
                />
              </label>
            </div>
          ) : null}

          <label className="flex items-center justify-between gap-3 text-xs text-gray-700">
            <span>读取当前状态</span>
            <input
              type="checkbox"
              checked={Boolean(readCurrentState)}
              onChange={(event) => {
                const value = Boolean(event.target.checked);
                onPreferenceChange({ readCurrentState: value });
                onSessionSettingChange({ readCurrentState: value });
              }}
            />
          </label>
        </div>

        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">写入</div>
          <label className="flex items-center justify-between gap-3 text-xs text-gray-700">
            <span>写入历战记录</span>
            <input
              type="checkbox"
              checked={Boolean(writeArenaHistory)}
              onChange={(event) => {
                const value = Boolean(event.target.checked);
                onPreferenceChange({ writeArenaHistory: value });
                onSessionSettingChange({ writeArenaHistory: value });
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-xs text-gray-700">
            <span>写入当前状态</span>
            <input
              type="checkbox"
              checked={Boolean(writeCurrentState)}
              onChange={(event) => {
                const value = Boolean(event.target.checked);
                onPreferenceChange({ writeCurrentState: value });
                onSessionSettingChange({ writeCurrentState: value });
              }}
            />
          </label>

          <div className="grid gap-1">
            <label className="text-xs font-semibold text-gray-600">写入策略</label>
            <select
              className="input-field"
              value={updateApplyMode}
              onChange={(event) => {
                const value = event.target.value as 'auto' | 'confirm' | 'draft';
                onPreferenceChange({ updateApplyMode: value });
                onSessionSettingChange({ updateApplyMode: value });
              }}
            >
              <option value="auto">自动写入</option>
              <option value="confirm">确认写入</option>
              <option value="draft">仅草案</option>
            </select>
            <div className="text-[11px] text-gray-500">自动写入会生成可回滚快照。</div>
          </div>
        </div>
      </div>

      <MagicTeaPartyGlobalSettingsPanel
        preferences={preferences}
        activeSession={activeSession}
        onPreferenceChange={onPreferenceChange}
        onSessionSettingChange={onSessionSettingChange}
      />

      <MagicTeaPartySessionCleanupPanel
        preferences={preferences}
        activeSessionId={activeSession?.id ?? null}
        onPreferenceChange={onPreferenceChange}
        onCleanupSessions={onCleanupSessions}
      />

      <MagicTeaPartyBranchChainModal
        isOpen={showBranchModal}
        sessions={sessions}
        activeSession={activeSession}
        onSelectSession={onSelectSession}
        onClose={() => setShowBranchModal(false)}
      />
    </aside>
  );
}
