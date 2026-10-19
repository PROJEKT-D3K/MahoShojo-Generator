import { useRef, useState, useSyncExternalStore } from 'react';
import {
  BattleStoryChapterPlanControl, BattleStoryActions, BattleStoryBranchChainButton, BattleStoryBranchChainModal, BattleStoryBranchAction, BattleStoryDeleteSessionControls, BattleStoryChapterDirectory, BattleStoryChapterReader, BattleStorySessionDirectory, BattleStoryContentPreview, BattleStoryPendingOutcome, formatBattleStoryDisplayTitle,
  type BattleStoryChapterReadViewState,
} from '@mahoshojo/ui-web/arena-story-session';
import { StreamingBattleReportCard, type StreamingBattleReportCardProps, type BattleReportHostPorts } from '@mahoshojo/ui-web/arena-report';
import { ErrorMessageBox, useResultAutoScroll } from '@mahoshojo/ui-web/details-controls';
import { DENY_EXTERNAL_MEDIA } from '@mahoshojo/ui-web/markdown';
import { generationActionClassNames } from '@mahoshojo/ui-web/generation-actions';
import { normalizeUsage } from '@mahoshojo/ai-core/token-usage';
import { readArenaReportPresentationSnapshot } from './report-presentation';
import type { StoryBranchAnchorRequest } from '@mahoshojo/contracts/desktop-arena-story-branch';
import {
  formatBattleStoryChapterProgress, isBattleStoryChapterPlanLimitReached, normalizeBattleStoryTotalChapters,
  resolveBattleStoryInitialChapterPlan, type BattleStoryChapterPlan, type BattleStoryDraftChapterPlanMode,
} from '@mahoshojo/domain/arena-battle-story-session';
import { readScenarioBattleStoryConfig } from '@mahoshojo/domain/scenario-battle-story';
import type { ArenaDraft } from './session';
import { DesktopArenaStorySession } from './story-session';
import type { DesktopHostedStorySession, DesktopHostedStoryState } from './hosted-story-session';

const secondary = generationActionClassNames.secondary;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Read-only presentation. Carrier extensions stay in storage; only validated fields
 * become React/card props. No 48 KiB render-snapshot envelope is imposed on chapters. */
const cardProps = (value: unknown, mode?: StreamingBattleReportCardProps['mode']): Partial<StreamingBattleReportCardProps> => {
  const snapshot = record(value); if (!snapshot) return {};
  const reasoning = record(snapshot.aiReasoning);
  const presentation = readArenaReportPresentationSnapshot({ ...snapshot, version: 1,
    scenarioName: snapshot.scenarioName ?? snapshot.scenarioDisplayName });
  return {
    ...presentation,
    scenarioName: (presentation?.mode ?? mode) === 'scenario' ? presentation?.scenarioName : undefined,
    ...(reasoning && typeof reasoning.text === 'string' ? { aiReasoning: { status: 'done', source: 'provider', text: reasoning.text } } : {}),
  };
};
type StoryProduct = 'battle' | 'arena';
const productTitle = (product: StoryProduct) => product === 'battle' ? '简洁版 /battle' : '高级版 /arena';

/** This is a controlled view of Native candidate evidence. Only the confirmation
 * disclosure is local UI state; all recovery, role and persistence decisions stay
 * with the Hosted owner and the shared pending-outcome view. */
function HostedStoryPendingControls(props: {
  owner: DesktopHostedStorySession; state: DesktopHostedStoryState; disabled: boolean;
  hasWindowBody: boolean; hasWindowReasoning: boolean; exportWindowBody(): void;
}) {
  const { owner, state, disabled } = props;
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const active = state.active;
  if (!active) return null;
  const sealedBody = active.manifest.parts.some(part => part.kind === 'markdown');
  const queryOnly = state.evidence === 'unknown' || !!active.saveAttemptId || active.restored;
  const readonly = active.restored || active.abandonRequested;
  const allOriginalsExported = state.exportResults.length === active.manifest.parts.length + 1 && !state.exportError && state.busy !== 'export';
  const nativeExports = <>
    <button type="button" className={secondary} disabled={disabled} onClick={() => void owner.exportOriginals()}>导出全部已封存原件</button>
    {sealedBody ? <button type="button" className={secondary} disabled={disabled} onClick={() => void owner.exportOriginals('markdown')}>导出已封存完整正文</button> : null}
    {!state.outputDurable && props.hasWindowBody ? <button type="button" className={secondary} onClick={props.exportWindowBody}>导出当前窗口完整正文</button> : null}
    {state.busy === 'export' ? <button type="button" className={secondary} onClick={() => owner.cancelExport()}>取消原件导出</button> : null}
  </>;
  const canShowRole = state.hydrated && state.outputDurable && !readonly && !queryOnly;
  return <BattleStoryPendingOutcome
    heading={state.busy === 'save' ? '正在核对或保存原章节…' : queryOnly ? 'Hosted 章节保存状态待确认'
      : state.outputDurable ? 'Hosted 正文已封存，尚未保存到故事' : 'Hosted 候选保留，最新正文与推理尚未耐久封存'}
    detail={<>
      <p>{state.outputDurable ? '完成原件已保存在本机候选中。角色处理与章节保存分别核对，不会重新创建模型任务。'
        : '最新正文与推理仅保留在当前窗口，关闭后可能丢失。Native 已封存原件可能只有输入，导出这些原件不包含尚未封存的最新输出；请分别导出当前窗口完整正文与推理原文。'}</p>
      {active.restored ? <p>这是备份恢复作品：只能读取、原账号回放原请求、查询原保存回执、导出或明确放弃，不能重新保存或同步角色。</p> : null}
      {queryOnly ? <p>只能查询原保存操作回执；没有回执不代表未保存，不授权重试保存、另存或重新生成。</p> : null}
      {!state.actorCurrent ? <p>当前账号与原请求不一致。原件仍可在本机读取、导出或明确放弃；恢复与角色处理须使用原账号。</p> : null}
      {!active.createClaim ? <p>此候选没有创建 claim；不能补发旧请求。可保留、导出，或明确放弃后由你新建。</p> : null}
      {state.role && 'warning' in state.role && state.role.warning ? <p>{state.role.warning}</p> : null}
    </>}
    roleResolution={canShowRole ? state.role ?? undefined : undefined} roleBusy={state.busy === 'role'}
    canRetryRole={!disabled && owner.canResolveRoles()} canKeepOriginal={!disabled && owner.canKeepOriginalRoles()}
    onRetryRole={canShowRole ? () => void owner.retryRoles() : undefined}
    onKeepOriginal={canShowRole ? () => void owner.keepOriginalRoles() : undefined}
    exportAction={nativeExports}
    saveActions={queryOnly
      ? active.manifest.commitManifest && state.hydrated && !active.abandonRequested
        ? <button type="button" className={secondary} disabled={disabled} onClick={() => void owner.queryReceipt()}>查询原保存回执</button> : null
      : !readonly && state.localRetry
        ? <button type="button" className={secondary} disabled={disabled || !state.actorCurrent} onClick={() => void owner.retryLocal()}>{state.localRetry === 'seal' ? '重试原件本地封存' : state.localRetry === 'freeze' ? '重试本地组装保存' : '重试原本地保存'}</button> : null}>
    {active.abandonRequested ? <div className="mt-3 space-y-2">
      <p>原放弃意图已确认，清理尚未完成。候选及恢复入口仍可能保留，不能保证已经可以新建。</p>
      <button type="button" className={secondary} disabled={disabled} onClick={() => void owner.abandonConfirmed()}>继续清理原本机候选</button>
    </div> : confirmAbandon ? <div className="mt-3 space-y-2" role="group" aria-label="确认放弃本机候选">
      <p>放弃会移除此本机候选及原恢复入口。保存状态未知时，本机故事库可能已有本章；不会删除已保存章节或回执，也不保证服务器停止或退费。之后新建须由你再次操作，并使用全新任务。</p>
      {!state.outputDurable && (props.hasWindowBody || props.hasWindowReasoning) ? <p>当前窗口的最新正文与推理尚未耐久封存，请先分别导出；导出已封存原件不能保全这些最新输出。</p> : null}
      {allOriginalsExported ? <p>全部已封存原件及清单已有成功导出回执。导出不会自动放弃候选。</p> : null}
      <BattleStoryActions>
        <button type="button" className={secondary} disabled={disabled} onClick={() => void owner.exportOriginals()}>先导出全部原件</button>
        <button type="button" className={secondary} autoFocus onClick={() => setConfirmAbandon(false)}>返回保留</button>
        <button type="button" className={secondary} disabled={disabled} onClick={() => { setConfirmAbandon(false); void owner.abandonConfirmed(); }}>{allOriginalsExported ? '已导出封存原件，确认放弃本机候选' : '确认不导出并放弃本机候选'}</button>
      </BattleStoryActions>
    </div> : <div className="mt-3"><button type="button" className={secondary} disabled={disabled} onClick={() => setConfirmAbandon(true)}>放弃本机候选…</button></div>}
  </BattleStoryPendingOutcome>;
}

function HostedStoryInputPendingControls(props: {
  owner: DesktopHostedStorySession; disabled: boolean;
  download(fileName: string, text: string, mimeType: string): void;
}) {
  const exporting = useRef(false);
  const [exportState, setExportState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const exportInput = async () => {
    if (exporting.current) return;
    exporting.current = true; setExportState({ busy: true, error: null });
    try {
      const text = await props.owner.readWindowInputOriginal();
      if (text === null) throw new Error('当前窗口已没有可核对的原冻结输入，请保留原状态并查询候选。');
      props.download('未封存故事输入.json', text, 'application/json');
      setExportState({ busy: false, error: null });
    } catch (cause) { setExportState({ busy: false, error: cause instanceof Error ? cause.message : '原冻结输入导出失败，请保留当前窗口后重试。' }); }
    finally { exporting.current = false; }
  };
  return <BattleStoryPendingOutcome heading="原输入封存未证实，尚未调用模型"
    detail={<>
      <p>原冻结输入仍保留在当前窗口。只能查询或恢复同一份原件的原封存操作；成功后不会自动创建模型请求，请继续读取、导出或明确放弃原候选。</p>
      <p>首次上传回执未给出 token 时，只能查询已封存候选；无法安全重传或定位清理暂存上传，请保留当前窗口、导出输入并返回。</p>
    </>}
    exportAction={<button type="button" className={secondary} disabled={props.disabled || exportState.busy} onClick={() => void exportInput()}>导出当前窗口冻结输入</button>}
    saveActions={<button type="button" className={secondary} disabled={props.disabled || exportState.busy || !props.owner.canRetryLocal()} onClick={() => void props.owner.retryLocal()}>查询或恢复原件封存</button>}>
    {exportState.error ? <ErrorMessageBox message={exportState.error} /> : null}
  </BattleStoryPendingOutcome>;
}

export function DesktopArenaStoryControls(props: {
  owner: DesktopArenaStorySession; draft: ArenaDraft; disabled: boolean; unavailableReason: string | null;
  product?: StoryProduct; onNavigateStoryProduct?(product: StoryProduct): void;
  onStart(plan?: BattleStoryChapterPlan): void; onContinue(userGuidance: string): void;
  onBranch?(anchor: StoryBranchAnchorRequest, userGuidance: string): void; branchUnavailableReason?: string | null;
  download(fileName: string, text: string, mimeType: string): void;
  onNavigateExternal: BattleReportHostPorts['onNavigateExternal'];
  reportPorts?: BattleReportHostPorts;
  reportExporting?: boolean;
}) {
  const { owner, draft } = props;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const branchRead = useSyncExternalStore(owner.branchReader.subscribe, owner.branchReader.getSnapshot);
  const [planMode, setPlanMode] = useState<BattleStoryDraftChapterPlanMode>('auto');
  const [planInput, setPlanInput] = useState('');
  const [guidance, setGuidance] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const generating = state.phase === 'preparing' || state.phase === 'generating';
  useResultAutoScroll(resultRef, Boolean(state.result?.markdown || state.result?.reasoning) && (state.phase === 'generating' || state.phase === 'completed'), { restored: false });
  const plan = resolveBattleStoryInitialChapterPlan({ scenario: draft.battleMode === 'scenario' ? draft.scenario.content : null,
    userSelectionMode: planMode, userDesiredTotalChapters: planInput });
  const fixed = plan?.locked === true;
  const planError = !fixed && planMode === 'custom' && !normalizeBattleStoryTotalChapters(planInput);
  const busy = props.disabled || owner.isBusy();
  const product = props.product ?? 'battle';
  const hosted = state.hosted, hostedOwner = owner.hosted;
  const hostedResult = state.resultSource === 'hosted';
  const candidate = hosted?.active;
  const hasUnsealedWindowResult = !!(state.result?.markdown || state.result?.reasoning || state.result?.rawText) && !state.resultSaved && (!hostedResult || !hosted?.outputDurable);
  const blockedByCandidate = !!hostedOwner?.hasCandidate() || !!hosted && Object.keys(hosted.discoveryErrors).length > 0;
  const canGenerate = !busy && !state.pending && !props.unavailableReason && !blockedByCandidate;
  const otherStoryCandidate = !!state.active && Object.values(hosted?.slots ?? {}).some(slot => slot?.manifest.sessionId === state.active?.id);
  const reached = !!state.active && isBattleStoryChapterPlanLimitReached({ chapterPlan: state.active.chapterPlan, completedChapterCount: state.active.chapterCount });
  const canBranch = canGenerate && !!props.onBranch && !props.branchUnavailableReason && !otherStoryCandidate && !owner.hasUnconfirmedDeletion();
  const branchTitle = props.branchUnavailableReason ?? props.unavailableReason ?? undefined;
  const branchAt = (chapterId: string, chapterIndex: number) => {
    const head = state.active;
    if (!canBranch || !head || isBattleStoryChapterPlanLimitReached({ chapterPlan: head.chapterPlan, completedChapterCount: chapterIndex })) return;
    props.onBranch?.(Object.freeze({ sessionId: head.id, revision: head.revision, expectedLastChapterId: head.lastChapterId,
      expectedChapterCount: head.chapterCount, anchorChapterId: chapterId, anchorIndex: chapterIndex }), guidance);
  };
  const ports: BattleReportHostPorts = props.reportPorts ?? { mediaPolicy: DENY_EXTERNAL_MEDIA, onNavigateExternal: props.onNavigateExternal,
    downloadMarkdown: (text, fileName) => props.download(fileName, text, 'text/markdown;charset=utf-8') };
  const selection = state.selected;
  const readState: BattleStoryChapterReadViewState = selection.status === 'unloaded' ? { status: 'unloaded' }
    : selection.status === 'loaded' ? {
      status: 'loaded', identity: { sessionId: selection.sessionId, chapterId: selection.chapterId },
      title: `章节预览｜第 ${selection.chapter.index} 章 · ${formatBattleStoryDisplayTitle(selection.chapter.title)}`,
      content: <BattleStoryContentPreview key={selection.chapterId} characterCount={selection.chapter.markdown.length}
        exportAction={<button type="button" className={secondary} onClick={() => props.download(`第${selection.chapter.index}章.md`, selection.chapter.markdown, 'text/markdown;charset=utf-8')}>导出本章完整正文</button>}>
        <StreamingBattleReportCard mode={state.active?.mode} {...cardProps(selection.chapter.cardSnapshot, state.active?.mode)} content={selection.chapter.markdown} ports={ports} />
      </BattleStoryContentPreview>,
      footer: <>
        <p className="text-xs text-gray-500">本章保存在当前设备；角色变化仅属于本故事的工作副本。</p>
        <BattleStoryActions className="mt-3 flex flex-wrap gap-2"><BattleStoryBranchAction variant="selected" chapterIndex={selection.chapter.index}
          disabled={!canBranch || selection.sessionId !== state.active?.id || isBattleStoryChapterPlanLimitReached({ chapterPlan: state.active?.chapterPlan, completedChapterCount: selection.chapter.index })}
          title={branchTitle} onClick={() => branchAt(selection.chapterId, selection.chapter.index)} /></BattleStoryActions>
      </>,
    } : selection.status === 'loading' ? { status: 'loading', identity: { sessionId: selection.sessionId, chapterId: selection.chapterId } }
      : { status: 'error', identity: { sessionId: selection.sessionId, chapterId: selection.chapterId }, message: selection.message };
  const exportResult = () => { if (state.result) props.download(state.resultSaved ? '本次章节.md' : '未保存章节.md', state.result.markdown, 'text/markdown;charset=utf-8'); };
  const exportWindowReasoning = () => { if (state.result?.reasoning) props.download('未封存推理原文.txt', state.result.reasoning, 'text/plain;charset=utf-8'); };
  const exportRaw = () => { if (state.result) props.download('连续故事原始输出.json', JSON.stringify({ rawText: state.result.rawText, reasoning: state.result.reasoning, usage: state.result.usage }, null, 2), 'application/json'); };
  return <section aria-label="连续战报会话" className="mt-6 space-y-4 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
    <div><h2 className="text-xl font-semibold text-gray-900">连续战报会话</h2>
      <p className="mt-1 text-sm text-gray-600">{hostedOwner ? '简洁版与高级版共用本机故事。首章冻结当前页配置；续写沿用故事种子与章末角色，并使用当前显式选择的执行位置与模型。' : '简洁版与高级版共用本机故事。首章冻结当前页配置；续写沿用故事种子与章末角色，并使用当前显式选择的 Direct 模型。'}</p>
      <p className="mt-1 text-xs text-gray-500">Markdown 流式章节；确定性摘要不额外调用 AI。Direct 分支会保留到锚点为止的完整故事并生成下一章，源故事不变。{hostedOwner ? 'Hosted 分支和重写暂未开放。' : 'Hosted 和重写暂未开放。'}单次草稿、活动历史与原卡各自独立；退出账号不会隐藏本机故事。</p>
      <p className="mt-1 text-xs text-gray-500">当前连续请求沿用 Web 的种子字段：分队显示名称、活动历史及历史引用不会额外注入章节。读取／写入角色历战与当前状态按冻结设置生效。</p>
    </div>
    <BattleStoryChapterPlanControl mode={planMode} input={planInput} plan={plan}
      scenarioPlan={draft.battleMode === 'scenario' ? readScenarioBattleStoryConfig(draft.scenario.content) : null}
      locked={fixed} disabled={busy} error={planError ? '自定义章节计划须为 1–20 的整数。' : null}
      onModeChange={setPlanMode} onInputChange={setPlanInput} />
    <label className="block text-sm">下一章故事引导（独立于单次草稿；首章使用当前页引导）
      <textarea aria-label="下一章故事引导" className="mt-1 block w-full rounded-lg border p-2" value={guidance} disabled={busy} onChange={(event) => setGuidance(event.target.value)} />
    </label>
    <BattleStoryActions>
      <button className={secondary} type="button" disabled={!canGenerate || !!planError} title={props.unavailableReason ?? undefined} onClick={() => props.onStart(plan ?? undefined)}>新建连续战报</button>
      <button className={secondary} type="button" disabled={!canGenerate || !state.active || reached || otherStoryCandidate || owner.hasUnconfirmedDeletion()} title={props.unavailableReason ?? undefined} onClick={() => props.onContinue(guidance)}>继续续写</button>
      <BattleStoryBranchAction variant="tail" disabled={!canBranch || !state.active || reached} title={branchTitle}
        onClick={() => { if (state.active) branchAt(state.active.lastChapterId, state.active.chapterCount); }} />
      <BattleStoryBranchChainButton className={secondary} disabled={!state.active || busy} onClick={() => { if (state.active) void owner.branchReader.open(state.active); }} />
      <button className={secondary} type="button" disabled={!state.active || busy} onClick={() => void owner.exportSelectedStory()}>导出完整 Markdown</button>
      {generating && !hostedResult && !hosted?.busy ? <button className={secondary} type="button" onClick={() => owner.cancel()}>停止章节生成</button> : null}
      {state.exporting ? <button className={secondary} type="button" onClick={() => owner.cancelExport()}>取消故事导出</button> : null}
    </BattleStoryActions>
    <BattleStoryBranchChainModal isOpen={branchRead.open} sessions={branchRead.sessions} activeSession={branchRead.activeSession}
      onClose={() => owner.branchReader.close()} onSelectSession={id => void owner.branchReader.select(id)} loading={branchRead.loading} error={branchRead.error}
      showChildren={false} scopeNote="按需逐级读取父链，不扫描所有故事或发现全部子分支。父会话须先在当前目录中载入；缺少来源不影响本分支的完整章节。"
      actions={<BattleStoryActions>
        {owner.branchReader.getParentHead() && !branchRead.failedSessionId ? <button type="button" className={secondary} disabled={branchRead.loading} onClick={() => void owner.branchReader.readParent()}>读取上一级父会话</button> : null}
        {owner.branchReader.getUnloadedParentId() && !owner.branchReader.getParentHead() ? <p role="status" className="w-full text-xs text-amber-800">来源未在已加载目录中，可能尚未载入或已删除；请先载入更多目录或刷新后再读。</p> : null}
        {branchRead.failedSessionId ? <button type="button" className={secondary} disabled={branchRead.loading} onClick={() => void owner.branchReader.retry()}>重试读取分支来源</button> : null}
        <button type="button" className={secondary} disabled={state.listLoading} onClick={() => void owner.refreshSessions()}>刷新故事目录</button>
        {state.sessionCursor ? <button type="button" className={secondary} disabled={state.listLoading} onClick={() => void owner.refreshSessions(true)}>载入更多故事目录</button> : null}
        {state.listError ? <p role="alert">{state.listError}</p> : null}
      </BattleStoryActions>} />
    <BattleStoryDeleteSessionControls
      target={state.deletion?.phase === 'preparing' ? null : state.deletion?.target ?? null}
      open={state.deletion?.dialogOpen}
      disabledReason={props.disabled ? '请等待当前操作完成后再删除。' : owner.deleteSessionDisabledReason()}
      preparing={state.deletion?.phase === 'preparing'}
      busy={state.deletion?.phase === 'deleting' || state.deletion?.phase === 'observing'}
      mode={state.deletion?.phase === 'unknown' || state.deletion?.phase === 'observing' ? 'unknown' : 'confirm'}
      message={state.deletion?.message}
      onRequest={() => void owner.requestDeleteSession()} onCancel={() => owner.cancelDeleteSession()}
      onConfirm={() => void owner.confirmDeleteSession()} onExport={() => void owner.exportDeleteTarget()}
      onObserve={() => void owner.observeDeleteSession()} />
    {state.deletionNotice ? <p role="status" className="text-sm text-amber-800">{state.deletionNotice}</p> : null}
    {props.unavailableReason ? <p role="status">{props.unavailableReason} 已保存故事仍可阅读和导出。</p> : null}
    {reached ? <p role="status">已完成本故事的显式章节计划。</p> : null}
    {state.message ? <p role="status" className="text-sm text-amber-800">{state.message}</p> : null}
    {hosted && hostedOwner ? <section aria-label="Hosted 本机待处理候选" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Hosted 本机待处理候选</h3>
        <button type="button" className={secondary} disabled={busy} onClick={() => void hostedOwner.discover()}>刷新本机候选</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{(['battle', 'arena'] as const).map(slotProduct => {
        const slot = hosted.slots[slotProduct];
        const alreadyRead = hosted.hydrated && candidate?.manifest.requestId === slot?.manifest.requestId
          && candidate?.manifest.pendingRevision === slot?.manifest.pendingRevision;
        return <section key={slotProduct} aria-label={`${productTitle(slotProduct)}原候选`} className="space-y-2 rounded-lg border border-gray-200 p-3">
          <h4 className="font-semibold">{productTitle(slotProduct)} 原候选</h4>
          {hosted.discoveryErrors[slotProduct] ? <ErrorMessageBox message={hosted.discoveryErrors[slotProduct]} /> : slot ? <>
            <p className="break-all text-xs">原请求：{slot.manifest.requestId}｜{slot.restored ? '备份恢复，只读' : slot.abandonRequested ? '原放弃清理待完成' : slot.manifest.modelCompleted ? '完成原件已封存' : '尚未完成封存'}</p>
            {slotProduct === product ? <BattleStoryActions>
              <button type="button" className={secondary} disabled={busy || hasUnsealedWindowResult || alreadyRead} title={hasUnsealedWindowResult ? '当前窗口仍有未保存正文或推理，请先导出并处理原结果' : alreadyRead ? '本候选原件已读取；请继续处理当前原件' : undefined} onClick={() => void hostedOwner.openCandidate()}>读取原件（本地）</button>
              <button type="button" className={secondary} disabled={busy || !hosted.hydrated || !hosted.actorCurrent || !candidate?.createClaim || candidate.manifest.requestId !== slot.manifest.requestId || !!candidate.abandonRequested || !candidate.restored && (hosted.evidence === 'unknown' || !!candidate.saveAttemptId)}
                onClick={() => void hostedOwner.recover()}>恢复原请求</button>
            </BattleStoryActions> : <button type="button" className={secondary} disabled={!props.onNavigateStoryProduct} onClick={() => props.onNavigateStoryProduct?.(slotProduct)}>前往{productTitle(slotProduct)}处理原候选</button>}
          </> : <p className="text-xs text-gray-500">本产品暂无本机候选</p>}
        </section>;
      })}</div>
      {!candidate?.restored && (hosted.busy === 'model' || candidate?.createClaim && hosted.actorCurrent && !candidate.abandonRequested) ? <BattleStoryActions>
        <button type="button" className={secondary} disabled={hosted.stopping || hosted.busy !== 'model' && busy} onClick={() => void hostedOwner.requestServerStop()}>请求服务器停止</button>
      </BattleStoryActions> : null}
      {hosted.busy === 'model' ? <p role="status">正在读取原请求。离开页面或账号变化只会脱离本机订阅，不代表服务器停止；请求停止也不保证退费。</p> : null}
      {candidate ? <HostedStoryPendingControls key={`${candidate.manifest.product}:${candidate.manifest.requestId}:${candidate.manifest.inputDigest}`}
        owner={hostedOwner} state={hosted} disabled={busy} hasWindowBody={hostedResult && !!state.result?.markdown} hasWindowReasoning={hostedResult && !!state.result?.reasoning} exportWindowBody={exportResult} /> : null}
      {!candidate && hosted.localRetry === 'seal' ? <HostedStoryInputPendingControls owner={hostedOwner} disabled={busy} download={props.download} /> : null}
      {hosted.message ? <p role="status" className="text-sm text-amber-800">{hosted.message}</p> : null}
      {hosted.pointerError ? <ErrorMessageBox message={`原恢复入口仍保留：${hosted.pointerError}`} /> : null}
      {hosted.exportError ? <ErrorMessageBox message={hosted.exportError} /> : null}
      {hosted.exportResults.length ? <ul aria-label="原件导出成功回执" className="space-y-1 text-xs">{hosted.exportResults.map(result => <li key={result.token} className="break-all">已导出：{result.absolutePath}（{result.byteLength} 字节）｜{result.digest}</li>)}</ul> : null}
    </section> : null}
    {state.pending ? <BattleStoryPendingOutcome
      heading={state.saving ? '正在保存已完成章节…' : state.pending.evidence === 'unknown' ? '生成完成，保存状态待确认' : '生成完成，未保存到会话'}
      detail="完整结果只保留在当前窗口，关闭后可能丢失。先导出正文和原始输出可保留本次结果。"
      saveActions={state.pending.retryable ? <button className={secondary} type="button" disabled={state.saving} onClick={() => void owner.savePending()}>{state.pending.evidence === 'unknown' ? '查询原保存结果' : '重试本地保存'}</button> : null}
      exportAction={<>
        <button className={secondary} type="button" onClick={exportResult}>导出未保存章节</button><button className={secondary} type="button" onClick={exportRaw}>导出完整原始输出</button>
        <button className={secondary} type="button" disabled={owner.isBusy() || props.reportExporting} onClick={() => { if (props.reportExporting) return; if (window.confirm('丢弃当前未保存结果？请先导出。保存待确认时，本机可能已有此章。')) owner.discardResult(); }}>丢弃当前结果</button>
      </>} /> : null}
    {state.savedUnread ? <button className={secondary} type="button" disabled={props.reportExporting} onClick={() => { if (!props.reportExporting) void owner.readSavedResult(); }}>读取刚保存的章节</button> : null}
    {state.exporting ? <p role="status">{state.exportProgress?.phase === 'writing' ? '正在写出完整故事' : '正在核对完整故事'}：{state.exportProgress?.bytes ?? 0} 字节；未完成核验前不会发布文件。</p> : null}
    {state.exportError ? <ErrorMessageBox message={state.exportError} /> : null}
    {state.exportResult ? <p role="status" className="break-all">完整故事已导出：{state.exportResult.absolutePath}（{state.exportResult.byteLength} 字节）</p> : null}
    <div className="grid gap-5 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <BattleStorySessionDirectory rows={state.sessions.map((row) => ({ id: row.id, disabled: props.reportExporting, title: `${row.titlePreview}${row.titleTruncated ? '…' : ''}`,
          description: `${new Date(row.updatedAt).toLocaleString()}｜${formatBattleStoryChapterProgress({ completedChapterCount: row.chapterCount, chapterPlan: row.chapterPlan })}` }))}
          selectedId={state.active?.id ?? null} onSelect={(id) => { if (props.reportExporting) return; const head = state.sessions.find((row) => row.id === id); if (head) void owner.selectSession(head); }}
          loading={state.listLoading} error={state.listError} footer={<BattleStoryActions className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondary} disabled={state.listLoading} onClick={() => void owner.refreshSessions()}>刷新故事目录</button>{state.sessionCursor ? <button type="button" className={secondary} disabled={state.listLoading} onClick={() => void owner.refreshSessions(true)}>更多故事</button> : null}</BattleStoryActions>} />
        <BattleStoryChapterDirectory rows={state.chapters.map((row) => ({ id: row.id, disabled: props.reportExporting, title: `第 ${row.index} 章 · ${row.titlePreview}${row.titleTruncated ? '…' : ''}`,
          description: `${row.action === 'start' ? '首章' : row.action === 'branch' ? '分支' : '续写'}｜${new Date(row.createdAt).toLocaleString()}` }))}
          selectedId={selection.status === 'unloaded' ? null : selection.chapterId} count={state.active?.chapterCount ?? 0} onSelect={(id) => { if (!props.reportExporting) void owner.selectChapter(id); }}
          loading={state.chaptersLoading} error={state.chaptersError} footer={<BattleStoryActions className="mt-3 flex flex-wrap gap-2">{state.chaptersError && state.active ? <button type="button" className={secondary} disabled={props.reportExporting} onClick={() => { if (!props.reportExporting && state.active) void owner.selectSession(state.active); }}>重读章节目录</button> : null}{state.chapterCursor ? <button type="button" className={secondary} disabled={state.chaptersLoading} onClick={() => void owner.loadMoreChapters()}>更多章节</button> : null}</BattleStoryActions>} />
      </div>
      <div className="min-w-0 space-y-4">
        <div ref={resultRef}>
          {state.result && (generating || state.result.rawText || state.result.markdown || state.result.reasoning) ? <section aria-label="本次章节结果" className="space-y-3">
            <p className="font-semibold">本次第 {state.resultChapterIndex} 章 · {state.resultSaved ? '已保存' : generating ? '生成中' : '尚未保存'}</p>
            <BattleStoryContentPreview key={state.resultChapterIndex} characterCount={state.result.markdown.length}
              exportAction={<button type="button" className={secondary} onClick={exportResult}>导出当前完整正文</button>}>
              <StreamingBattleReportCard {...cardProps(state.result.presentation)} aiUsage={normalizeUsage(state.result.presentation?.aiUsage ?? state.result.usage)} content={state.result.markdown} isStreaming={state.phase === 'generating'} onStopGeneration={hostedResult ? undefined : () => owner.cancel()}
                aiReasoning={state.result.reasoning ? { status: generating ? 'thinking' : 'done', source: 'provider', text: state.result.reasoning } : null} ports={ports} />
            </BattleStoryContentPreview>
            {hostedResult && !state.resultSaved && !hosted?.outputDurable ? <p role="status">当前窗口原文，尚未耐久封存。正文与推理仅在当前窗口，请分别导出完整正文与推理原文；本机已封存的输入原件不包含这些最新输出。</p> : null}
            {hostedResult && !state.resultSaved && !hosted?.outputDurable && state.result.reasoning ? <BattleStoryActions>
              <button type="button" className={secondary} onClick={exportWindowReasoning}>导出当前窗口推理原文</button>
            </BattleStoryActions> : null}
            {!hostedResult ? <><details><summary>完整原始输出</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{state.result.rawText}</pre></details>
            <BattleStoryActions><button type="button" className={secondary} onClick={exportRaw}>导出完整原始输出</button>{!state.pending && !generating ? <button type="button" className={secondary} disabled={owner.isBusy() || props.reportExporting} onClick={() => { if (props.reportExporting) return; if (!owner.hasUnsavedResult() || window.confirm('清除当前未保存原文？请先导出。')) owner.discardResult(); }}>清除本次预览</button> : null}</BattleStoryActions></> : null}
          </section> : null}
        </div>
        <BattleStoryChapterReader state={readState} description="按需读取所选章节全文；目录页数不会限制完整故事导出。" emptyContent={<p>选择故事后可阅读任意章节。</p>}
          errorActions={selection.status === 'error' ? <button className={secondary} type="button" disabled={props.reportExporting} onClick={() => { if (!props.reportExporting) void owner.selectChapter(selection.chapterId); }}>重试读取本章</button> : null} />
      </div>
    </div>
  </section>;
}
