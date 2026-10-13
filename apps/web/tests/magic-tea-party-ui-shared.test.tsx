import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MagicTeaPartyMessage, MagicTeaPartyPreferences, MagicTeaPartySession, MagicTeaPartyTachieAsset } from '@mahoshojo/domain/magic-tea-party/types';
import * as shared from '@mahoshojo/ui-web/magic-tea-party';
import { MagicTeaPartyChatComposer } from '@/components/magic-tea-party/ChatComposer';
import { MagicTeaPartyChatMessage } from '@/components/magic-tea-party/ChatMessage';
import { MagicTeaPartyChatTimeline } from '@/components/magic-tea-party/ChatTimeline';
import { MagicTeaPartyHero } from '@/components/magic-tea-party/Hero';
import { MagicTeaPartyNoticePanel } from '@/components/magic-tea-party/NoticePanel';
import { MagicTeaPartySessionSetupPanel } from '@/components/magic-tea-party/SessionSetupPanel';
import { MagicTeaPartySessionSidebar } from '@/components/magic-tea-party/SessionSidebar';
import { MagicTeaPartyPage } from '@/components/magic-tea-party/MagicTeaPartyPage';
import { useChatAutoScroll } from '@/components/magic-tea-party/useChatAutoScroll';

const ports = vi.hoisted(() => ({ sessions: vi.fn(), chat: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/magic-tea-party/useMagicTeaPartySessions', () => ({ useMagicTeaPartySessions: ports.sessions }));
vi.mock('@/lib/magic-tea-party/useMagicTeaPartyChat', () => ({ useMagicTeaPartyChat: ports.chat }));
vi.mock('@/lib/useAuth', () => ({ useAuth: () => ({ user: { id: 1, username: 'synthetic' }, isAuthenticated: true, loading: false }) }));
vi.mock('@/lib/app-router-adapter', () => ({ useAppRouterAdapter: () => ({ push: ports.push }) }));
vi.mock('@/lib/use-generation-api-intent-latch', () => ({ useGenerationApiIntentLatch: () => ({}) }));
// Only host-only network/storage/popup surfaces are stubbed. Every migrated view below is real.
vi.mock('@/components/AiProviderSelector', () => ({ default: () => <div data-host="provider">Web Provider</div> }));
vi.mock('@/components/magic-tea-party/CardModals', () => ({ MagicTeaPartyCardModals: () => <div data-host="cards">选卡宿主</div> }));
vi.mock('@/components/magic-tea-party/PresetCharacterPanel', () => ({ MagicTeaPartyPresetCharacterPanel: () => <div data-host="preset-roles" /> }));
vi.mock('@/components/magic-tea-party/PresetScenarioPanel', () => ({ MagicTeaPartyPresetScenarioPanel: () => <div data-host="preset-scenes" /> }));
vi.mock('@/components/magic-tea-party/CharacterPanel', () => ({ MagicTeaPartyCharacterPanel: () => <div data-host="role-library" /> }));
vi.mock('@/components/magic-tea-party/TachiePanel', () => ({ MagicTeaPartyTachiePanel: () => <div data-host="tachie">插画宿主</div> }));
vi.mock('@/components/magic-tea-party/HistoryImageExportPanel', () => ({ MagicTeaPartyHistoryImageExportPanel: () => <div data-host="image-export">长图宿主</div> }));

const preferences: MagicTeaPartyPreferences = {
  outputFormat: 'jsonl', outputPlan: { choices: 'auto', summary: 'off', updates: 'auto' },
  enableChoices: true, choiceCount: 4, language: 'zh-CN', userDisplayName: '旅人',
  enableSummary: true, updateApplyMode: 'auto', readArenaHistory: true, readArenaHistoryLimit: 3,
  isArenaHistoryUnlimited: false, readCurrentState: true, writeArenaHistory: false, writeCurrentState: false,
  tachieCacheMaxPerSession: 10, tachieCacheMaxGlobal: 20, tachieCacheMaxBytes: 1024,
  presetCharacterPanelCollapsed: true, presetScenarioPanelCollapsed: true, sessionRetentionDays: 60, maxSessions: 200,
};
const session: MagicTeaPartySession = {
  id: 'session-1', title: '有角色的茶会', createdAt: 1, updatedAt: 2, roles: [{ id: 'role-1', name: '星见澪', source: 'local', card: { name: '星见澪' } }],
  scenario: { id: 'scene', title: '雨夜', source: 'local', card: { content: '窗外的雨夜' } },
  settings: { providerId: 'synthetic', modelId: 'synthetic', outputFormat: 'jsonl' },
};
const message: MagicTeaPartyMessage = { id: 'message-1', sessionId: session.id, role: 'assistant', content: '原始正文', status: 'done', createdAt: 3,
  segments: [{ type: 'narration', text: '窗外落雨' }, { type: 'dialogue', speakerId: 'role-1', text: '喝杯茶吧' }], choices: [{ id: 'one', text: '坐下' }] };
const asset: MagicTeaPartyTachieAsset = { id: 'asset-1', sessionId: session.id, anchorMessageId: message.id,
  cacheKey: 'synthetic', fragmentHash: 'synthetic', styleId: 'synthetic', createdAt: 1, lastUsedAt: 1,
  imageUrl: 'https://fixture.invalid/tea.png', roleId: 'role-1' };
const noop = () => {};
const setupProps = { activeSession: session, playerOptions: [{ value: '', label: '旁观者' }], onOpenRoleModal: noop,
  onOpenScenarioModal: noop, onUploadRoles: noop, onUploadScenarios: noop, onUpdateRoles: noop,
  onUpdateScenarios: noop, onUpdatePlayerRole: noop, onUpdateTitle: noop, onLockTitle: noop,
  onImportRolesText: noop, onImportScenariosText: noop, onDropRoles: noop, onDropScenarios: noop };

describe('Web Tea actual shared composition', () => {
  it('keeps the original hook and all migrated Web entrypoints wired to the public shared module', () => {
    expect(useChatAutoScroll).toBe(shared.useChatAutoScroll);
    for (const name of ['ChatMessage', 'ChatTimeline', 'ChatComposer', 'SessionSetupPanel', 'Hero', 'NoticePanel', 'SessionSidebar', 'ImportExportPanel', 'MagicTeaPartyPage']) {
      const source = readFileSync(new URL(`../components/magic-tea-party/${name}.tsx`, import.meta.url), 'utf8');
      expect(source, name).toContain("from '@mahoshojo/ui-web/magic-tea-party'");
    }
  });

  it('keeps Web file formats, titles, action copy and original hero/error navigation', () => {
    const markup = renderToStaticMarkup(<>
      <MagicTeaPartyHero globalError="合成错误" />
      <MagicTeaPartySessionSetupPanel {...setupProps} />
      <MagicTeaPartyChatComposer activeSession={{ ...session, settings: { ...session.settings, outputFormat: 'markdown' } }} preferences={preferences}
        draft="长正文" onDraftChange={noop} onSend={noop} onContinue={noop} onGenerateChoices={noop} isGenerating={false} hasMessages messageCharLimit={1} />
      <MagicTeaPartyNoticePanel notices={[{ type: 'notice', level: 'error', message: '合成错误' }]} />
    </>);
    expect(markup).toContain('聊天记录保存在本地浏览器'); expect(markup).toContain('href="/"');
    expect(markup).toContain('accept=".json,.png"'); expect(markup).toContain('支持 SillyTavern PNG/JSON');
    expect(markup).toContain('浏览在线角色库'); expect(markup).toContain('浏览在线情景库');
    expect(markup).toContain('额外调用生成选项/摘要/更新'); expect(markup).toContain('自动保留首尾并省略中段');
    expect(markup).toContain('生成选项'); expect(markup).toContain('合成错误');
  });

  it('retains real Web attachment, Markdown and blocked/error adapters through the shared timeline', () => {
    const props = { activeSession: session, preferences, messages: [message], isGenerating: false,
      outputView: 'rendered' as const, onOutputViewChange: noop, tachieAssets: [asset], onSelectChoice: noop };
    const markup = renderToStaticMarkup(<MagicTeaPartyChatTimeline {...props} />);
    expect(markup).toContain('窗外落雨'); expect(markup).toContain('星见澪'); expect(markup).toContain('喝杯茶吧');
    expect(markup).toContain('src="https://fixture.invalid/tea.png"'); expect(markup).toContain('角色立绘');
    const blocked = renderToStaticMarkup(<MagicTeaPartyChatMessage message={{ ...message, status: 'blocked' }} session={session} preferences={preferences} isGenerating={false} onRegenerate={noop} />);
    expect(blocked).toContain('/encyclopedia/sensitive-words');
    const markdown = renderToStaticMarkup(<MagicTeaPartyChatMessage message={{ ...message, segments: undefined, content: '**真实 Markdown**' }} session={{ ...session, settings: { ...session.settings, outputFormat: 'markdown' } }} preferences={preferences} isGenerating={false} />);
    expect(markdown).toContain('<strong>真实 Markdown</strong>');
    const error = renderToStaticMarkup(<MagicTeaPartyChatMessage message={{ ...message, status: 'error', error: { code: '429', message: '请求过于频繁' }, meta: { kind: 'continue' } }} session={session} preferences={preferences} isGenerating={false} />);
    expect(error).toContain('继续生成失败'); expect(error).toContain('HTTP：429');
  });

  it('retains Sidebar advanced actions and host-only panels while reusing actual shared list/preferences', () => {
    const child = { ...session, id: 'child', forkedFrom: { sessionId: session.id, messageId: message.id, createdAt: 4 }, pinnedAt: 5 };
    const markup = renderToStaticMarkup(<MagicTeaPartySessionSidebar sessions={[session, child]} activeSessionId={child.id} activeSession={child}
      preferences={preferences} onCreateSession={noop} onSelectSession={noop} onDeleteSession={noop} onToggleSessionPin={noop}
      onReorderPinnedSessions={noop} onSessionImported={noop} onPresetSelected={noop} onProviderConfigChange={noop}
      onPreferenceChange={noop} onSessionSettingChange={noop} onMergeSession={noop} onCleanupSessions={async () => {}} />);
    for (const text of ['取消置顶', '返回原会话', '合并到原会话', '分支链', '合并输出计划', '更新草案', '资料读写', 'Web Provider', 'ZIP 导出会包含本地图片资源']) expect(markup).toContain(text);
  });

  it('renders the actual nonempty Web page using the shared columns, setup, timeline and composer', () => {
    ports.sessions.mockReturnValue({ sessions: [session], activeSessionId: session.id, activeSession: session, messages: [message], preferences,
      setActiveSessionId: noop, setMessages: noop, applyPreferencePatch: noop, persistSession: async () => {}, createSession: async () => {},
      deleteSession: async () => {}, bulkDeleteSessions: async () => {}, toggleSessionPin: async () => {}, reorderPinnedSessions: async () => {},
      handleSessionImported: noop, applyPreset: noop, updateActiveSessionSettings: noop, updateActiveSessionRoles: noop, updateActiveSessionScenarios: noop,
      onToggleRoleCard: noop, onToggleScenarioCard: noop, onUploadRoles: noop, onUploadScenarios: noop, onImportRolesText: noop,
      onImportScenariosText: noop, onDropRoles: noop, onDropScenarios: noop, selectedRoleCardIds: [], selectedScenarioCardIds: [],
      playerOptions: [{ value: '', label: '旁观者' }], updateSessionTitle: noop, lockSessionTitle: noop, updatePlayerRole: noop,
      forkSessionFromMessage: noop, mergeSessionToParent: noop });
    ports.chat.mockReturnValue({ isGenerating: false, isSummarizing: false, summaryError: null, stopGenerating: noop,
      sendMessage: async () => true, continueGeneration: noop, generateChoices: noop, regenerateMessage: noop,
      deleteMessage: noop, compactMessageContent: noop, getMessageCharLimit: () => 8000, generateSummary: noop, clearSummary: noop });
    const markup = renderToStaticMarkup(<MagicTeaPartyPage />);
    expect(markup).toContain('container !max-w-[1200px]'); expect(markup).toContain('lg:grid-cols-[320px_minmax(0,1fr)]');
    for (const text of ['会话列表', '会话设置', '星见澪', '窗外落雨', '喝杯茶吧', '继续生成', '生成选项', '发送', '合并输出计划', 'Token 预算提示', '长图宿主', '插画宿主', '选卡宿主']) expect(markup).toContain(text);
    expect(ports.push).not.toHaveBeenCalled();
  });
});
