import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { invoke } from '@tauri-apps/api/core';
import { CardLibraryModal, type CardLibrarySelectionContext } from '@mahoshojo/ui-web/card-library';
import { MarkdownBlock } from '@mahoshojo/ui-web/markdown';
import {
  MagicTeaPartyPageView, MagicTeaPartyHero, MagicTeaPartySessionList, MagicTeaPartySessionSetupPanel,
  MagicTeaPartyOutputPreferencesPanel, MagicTeaPartyTransferPanel, MagicTeaPartyChatTimeline,
  MagicTeaPartyChatComposer, MagicTeaPartyChatMessage,
} from '@mahoshojo/ui-web/magic-tea-party';
import { DesktopTeaSession } from '../features/magic-tea-party/session';
import { TEA_PREFERENCES, teaMessageView, teaSessionView } from '../features/magic-tea-party/direct';
import { parseDesktopTeaRoles, parseDesktopTeaScenarios } from '../features/magic-tea-party/source';
import { createIpcTeaNativePort } from '../platform/magic-tea-party-native';
import { downloadTextFile } from '../platform/download-text-file';
import { useDesktopCardLibraryHost } from '../platform/card-library-host';
import { useDesktopAiConfig } from '../features/ai-config/use-desktop-ai-config';
import { DesktopAiProviderPanel } from '../features/ai-config/desktop-ai-provider-panel';
import { useExternalLinks } from '../features/external-links/external-links-provider';
import { useLeaveGuard } from './useLeaveGuard';

export default function MagicTeaPartyPage() {
  const [owner] = useState(() => new DesktopTeaSession(createIpcTeaNativePort()));
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const { store: aiStore } = useDesktopAiConfig();
  const libraryHost = useDesktopCardLibraryHost(); const { openContent } = useExternalLinks();
  const [library, setLibrary] = useState<'character' | 'scenario' | null>(null);
  const [outputView, setOutputView] = useState<'raw' | 'rendered'>('rendered');
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false); const [recentCollapsed, setRecentCollapsed] = useState(false);
  const [importBusy, setImportBusy] = useState(false); const importRunning = useRef(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const preparing = useRef(false); const [preparingView, setPreparingView] = useState(false); const pasteDirty = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; incarnation: number; instance: string; revision: number } | null>(null);
  const mounted = useRef(true);
  const guard = useLeaveGuard(() => owner.isBusy() || importRunning.current || providerDirty || preparing.current || pasteDirty.current,
    '茶会仍有生成、未保存输入或待核对保存，请先停止并保存，或明确放弃易失结果后离开');
  useEffect(() => {
    mounted.current = true; owner.activate(); void owner.refreshDirectory();
    return () => { mounted.current = false; owner.dispose(); aiStore.cancelPreparingGeneration(); };
  }, [owner, aiStore]);
  const session = state.record ? teaSessionView({ ...state.record.session, ...(state.titleDraft === null ? {} : { title: state.titleDraft }),
    settings: { ...state.record.session.settings, ...(state.nameDraft === null ? {} : { userDisplayName: state.nameDraft }) } }) : null;
  const disabled = !guard.ready || state.busy || state.pending !== 'none' || importBusy || preparingView;
  const run = (work: () => Promise<unknown>) => { void work().catch(error => owner.report(error)); };
  const renderScope = `${state.incarnation}:${state.record?.session.id ?? ''}`;
  const currentScope = () => `${owner.getSnapshot().incarnation}:${owner.getSnapshot().record?.session.id ?? ''}`;
  const importCards = async (text: string, kind: 'character' | 'scenario'): Promise<boolean> => {
    if (disabled || preparing.current || !session || currentScope() !== renderScope) return false;
    try {
      if (kind === 'character') return await owner.update({ roles: [...session.roles, ...parseDesktopTeaRoles(text, () => crypto.randomUUID())] });
      const scenarios = parseDesktopTeaScenarios(text, () => crypto.randomUUID());
      return await owner.update(session.scenario ? { auxScenarios: [...(session.auxScenarios ?? []), ...scenarios] }
        : { scenario: scenarios[0], auxScenarios: [...(session.auxScenarios ?? []), ...scenarios.slice(1)] });
    } catch (error) { owner.report(error); return false; }
  };
  const importFiles = async (files: File[], kind: 'character' | 'scenario') => {
    if (disabled || importRunning.current || !session) return;
    const scope = currentScope(); importRunning.current = true; setImportBusy(true);
    try {
      const values: unknown[] = [];
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.json') || file.size > 4 * 1024 * 1024) throw new Error('此阶段只导入 4 MiB 内的角色或情景 JSON，原文件保持不变');
        const value: unknown = JSON.parse(await file.text());
        if (!mounted.current || currentScope() !== scope) return;
        if (Array.isArray(value)) values.push(...value); else values.push(value);
      }
      if (mounted.current && currentScope() === scope) await importCards(JSON.stringify(values), kind);
    } catch (error) { if (mounted.current && currentScope() === scope) owner.report(error); }
    finally { importRunning.current = false; if (mounted.current) setImportBusy(false); }
  };
  const chooseCard = (_value: unknown, context: CardLibrarySelectionContext) => {
    if (disabled || !library || !context.rawSourceData) return;
    const kind = library; setLibrary(null); run(() => importCards(JSON.stringify(context.rawSourceData), kind));
  };
  const importArchive = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || disabled || importRunning.current) return;
    const scope = currentScope(); importRunning.current = true; setImportBusy(true);
    run(async () => {
      try {
        if (!/\.(json|jsonl)$/iu.test(file.name) || file.size > 64 * 1024 * 1024) throw new Error('请选择 64 MiB 内的 JSON / JSONL；ZIP 和媒体归档暂不支持');
        const text = await file.text();
        if (mounted.current && currentScope() === scope) await owner.importText(text, file.name.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'json', warnings => window.confirm(`${warnings.join('\n')}\n仍按这些已说明的边界导入？`));
      } finally { importRunning.current = false; if (mounted.current) setImportBusy(false); }
    });
  };
  const exportArchive = (format: 'json' | 'jsonl' | 'archive') => run(async () => {
    const text = await owner.export(format);
    if (mounted.current) downloadTextFile(format === 'archive' ? 'magic-tea-party.archive.json' : `magic-tea-party.${format}`, text, format === 'jsonl' ? 'application/x-ndjson' : 'application/json');
  });
  const start = (continueStory = false) => {
    if (disabled || preparing.current) return;
    const scope = currentScope(); const intent = owner.getSnapshot();
    preparing.current = true; setPreparingView(true);
    run(async () => { try { await aiStore.withPreparedGeneration(async target => {
      const now = owner.getSnapshot();
      if (!mounted.current || currentScope() !== scope || now.record !== intent.record || now.input !== intent.input || now.titleDraft !== intent.titleDraft || now.nameDraft !== intent.nameDraft) return;
      const snapshot = aiStore.getSnapshot();
      const credentialIntent = snapshot.credentialDraftRevision;
      const selection = snapshot.selection; const profiles = snapshot.profiles;
      await owner.start(target, { invoke, profileId: target.profile?.id ?? '', providerTarget: target.providerTarget }, () => mounted.current && currentScope() === scope
        && aiStore.getSnapshot().credentialDraftRevision === credentialIntent && aiStore.getSnapshot().selection === selection
        && aiStore.getSnapshot().profiles === profiles, continueStory);
    }); } finally { preparing.current = false; if (mounted.current) setPreparingView(false); } });
  };
  const deleteActive = (id: string) => {
    if (disabled) return;
    if (state.record?.session.id !== id) { owner.report(new Error('请先打开要删除的会话，再确认删除')); return; }
    const incarnation = state.incarnation;
    run(async () => {
      if (!await owner.saveDraft()) return;
      const current = owner.getSnapshot();
      if (!mounted.current || current.incarnation !== incarnation || current.record?.session.id !== id || owner.isBusy()) return;
      setConfirmDelete({ id, incarnation, instance: current.record.instance, revision: current.record.revision });
    });
  };
  const confirmed = confirmDelete && confirmDelete.id === state.record?.session.id && confirmDelete.incarnation === state.incarnation
    && confirmDelete.instance === state.record.instance && confirmDelete.revision === state.record.revision;
  return <MagicTeaPartyPageView
    hero={<MagicTeaPartyHero globalError={state.error ?? guard.message} description="本地文本茶会 · 角色与情景、Direct 发送 / 停止 / 续写、事务保存与 JSON / JSONL 导入导出" homeLink={<Link to="/" className="text-sm text-pink-700 hover:underline">返回首页</Link>} />}
    sidebar={<aside className="space-y-4">
      <MagicTeaPartySessionList sessions={state.directory.map(head => ({ id: head.id, title: head.title, updatedAt: head.updatedAt,
        roles: head.roleNames.map(name => ({ name })), ...(head.scenarioTitle ? { scenario: { title: head.scenarioTitle } } : {}) }))}
        activeSessionId={session?.id ?? null} onCreateSession={() => run(owner.create)} onSelectSession={id => run(() => owner.select(id))}
        onDeleteSession={deleteActive} pinnedCollapsed={pinnedCollapsed} recentCollapsed={recentCollapsed}
        onPinnedCollapsedChange={setPinnedCollapsed} onRecentCollapsedChange={setRecentCollapsed} busy={disabled} listScope="loaded"
        pagination={<div className="flex gap-3 text-xs"><button disabled={disabled} onClick={() => run(() => owner.refreshDirectory())}>刷新首页</button><button disabled={disabled || !state.directoryCursor} onClick={() => run(() => owner.refreshDirectory(true))}>下一批会话</button></div>} />
      <MagicTeaPartyTransferPanel activeTitle={session?.title ?? null} busy={disabled} error={null} notice={state.notice}
        onImportFile={importArchive} onExportSession={() => exportArchive('json')} onExportSessionJsonl={() => exportArchive('jsonl')} onExportArchive={() => exportArchive('archive')} />
      <fieldset disabled={disabled} className="min-w-0"><DesktopAiProviderPanel generationMode="stream" showConnectionTest={false} onDirtyChange={setProviderDirty}
        copy={{ serverOutput: { stream: '茶会使用客户端连接', nonStream: '茶会使用客户端连接' }, emptyProfilesHint: '选择客户端 Direct 连接', serverFootnote: '文本茶会尚不支持服务器执行', payloadNoun: '茶会正文' }} /></fieldset>
      <div className="text-xs text-gray-500">请主动选择客户端执行位置。本阶段不调用摘要、更新草案或额外选项接口；媒体附件导入会在写入前拒绝。卡片图片与链接只作资料保存，不自动下载。Tavern 额外系统提示等仅保留原件，沿现有通用卡正文投影。</div>
      <MagicTeaPartyOutputPreferencesPanel activeSession={session} preferences={TEA_PREFERENCES} disabled={disabled || !session}
        outputPlanSupported={false} choicesHint="只接受同一次 JSONL 输出中的选项，不发额外模型请求" onChange={patch => { if (currentScope() !== renderScope || disabled) return; if (patch.userDisplayName !== undefined) owner.stageName(patch.userDisplayName); else run(() => owner.updateSettings(patch)); }} />
    </aside>}
    setup={<MagicTeaPartySessionSetupPanel activeSession={session} importScope={currentScope()} disabled={disabled} onDirtyChange={value => { pasteDirty.current = value; }}
      roleFileAccept=".json" roleImportHint="粘贴或拖入角色 JSON；PNG 与媒体附件暂不支持"
      playerOptions={[{ value: '', label: session?.settings.userDisplayName || '旅人' }, ...(session?.roles ?? []).map(role => ({ value: role.id, label: role.name }))]}
      onOpenRoleModal={() => { if (!disabled) setLibrary('character'); }} onOpenScenarioModal={() => { if (!disabled) setLibrary('scenario'); }}
      onUploadRoles={event => run(() => importFiles(Array.from(event.target.files ?? []), 'character'))}
      onUploadScenarios={event => run(() => importFiles(Array.from(event.target.files ?? []), 'scenario'))}
      onDropRoles={files => run(() => importFiles(files, 'character'))} onDropScenarios={files => run(() => importFiles(files, 'scenario'))}
      onImportRolesText={text => importCards(text, 'character')} onImportScenariosText={text => importCards(text, 'scenario')}
      onUpdateRoles={roles => { if (currentScope() === renderScope && !disabled) run(() => owner.update({ roles })); }} onUpdateScenarios={(scenario, auxScenarios) => { if (currentScope() === renderScope && !disabled) run(() => owner.update({ scenario, auxScenarios })); }}
      onUpdatePlayerRole={playerRoleId => { if (currentScope() === renderScope && !disabled) run(() => owner.update({ playerRoleId })); }} onUpdateTitle={title => { if (currentScope() === renderScope && !disabled) owner.stageTitle(title); }}
      onLockTitle={() => run(() => owner.update({ titleMeta: { source: 'manual' } }))} onCreateSession={() => run(owner.create)} />}
    beforeChat={<>
      {confirmed ? <div role="alert" className="rounded-xl border border-red-200 p-3 text-sm">确认删除当前会话及全部消息？整库备份是恢复来源。
        <button className="ml-3 underline" disabled={disabled} onClick={() => { const confirmation = confirmDelete; setConfirmDelete(null); if (confirmation) run(() => owner.delete(confirmation.incarnation, confirmation.id, confirmation.instance, confirmation.revision)); }}>确认删除</button>
        <button className="ml-3 underline" onClick={() => setConfirmDelete(null)}>取消</button></div> : null}
      {state.pending !== 'none' ? <div role="alert" className="rounded-xl border border-amber-200 p-3 text-sm">
        {state.pending === 'unknown' ? '保存回执未知：先核对原操作，不会重复调用模型。' : '有未保存结果，保留于当前页面。'}
        <div className="flex gap-3"><button disabled={state.busy} onClick={() => run(owner.resolvePending)}>核对原保存</button>
          <button disabled={state.busy || state.pending === 'unknown'} onClick={() => run(owner.retryPending)}>重试原保存</button>
          <button disabled={state.busy || state.pending === 'unknown'} onClick={() => { if (window.confirm('确认放弃当前易失结果？已提交的数据库内容不会删除。')) run(owner.abandonPending); }}>明确放弃易失结果</button>
          <button onClick={() => downloadTextFile('magic-tea-party.unsaved.txt', owner.unsavedText(), 'text/plain')}>导出未保存内容</button></div>
      </div> : null}
      <div className="flex gap-3 text-xs text-gray-500"><span>当前显示一个有界消息页；完整导出按固定版本读取全部消息</span>
        <button disabled={disabled || !session} onClick={() => run(() => owner.nextMessages(true))}>首批消息</button>
        <button disabled={disabled || !state.messageCursor} onClick={() => run(() => owner.nextMessages())}>下一批消息</button>
        <button disabled={disabled || !session} onClick={() => run(owner.saveDraft)}>保存会话草稿</button>
      </div>
    </>}
    chat={<>
      <MagicTeaPartyChatTimeline activeSession={session} preferences={TEA_PREFERENCES} messages={state.messages.map(teaMessageView)}
        isGenerating={state.generating || preparingView} outputView={outputView} onOutputViewChange={setOutputView}
        onStopGenerating={() => { aiStore.cancelPreparingGeneration(); owner.stop(); }} onSelectChoice={owner.setInput}
        renderMessage={props => <MagicTeaPartyChatMessage {...props} renderBudget={{ segments: 2000, characters: 100_000, rawPreviewCharacters: 100_000 }}
          renderMarkdown={markdown => <MarkdownBlock {...markdown} onNavigateExternal={openContent} renderInternalLink={({ children }) => <span>{children}</span>} />} />} />
      <MagicTeaPartyChatComposer activeSession={session} preferences={TEA_PREFERENCES} draft={state.input} onDraftChange={value => { if (!preparing.current) owner.setInput(value); }}
        onSend={() => start()} onContinue={() => start(true)} isGenerating={state.generating || preparingView} hasMessages={state.messages.length > 0} disabled={disabled}
        markdownHint="Markdown 输出只保存正文；JSONL 可显示同次输出的对话与选项" />
    </>}
    afterChat={<p className="text-xs text-gray-500">文本存储上限：单消息 32 MiB、会话资料 8 MiB、单次导入 / 导出 64 MiB。整库备份含茶会表。停止与重启中断会明确标记，绝不自动重发生成。JSONL 使用原有交换格式，不能保全 JSON 的全部会话资料；需要完整文本归档时请选择 JSON。</p>}
    modals={<CardLibraryModal host={libraryHost} isOpen={library !== null} onClose={() => setLibrary(null)} onSelectCard={chooseCard}
      selectedType={library ?? 'character'} allowedTypes={[library ?? 'character']} initialTab="local" visibleTabs={['local']} allowDeckImport={false} titleOverride="选择本地数据卡" />} />;
}
