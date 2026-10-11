import { createBattleStoryReadFence, type BattleStoryReadToken } from '@mahoshojo/ui-web/arena-story-session-read';
import { ARENA_CANONICAL_RESOURCE_LIMITS, ARENA_CANONICAL_CAPABILITIES, evaluateArenaBasicGenerationReadiness } from '@mahoshojo/contracts/arena-capabilities';
import {
  StorySessionHeadSchema, StorySourceSchema,
  type StoryChapterDocument, type StoryChapterHead, type StoryChapterPage, type StorySessionHead, type StorySessionPage, type StorySessionDeleteTarget,
} from '@mahoshojo/contracts/desktop-arena-story';
import {
  type BattleStoryChapterPlan, type BattleStoryPromptWindowItem,
  isBattleStoryChapterPlanLimitReached,
} from '@mahoshojo/domain/arena-battle-story-session';
import { BattleStoryArenaSeedSchema, type BattleStoryArenaRequestInput } from '@mahoshojo/domain/arena-battle-story-request';
import { countBattleStoryCommitJsonBytes, BattleStoryCommitByteLimitError, freezeBattleStoryCommit, type BattleStorySaveEvidence } from '@mahoshojo/domain/arena-story-commit';
import { resolveAdjudicationEvents } from '@mahoshojo/domain/arena-adjudication';
import { AdjudicatorEventSchema } from '@mahoshojo/domain/data-card-schemas';
import type { AdjudicationResult } from '@mahoshojo/domain/arena-types';
import type { DesktopAiExecutionOptions } from '../../platform/desktop-ai-execution';
import {
  listStorySessions, listStoryChapters, readSelectedStoryChapter, readStoryContinueState,
  prepareStoryStorageCommit, savePreparedStoryCommit, queryStoryCommitReceipt, StorySaveError,
  prepareStorySessionDeletion, deleteStorySession, observeStorySessionDeletion, StoryDeleteError,
  type PreparedStoryCommit, type StoryNativePort,
} from '../../platform/arena-story-storage';
import {
  freezeStoryBranchIdentity, prepareStoryBranchCommit, savePreparedStoryBranchCommit, queryStoryBranchReceipt,
  type StoryBranchNativePort, type PreparedStoryBranchCommit, type CompletedStoryBranchRecords,
} from '../../platform/arena-story-branch-storage';
import { readStoryBranchSource, type StoryBranchSourcePort } from '../../platform/arena-story-branch-source';
import type { StoryBranchAnchorRequest, StoryBranchSource } from '@mahoshojo/contracts/desktop-arena-story-branch';
import { executeArenaDirect, type ArenaDirectIntent, type ArenaDirectPartial } from './direct';
import { createInitialArenaDraft, type ArenaDraft, type DesktopArenaProduct } from './session';
import { DesktopHostedStorySession, type DesktopHostedStoryState, type HostedStoryExecutionTarget } from './hosted-story-session';
import type { DesktopArenaHostedActor } from '@mahoshojo/contracts/desktop-arena-hosted';
import type { StoryPendingSnapshot, StoryPendingInput, StoryReceipt } from '@mahoshojo/contracts/desktop-arena-story';
import { captureDesktopStorySeed, completeDesktopStoryRecords, type StorySessionSnapshot } from './story-snapshot';

export type StoryExecutionTarget = { mode?: never; options: DesktopAiExecutionOptions; intent: Omit<ArenaDirectIntent, 'requestId' | 'generationMode'> } | HostedStoryExecutionTarget;
/** Host resolves the CURRENT selected target and credentials. Stored source is display only. */
export type PrepareStoryExecution = (run: (target: StoryExecutionTarget) => Promise<void>) => Promise<void>;
export type StoryChapterSelection =
  | { status: 'unloaded' }
  | { status: 'loading'; sessionId: string; chapterId: string }
  | { status: 'error'; sessionId: string; chapterId: string; message: string }
  | { status: 'loaded'; sessionId: string; chapterId: string; chapter: StoryChapterDocument };
export type StoryExportProgress = { phase: 'counting' | 'writing'; bytes: number };
export type StoryExportResult = { absolutePath: string; byteLength: number };
export type DesktopStoryDeletion = {
  target: { sessionId: string; title: string; chapterCount: number };
  phase: 'preparing' | 'confirm' | 'deleting' | 'unknown' | 'observing';
  dialogOpen: boolean;
  message: string | null;
};
export type DesktopStoryState = {
  hosted: DesktopHostedStoryState | null;
  deletion: DesktopStoryDeletion | null; deletionNotice: string | null;
  sessions: StorySessionHead[]; sessionCursor: StorySessionPage['nextCursor']; listLoading: boolean; listError: string | null;
  active: StorySessionHead | null; chapters: StoryChapterHead[]; chapterCursor: StoryChapterPage['nextCursor']; chaptersLoading: boolean; chaptersError: string | null;
  selected: StoryChapterSelection;
  phase: 'idle' | 'preparing' | 'generating' | 'completed' | 'cancelled' | 'failed';
  resultSource: 'direct' | 'hosted' | null; result: ArenaDirectPartial | null; resultChapterIndex: number | null; resultSaved: boolean;
  saving: boolean; pending: { title: string; evidence: BattleStorySaveEvidence; retryable: boolean; tooLarge: boolean } | null;
  savedUnread: StorySessionHead | null; message: string | null;
  exporting: boolean; exportProgress: StoryExportProgress | null; exportResult: StoryExportResult | null; exportError: string | null;
};
type PendingDeletion = { head: StorySessionHead; selection: BattleStoryReadToken; target: StorySessionDeleteTarget | null };
type PendingCommit = { selection: BattleStoryReadToken; evidence: BattleStorySaveEvidence } & (
  | { kind: 'linear'; prepared: PreparedStoryCommit }
  | { kind: 'branch'; prepared: PreparedStoryBranchCommit }
);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请保留现有内容后重试。';
const emptyState = (): DesktopStoryState => ({
  hosted: null, deletion: null, deletionNotice: null,
  sessions: [], sessionCursor: null, listLoading: false, listError: null,
  active: null, chapters: [], chapterCursor: null, chaptersLoading: false, chaptersError: null, selected: { status: 'unloaded' },
  phase: 'idle', resultSource: null, result: null, resultChapterIndex: null, resultSaved: false, saving: false, pending: null,
  savedUnread: null, message: null, exporting: false, exportProgress: null, exportResult: null, exportError: null,
});

/** Device-owned story state. Credential/account changes cancel execution, never discard
 * pending prose or hide persisted stories. No single-shot draft is read after capture. */
export class DesktopArenaStorySession {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private disposed = false;
  private fence = createBattleStoryReadFence<'list' | 'session' | 'chapters' | 'chapter'>();
  private readController: AbortController | null = null;
  private runController: AbortController | null = null;
  private exportController: AbortController | null = null;
  private branchSaveController: AbortController | null = null;
  private pending: PendingCommit | null = null;
  private savedResultChapterId: string | null = null;
  // Owner-lifetime consumed identities, including explicitly discarded results.
  // No persistence or cold-start recovery promise; an old callback never reauthorizes.
  private branchOperations = new Set<string>();
  private branchGenerations = new Set<string>();
  // Ephemeral confirmation only: never serialize or replay deletion intent.
  private deletion: PendingDeletion | null = null;
  private executionScope = '';
  private executionEpoch = 0;
  readonly hosted: DesktopHostedStorySession | null;
  constructor(private readonly dependencies: {
    port: StoryNativePort; execute?: typeof executeArenaDirect; id?: () => string; now?: () => number; random?: () => number;
    prepareCommit?: typeof prepareStoryStorageCommit;
    branch?: { port: StoryBranchNativePort; prepareCommit?: typeof prepareStoryBranchCommit; source?: StoryBranchSourcePort };
    hosted?: Omit<ConstructorParameters<typeof DesktopHostedStorySession>[0], 'onState' | 'onResult' | 'onSaved' | 'captureSelection' | 'loadBaseline'>;
    exportMarkdown: (head: StorySessionHead, signal: AbortSignal, onProgress: (value: StoryExportProgress) => void) => Promise<StoryExportResult>;
  }) {
    this.hosted = dependencies.hosted ? new DesktopHostedStorySession({ ...dependencies.hosted,
      onState: hosted => this.publish({ hosted }),
      onResult: (result, resultChapterIndex, phase) => this.publish({ resultSource: 'hosted', result, resultChapterIndex, phase, resultSaved: false }),
      captureSelection: () => this.captureSelection(),
      loadBaseline: (snapshot, input) => this.loadHostedBaseline(snapshot, input),
      onSaved: (receipt, head, selection) => this.acceptHostedReceipt(receipt, head, selection),
    }) : null;
  }
  private captureSelection(): BattleStoryReadToken {
    const session = this.fence.capture('session'), chapter = this.fence.capture('chapter');
    return { isCurrent: () => session.isCurrent() && chapter.isCurrent(), isInScope: () => session.isInScope() && chapter.isInScope() };
  }
  private async loadHostedBaseline(snapshot: StoryPendingSnapshot, input: StoryPendingInput): Promise<StorySessionSnapshot> {
    const { manifest } = snapshot;
    if (manifest.localAssembly === undefined) throw new Error('旧候选缺少原本地组装依据，保留原件但不能猜测组装；可读取、回放、导出或明确放弃。');
    const source = StorySourceSchema.parse({ mode: input.seed.mode, language: input.seed.language, storyLength: input.seed.storyLength,
      ...(input.seed.customStoryLength !== undefined ? { customStoryLength: input.seed.customStoryLength } : {}), generationMode: 'stream' });
    if (input.action === 'start') {
      const { mode: _mode, language: _language, storyLength: _length, customStoryLength: _custom, ...seed } = input.seed;
      return { id: manifest.sessionId, title: '未命名连续战报', createdAt: manifest.createdAt, updatedAt: manifest.createdAt,
        source, seed, workingCombatants: input.chapterContext.workingCombatants, chapterCount: 0,
        ...(manifest.localAssembly?.chapterPlan ? { chapterPlan: manifest.localAssembly.chapterPlan } : {}) };
    }
    let cursor: StorySessionPage['nextCursor'] = null, head: StorySessionHead | undefined;
    do { const page = await listStorySessions(this.dependencies.port, cursor); head = page.rows.find(row => row.id === manifest.sessionId); cursor = page.nextCursor; } while (!head && cursor);
    if (!head || head.revision !== manifest.expectedRevision || head.lastChapterId !== manifest.expectedLastChapterId) throw new Error('原故事基线已变化或无法读取；保留候选，不能追加到新的章节头。');
    const value = await readStoryContinueState(this.dependencies.port, head);
    const summaryMeta = value.session.summaryMeta as StorySessionSnapshot['summaryMeta'];
    if (summaryMeta !== undefined && (!summaryMeta || summaryMeta.mode !== 'deterministic-fallback' || summaryMeta.coveredUntilChapterIndex !== head.chapterCount || !Array.isArray(summaryMeta.coveredChapterIds) || summaryMeta.coveredChapterIds.some(id => typeof id !== 'string') || !Number.isSafeInteger(summaryMeta.refreshedAt))) throw new Error('原故事摘要覆盖记录无效');
    return { ...value.session, source: StorySourceSchema.parse(value.session.source), seed: BattleStoryArenaSeedSchema.parse({ ...value.seed,
      mode: source.mode, language: source.language, storyLength: source.storyLength, customStoryLength: source.customStoryLength }),
      workingCombatants: value.checkpoint.combatants, summaryMeta };
  }
  private async acceptHostedReceipt(receipt: StoryReceipt, knownHead: StorySessionHead | null, selection: BattleStoryReadToken) {
    this.savedResultChapterId = receipt.chapterId;
    this.publish({ pending: null, resultSaved: true, message: '完整章节已保存到本机故事。' });
    await this.refreshSessions();
    let head = knownHead ?? this.state.sessions.find(row => row.id === receipt.sessionId && row.lastChapterId === receipt.chapterId) ?? null;
    if (!head) {
      let cursor = this.state.sessionCursor;
      while (cursor && !head) { const page = await listStorySessions(this.dependencies.port, cursor); head = page.rows.find(row => row.id === receipt.sessionId && row.lastChapterId === receipt.chapterId) ?? null; cursor = page.nextCursor; }
    }
    if (!head) { this.publish({ message: '完整章节已保存，但目录暂未读回。请刷新故事目录；不会重新生成或保存。' }); return; }
    this.publish({ savedUnread: head });
    if (selection.isCurrent()) {
      await this.selectSession(head);
      if (this.state.selected.status === 'loaded' && this.state.selected.chapterId === receipt.chapterId) this.publish({ savedUnread: null });
    } else if (this.state.active?.id === head.id) {
      this.publish({ active: head }); await this.loadChapters(head, this.fence.capture('session'), false);
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(patch: Partial<DesktopStoryState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private id = () => (this.dependencies.id ?? (() => crypto.randomUUID()))();
  private now = () => (this.dependencies.now ?? Date.now)();
  private deletionBlocksWork = () => Boolean(this.deletion) && this.state.deletion?.phase !== 'unknown' && this.state.deletion?.phase !== 'observing';
  hasUnconfirmedDeletion = (sessionId = this.state.active?.id) => !!sessionId && this.deletion?.head.id === sessionId
    && (this.state.deletion?.phase === 'unknown' || this.state.deletion?.phase === 'observing');
  isBusy = () => this.deletionBlocksWork() || Boolean(this.runController) || this.state.saving || this.state.exporting || Boolean(this.hosted?.isBusy());
  hasUnsavedResult = () => !!this.hosted?.hasCandidate() || !!this.state.pending || (!!this.state.result && !this.state.resultSaved && !!(this.state.result.rawText || this.state.result.markdown || this.state.result.reasoning));
  setExecutionScope(scope: string, actor: DesktopArenaHostedActor | null = null) {
    this.hosted?.setContext(scope, actor);
    if (scope === this.executionScope) return;
    this.executionScope = scope; this.executionEpoch += 1;
    // The last accepted partial and any completed save candidate remain device-owned.
    this.runController?.abort(); this.branchSaveController?.abort();
  }
  async refreshSessions(more = false) {
    if (this.disposed || (more && (this.state.listLoading || !this.state.sessionCursor))) return;
    const token = this.fence.begin('list'); if (!token) return;
    const cursor = more ? this.state.sessionCursor : null;
    this.publish({ listLoading: true, listError: null });
    try {
      const page = await listStorySessions(this.dependencies.port, cursor);
      if (!token.isCurrent()) return;
      const rows = more ? [...this.state.sessions, ...page.rows] : page.rows;
      if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('会话目录已变化，请刷新目录。');
      if (page.nextCursor && cursor && page.nextCursor.id === cursor.id && page.nextCursor.updatedAt === cursor.updatedAt) throw new Error('会话目录未前进');
      this.publish({ sessions: rows, sessionCursor: page.nextCursor });
      return true;
    } catch (cause) { if (token.isCurrent()) { this.publish({ listError: errorText(cause) }); return false; } }
    finally { if (token.isCurrent()) this.publish({ listLoading: false }); }
  }
  async initialize() {
    const selection = this.fence.capture('session');
    await Promise.all([this.refreshSessions(), this.hosted?.discover()]);
    if (selection.isCurrent() && !this.state.active && this.state.sessions[0]) await this.selectSession(this.state.sessions[0]);
  }
  async selectSession(head: StorySessionHead) {
    if (this.disposed) return;
    const valid = StorySessionHeadSchema.parse(head);
    const token = this.fence.begin('session'); if (!token) return;
    this.fence.begin('chapter'); this.fence.begin('chapters'); this.readController?.abort();
    this.publish({ active: valid, chapters: [], chapterCursor: null, chaptersError: null, chaptersLoading: true, selected: { status: 'unloaded' } });
    // Metadata/seed/checkpoints are NOT hydrated just to open a directory.
    await Promise.all([this.loadChapters(valid, token, false), this.selectChapter(valid.lastChapterId)]);
  }
  private async loadChapters(head: StorySessionHead, selection: BattleStoryReadToken, more: boolean) {
    const token = this.fence.begin('chapters'); if (!token) return;
    const cursor = more ? this.state.chapterCursor : null;
    this.publish({ chaptersLoading: true, chaptersError: null });
    try {
      const page = await listStoryChapters(this.dependencies.port, head, cursor);
      if (!selection.isCurrent() || !token.isCurrent()) return;
      const rows = more ? [...this.state.chapters, ...page.rows] : page.rows;
      if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row, index) => row.index !== index + 1)) throw new Error('章节目录序列已变化，请重新读取会话。');
      this.publish({ chapters: rows, chapterCursor: page.nextCursor });
    } catch (cause) { if (selection.isCurrent() && token.isCurrent()) this.publish({ chaptersError: errorText(cause) }); }
    finally { if (selection.isCurrent() && token.isCurrent()) this.publish({ chaptersLoading: false }); }
  }
  async loadMoreChapters() {
    if (!this.state.active || !this.state.chapterCursor || this.state.chaptersLoading) return;
    await this.loadChapters(this.state.active, this.fence.capture('session'), true);
  }
  async selectChapter(chapterId: string) {
    const head = this.state.active; if (this.disposed || !head) return;
    const selection = this.fence.capture('session'), token = this.fence.begin('chapter'); if (!token) return;
    this.readController?.abort(); const controller = new AbortController(); this.readController = controller;
    this.publish({ selected: { status: 'loading', sessionId: head.id, chapterId } });
    try {
      const chapter = await readSelectedStoryChapter(this.dependencies.port, head, chapterId, controller.signal);
      if (selection.isCurrent() && token.isCurrent() && !controller.signal.aborted) this.publish({ selected: { status: 'loaded', sessionId: head.id, chapterId, chapter } });
    } catch (cause) {
      if (selection.isCurrent() && token.isCurrent() && !controller.signal.aborted) this.publish({ selected: { status: 'error', sessionId: head.id, chapterId, message: errorText(cause) } });
    } finally { if (this.readController === controller) this.readController = null; }
  }
  deleteSessionDisabledReason(head = this.deletion?.head ?? this.state.active): string | null {
    if (this.state.deletion?.phase === 'unknown' || this.state.deletion?.phase === 'observing') return '请先只读核对上一个删除的当前状态，再开始另一次删除。';
    if (!head) return '请先选择一个本机故事会话。';
    if (this.disposed) return '故事页面已关闭，请重新打开后操作。';
    if (this.runController || this.state.saving || this.state.exporting || this.hosted?.isBusy()) return '请等待当前生成、保存或导出完成后再删除。';
    if (this.hasUnsavedResult()) return '请先导出并处理当前未保存作品或本机候选。';
    const hosted = this.hosted?.getSnapshot();
    if (hosted && Object.keys(hosted.discoveryErrors).length) return '本机候选状态尚未读清，请刷新候选后再删除。';
    if (hosted && Object.values(hosted.slots).some(slot => slot?.manifest.sessionId === head.id)) return '另一故事页仍有本会话的待处理候选，请先前往原页面处理。';
    return null;
  }
  async requestDeleteSession() {
    if (this.deletion) {
      if (!this.deletionBlocksWork()) this.publish({ deletionNotice: '请先只读核对上一个删除的当前状态，再开始另一次删除。' });
      return;
    }
    const reason = this.deleteSessionDisabledReason();
    if (reason) { this.publish({ deletionNotice: reason }); return; }
    // Capture the clicked head and selection BEFORE describe. A later B selection
    // must not redirect the confirmation, export, deletion, or late cleanup of A.
    const head = freezeBattleStoryCommit(StorySessionHeadSchema.parse(this.state.active));
    const pending: PendingDeletion = { head, selection: this.fence.capture('session'), target: null };
    this.deletion = pending;
    const target = freezeBattleStoryCommit({ sessionId: head.id, title: `${head.titlePreview}${head.titleTruncated ? '…' : ''}`, chapterCount: head.chapterCount });
    this.publish({ deletion: { target, phase: 'preparing', dialogOpen: false, message: null }, deletionNotice: null });
    try {
      const identity = await prepareStorySessionDeletion(this.dependencies.port, head);
      if (this.disposed || this.deletion !== pending) return;
      const blocked = this.deleteSessionDisabledReason(head);
      if (blocked) { this.clearDeletion(); this.publish({ deletionNotice: blocked }); return; }
      pending.target = identity;
      this.publish({ deletion: { target, phase: 'confirm', dialogOpen: true, message: null } });
    } catch (cause) {
      if (this.disposed || this.deletion !== pending) return;
      this.clearDeletion();
      this.publish({ deletionNotice: `删除目标未能核对，尚未执行删除。请刷新故事目录后重新选择：${errorText(cause)}` });
    }
  }
  private clearDeletion() { this.deletion = null; this.publish({ deletion: null }); }
  cancelDeleteSession() {
    const state = this.state.deletion;
    if (state?.phase === 'deleting') return;
    if (state?.phase === 'unknown' || state?.phase === 'observing') {
      this.publish({ deletion: { ...state, dialogOpen: false } }); return;
    }
    this.clearDeletion();
  }
  async confirmDeleteSession() {
    const pending = this.deletion, state = this.state.deletion;
    if (this.disposed || !pending?.target || state?.phase !== 'confirm') return;
    const blocked = this.deleteSessionDisabledReason(pending.head);
    if (blocked) { this.clearDeletion(); this.publish({ deletionNotice: blocked }); return; }
    this.publish({ deletion: { ...state, phase: 'deleting', message: null } });
    try {
      const outcome = await deleteStorySession(this.dependencies.port, pending.target);
      if (this.deletion !== pending || this.disposed) return;
      await this.acceptDeletedSession(pending, outcome.status);
    } catch (cause) {
      if (this.deletion !== pending || this.disposed) return;
      if (cause instanceof StoryDeleteError && cause.evidence === 'not-written') {
        this.clearDeletion();
        this.publish({ deletionNotice: `本次未删除会话。请处理阻碍并刷新目录后重新确认：${errorText(cause)}` });
      } else {
        this.publish({ deletion: { ...state, phase: 'unknown', message: '删除结果待确认。核实前不能继续原会话；其它故事和新建不受影响。只读核对不会自动重删、保存或调用模型。' } });
      }
    }
  }
  async observeDeleteSession() {
    const pending = this.deletion, state = this.state.deletion;
    if (this.disposed || !pending?.target || state?.phase !== 'unknown') return;
    this.publish({ deletion: { ...state, phase: 'observing' } });
    try {
      const observed = await observeStorySessionDeletion(this.dependencies.port, pending.target);
      if (this.deletion !== pending || this.disposed) return;
      if (observed === 'currently-absent') { await this.acceptDeletedSession(pending, observed); return; }
      if (observed === 'unchanged' || observed === 'changed') {
        this.clearDeletion();
        this.publish({ deletionNotice: observed === 'unchanged'
          ? '原会话目前仍在，未确认删除。若仍要删除，请重新点击并确认当前目标。'
          : '本机会话身份或版本已变化，未确认删除。请刷新目录，重新读取并确认当前目标。' });
        return;
      }
      this.publish({ deletion: { ...state, phase: 'unknown', dialogOpen: this.state.deletion?.dialogOpen ?? state.dialogOpen, message: '仍无法确认本机会话当前状态，请保留现状后重试读取；不会自动重删。' } });
    } catch {
      if (this.deletion === pending && !this.disposed) this.publish({ deletion: { ...state, phase: 'unknown', dialogOpen: this.state.deletion?.dialogOpen ?? state.dialogOpen, message: '仍无法确认本机会话当前状态，请保留现状后重试读取；不会自动重删。' } });
    }
  }
  private async acceptDeletedSession(pending: PendingDeletion, status: 'deleted' | 'currently-absent') {
    const sameSelection = pending.selection.isCurrent() && this.state.active?.id === pending.head.id;
    if (sameSelection) {
      // Clear known-absent A even when a newer start still displays it. Preserve
      // that generation's session/chapter tokens so its successful B save can
      // select B; separately invalidate A's directory and abort its body read.
      if (!this.runController && !this.state.saving && !this.hosted?.isBusy()) {
        this.fence.begin('session'); this.fence.begin('chapter');
      }
      this.fence.begin('chapters'); this.readController?.abort();
      this.publish({ active: null, chapters: [], chapterCursor: null, chaptersLoading: false, chaptersError: null, selected: { status: 'unloaded' } });
    }
    this.publish({ sessions: this.state.sessions.filter(head => head.id !== pending.head.id),
      ...(this.state.savedUnread?.id === pending.head.id ? { savedUnread: null } : {}) });
    const message = status === 'deleted' ? '已删除本机会话及其全部章节和状态快照。' : '目前已确认本机会话不存在；这不证明先前删除操作的执行结果。';
    this.publish({ deletionNotice: message });
    const refreshed = await this.refreshSessions();
    if (this.deletion !== pending || this.disposed) return;
    this.clearDeletion();
    this.publish({ deletionNotice: refreshed === false ? `${message}目录刷新失败，请仅刷新故事目录。` : message });
  }
  async exportDeleteTarget() {
    const pending = this.deletion;
    if (!pending?.target || this.state.deletion?.phase !== 'confirm') return;
    const head = pending.head;
    this.clearDeletion();
    // Export exactly the frozen target without changing a newer selection.
    await this.exportStory(head);
  }
  private beginGeneration() {
    if (this.disposed || this.isBusy() || this.hasUnsavedResult() || !this.executionScope) return null;
    const controller = new AbortController(); this.runController = controller;
    this.publish({ phase: 'preparing', result: null, resultChapterIndex: null, resultSaved: false, message: null, savedUnread: null });
    const sessionSelection = this.fence.capture('session'), chapterSelection = this.fence.capture('chapter');
    const selection: BattleStoryReadToken = { isCurrent: () => sessionSelection.isCurrent() && chapterSelection.isCurrent(), isInScope: () => sessionSelection.isInScope() && chapterSelection.isInScope() };
    return { controller, epoch: this.executionEpoch, selection };
  }
  async start(input: { draft: ArenaDraft; product: DesktopArenaProduct; chapterPlan?: BattleStoryChapterPlan }, prepare: PrepareStoryExecution) {
    const issue = evaluateArenaBasicGenerationReadiness({ battleMode: input.draft.battleMode, combatantCount: input.draft.combatants.length, hasScenario: !!input.draft.scenario.content })[0];
    if (issue) { this.publish({ message: issue.code === 'GENERATION_SCENARIO_REQUIRED' ? '请先选择主情景。' : `当前模式至少需要 ${ARENA_CANONICAL_CAPABILITIES.minCombatantsByMode[input.draft.battleMode]} 位角色。` }); return; }
    const run = this.beginGeneration(); if (!run) return;
    try {
      // Own one bounded snapshot before credential preparation; page edits cannot redirect it.
      const seed = captureDesktopStorySeed(input.draft, input.product);
      countBattleStoryCommitJsonBytes(seed, ARENA_CANONICAL_RESOURCE_LIMITS.requestBodyBytes);
      const ownedSeed = freezeBattleStoryCommit(structuredClone(seed));
      const source = StorySourceSchema.parse({ mode: input.draft.battleMode, language: input.draft.selectedLanguage,
        storyLength: input.draft.storyLength, customStoryLength: input.draft.customStoryLength, generationMode: 'stream' });
      const now = this.now();
      const session: StorySessionSnapshot = { id: this.id(), title: '未命名连续战报', createdAt: now, updatedAt: now,
        source, seed: ownedSeed, workingCombatants: ownedSeed.combatants, chapterCount: 0,
        ...(input.chapterPlan ? { chapterPlan: structuredClone(input.chapterPlan) } : {}) };
      const userGuidance = input.draft.settings.userGuidance;
      await this.generateChapter({ session, workingCombatants: ownedSeed.combatants, action: 'start', expectedRevision: 0,
        recentWindow: [], userGuidance, ...run }, prepare);
    } catch (cause) { this.generationFailure(cause, run.controller); }
    finally { if (this.runController === run.controller) { this.runController = null; this.publish({}); } }
  }
  async continue(userGuidance: string, prepare: PrepareStoryExecution) {
    const head = this.state.active;
    if (!head) return;
    if (this.hasUnconfirmedDeletion(head.id)) { this.publish({ deletionNotice: '此会话的删除结果尚未核实，请先只读核对当前状态；不会启动续写。' }); return; }
    if (isBattleStoryChapterPlanLimitReached({ chapterPlan: head.chapterPlan, completedChapterCount: head.chapterCount })) {
      this.publish({ message: '本故事已完成显式章节计划。未设置计划的故事没有总章节数上限。' }); return;
    }
    const run = this.beginGeneration(); if (!run) return;
    try {
      const value = await readStoryContinueState(this.dependencies.port, head, run.controller.signal);
      if (run.controller.signal.aborted || run.epoch !== this.executionEpoch) { this.generationFailure(new Error('生成准备已取消'), run.controller); return; }
      const source = StorySourceSchema.parse(value.session.source);
      const seed = BattleStoryArenaSeedSchema.parse({ ...value.seed, mode: source.mode, language: source.language, storyLength: source.storyLength, customStoryLength: source.customStoryLength });
      const summaryMeta = value.session.summaryMeta;
      if (summaryMeta !== undefined && (!summaryMeta || typeof summaryMeta !== 'object' || !('coveredChapterIds' in summaryMeta) || !Array.isArray(summaryMeta.coveredChapterIds) || summaryMeta.coveredChapterIds.some((id: unknown) => typeof id !== 'string') || !('coveredUntilChapterIndex' in summaryMeta) || summaryMeta.coveredUntilChapterIndex !== head.chapterCount || !('mode' in summaryMeta) || summaryMeta.mode !== 'deterministic-fallback' || !('refreshedAt' in summaryMeta) || !Number.isSafeInteger(summaryMeta.refreshedAt))) throw new Error('会话摘要覆盖记录无效，请保留故事并导出。');
      const session: StorySessionSnapshot = { ...value.session, source, seed, workingCombatants: value.checkpoint.combatants, summaryMeta: summaryMeta as StorySessionSnapshot['summaryMeta'] };
      // The shared request builder validates all seed semantics before any model dispatch.
      await this.generateChapter({ session, workingCombatants: value.checkpoint.combatants, action: 'continue', expectedRevision: head.revision,
        lastInputCheckpointId: value.checkpoint.id, recentWindow: value.recentWindow, userGuidance, ...run }, prepare);
    } catch (cause) { this.generationFailure(cause, run.controller); }
    finally { if (this.runController === run.controller) { this.runController = null; this.publish({}); } }
  }
  private generationFailure(cause: unknown, controller: AbortController) {
    if (this.disposed || this.runController !== controller) return;
    this.publish({ phase: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '已停止，本次未提交章节。收到的原文仍保留，可导出。' : errorText(cause) });
  }
  private async generateChapter(input: {
    session: StorySessionSnapshot; workingCombatants: unknown[]; action: 'start' | 'continue'; expectedRevision: number;
    lastInputCheckpointId?: string; recentWindow: BattleStoryPromptWindowItem[]; userGuidance: string;
    controller: AbortController; epoch: number; selection: BattleStoryReadToken;
  }, prepare: PrepareStoryExecution) {
    const { controller, session } = input;
    const requestId = this.id(), operationId = this.id(), checkpointId = this.id(), initialCheckpointId = input.action === 'start' ? this.id() : undefined;
    const chapterIndex = session.chapterCount + 1;
    const story: BattleStoryArenaRequestInput = freezeBattleStoryCommit({
      action: input.action, chapterIndex, ...(session.lastChapterId ? { sourceChapterId: session.lastChapterId } : {}),
      chapterPlan: session.chapterPlan, seed: { ...session.seed, mode: session.source.mode, language: session.source.language,
        storyLength: session.source.storyLength, customStoryLength: session.source.customStoryLength },
      chapterContext: { workingCombatants: input.workingCombatants, sessionSummary: session.sessionSummary, recentWindow: input.recentWindow },
      userGuidance: input.userGuidance,
    });
    let dispatched = false;
    await prepare(async (target) => {
      if (target.mode === 'hosted') {
        if (this.disposed || controller.signal.aborted || input.epoch !== this.executionEpoch) return;
        if (dispatched) throw new Error('本章已准备一次生成请求，不能重复创建。');
        if (!this.hosted) throw new Error('故事 Hosted 接线尚未就绪');
        dispatched = true;
        await this.hosted.generate({ session, story, product: this.dependencies.hosted!.product,
          requestId, operationId, checkpointId, initialCheckpointId, expectedRevision: input.expectedRevision,
          lastInputCheckpointId: input.lastInputCheckpointId, selection: input.selection }, target, controller.signal);
        if (this.state.phase === 'preparing') this.publish({ phase: controller.signal.aborted ? 'cancelled' : 'failed', message: this.hosted.getSnapshot().message });
        return;
      }
      const { options, intent } = target;
      if (this.disposed || controller.signal.aborted || input.epoch !== this.executionEpoch) return;
      if (dispatched) throw new Error('本章已提交一次生成请求，不能自动重复。');
      dispatched = true;
      if (intent.mode !== 'direct-local' && intent.mode !== 'direct-remote') throw new Error('客户端生成目标无效。');
      const source = StorySourceSchema.parse({ ...session.source, providerMode: intent.mode,
        providerId: options.providerTarget?.kind === 'preset' ? options.providerTarget.providerId : options.profileId, modelId: intent.modelId });
      const events = AdjudicatorEventSchema.array().parse(story.seed.adjudicationEvents ?? []);
      const adjudicationResults = resolveAdjudicationEvents(events, this.dependencies.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000)) as unknown as AdjudicationResult[];
      this.publish({ resultSource: 'direct', phase: 'generating', resultChapterIndex: chapterIndex, result: { rawText: '', markdown: '', reasoning: '' } });
      const scopeKey = `desktop-story:${session.id}:${requestId}`;
      const outcome = await (this.dependencies.execute ?? executeArenaDirect)(options, createInitialArenaDraft(), { ...intent, requestId, generationMode: 'stream' },
        { scopeKey, reporterInfo: { name: '记者', publication: '魔法少女速报' }, adjudicationResults, story }, controller.signal,
        (partial) => { if (!this.disposed && this.runController === controller && !controller.signal.aborted) this.publish({ result: partial }); });
      if (this.disposed || this.runController !== controller) return;
      if (outcome.requestId !== requestId || outcome.scopeKey !== scopeKey) throw new Error('生成结果身份不匹配，未保存章节。');
      this.publish({ result: { rawText: outcome.rawText, markdown: outcome.markdown, reasoning: outcome.reasoning, usage: outcome.usage } });
      if (controller.signal.aborted || input.epoch !== this.executionEpoch || outcome.status !== 'completed') {
        this.publish({ phase: controller.signal.aborted || outcome.status === 'cancelled' ? 'cancelled' : 'failed', message: `${'message' in outcome ? `${outcome.message} ` : ''}本次未完成有效章节，未写入故事。收到的原文仍保留，可导出。` }); return;
      }
      // Retain completed text BEFORE projection, schema validation or storage budget checks.
      this.publish({ phase: 'completed', pending: { title: outcome.report.headline, evidence: 'not-written', retryable: false, tooLarge: false }, message: '生成完成，正在准备本地保存。' });
      try {
        const records = completeDesktopStoryRecords({ ...input, chapterIndex, operationId, checkpointId, initialCheckpointId,
          now: this.now(), source, outcome, adjudicationResults });
        const prepared = await (this.dependencies.prepareCommit ?? prepareStoryStorageCommit)({ ...records,
          expectedRevision: input.expectedRevision, expectedLastChapterId: session.lastChapterId ?? null,
          lastInputCheckpointId: input.lastInputCheckpointId });
        if (this.disposed) return;
        this.pending = { kind: 'linear', prepared, selection: input.selection, evidence: 'not-written' };
        this.publish({ pending: { title: records.chapter.title, evidence: 'not-written', retryable: true, tooLarge: false } });
        await this.savePending();
      } catch (cause) {
        if (this.disposed) return;
        const tooLarge = cause instanceof BattleStoryCommitByteLimitError;
        this.publish({ pending: { title: outcome.report.headline, evidence: 'not-written', retryable: false, tooLarge },
          message: tooLarge ? '生成完成，未保存到会话：完整章节超出本次保存预算。原文只保留在当前窗口，请先导出；重新调用模型不能修复保存限制。' : `生成完成，未保存到会话：${errorText(cause)} 原文仍保留，请导出。` });
      }
    });
    if (!dispatched && !this.disposed) this.publish({ phase: 'cancelled', message: '生成准备已取消，未调用模型。' });
  }
  /** Internal pre-generation read seam. No default binder, model or page caller. */
  async prepareBranchCompletion(input: {
    mode: 'direct' | 'hosted'; generationId: string; operationId: string; sessionId: string; anchor: StoryBranchAnchorRequest;
  }) {
    const frozen = freezeBattleStoryCommit(structuredClone(input));
    if (!this.dependencies.branch?.source || frozen.mode !== 'direct') throw new Error('此入口未开放分支源读取；Hosted 分支不受支持');
    if (!frozen.generationId || this.branchOperations.has(frozen.operationId) || this.branchGenerations.has(frozen.generationId)) throw new Error('原分支生成身份已消费，不能重新准备');
    if (this.hasUnconfirmedDeletion(frozen.anchor.sessionId)) throw new Error('源会话删除状态待确认，不能准备分支');
    const run = this.beginGeneration();
    if (!run) throw new Error('当前故事仍有待处理操作或未保存结果');
    this.branchOperations.add(frozen.operationId); this.branchGenerations.add(frozen.generationId);
    const cancelled = () => {
      this.generationFailure(new Error('分支源读取已取消'), run.controller);
      if (this.runController === run.controller) { this.runController = null; this.publish({}); }
    };
    run.controller.signal.addEventListener('abort', cancelled, { once: true });
    try {
      const snapshot = await readStoryBranchSource(this.dependencies.port, this.dependencies.branch.source, frozen.anchor, run.controller.signal);
      if (this.disposed || run.controller.signal.aborted || this.runController !== run.controller
        || run.epoch !== this.executionEpoch || !run.selection.isCurrent()) throw new Error('分支源读取已取消或选择已变化');
      const identity = freezeStoryBranchIdentity({ ...frozen, source: snapshot.source });
      run.controller.signal.removeEventListener('abort', cancelled);
      return Object.freeze({ snapshot, completion: this.branchCompletionForRun(identity, frozen.generationId, run) });
    } catch (cause) {
      this.generationFailure(cause, run.controller);
      if (this.runController === run.controller) { this.runController = null; this.publish({}); }
      throw cause;
    } finally { run.controller.signal.removeEventListener('abort', cancelled); }
  }
  /** Internal injected completion seam, not a model/anchor-reading capability.
   * The controlled producer freezes its source BEFORE generation, then transfers
   * one completed owned graph. Default pages never inject a branch port. */
  captureBranchCompletion(input: {
    mode: 'direct' | 'hosted'; generationId: string; operationId: string; sessionId: string; source: StoryBranchSource;
  }) {
    if (!this.dependencies.branch || input.mode !== 'direct') throw new Error('此入口未开放分支保存；Hosted 分支不受支持');
    if (!input.generationId || this.branchOperations.has(input.operationId) || this.branchGenerations.has(input.generationId)) throw new Error('原分支生成身份已消费，不能重新准备');
    if (this.hasUnconfirmedDeletion(input.source.session.sessionId)) throw new Error('源会话删除状态待确认，不能准备分支');
    const identity = freezeStoryBranchIdentity(input), generationId = input.generationId;
    const run = this.beginGeneration();
    if (!run) throw new Error('当前故事仍有待处理操作或未保存结果');
    this.branchOperations.add(identity.operationId); this.branchGenerations.add(generationId);
    return this.branchCompletionForRun(identity, generationId, run);
  }
  private branchCompletionForRun(identity: ReturnType<typeof freezeStoryBranchIdentity>, generationId: string,
    run: { controller: AbortController; epoch: number; selection: BattleStoryReadToken }) {
    let consumed = false;
    const ownsRun = () => !this.disposed && this.runController === run.controller;
    const release = () => { if (this.runController === run.controller) { this.runController = null; this.publish({}); } };
    const fail = (cause: unknown) => {
      if (consumed) return; consumed = true;
      if (ownsRun()) this.publish({ phase: run.controller.signal.aborted ? 'cancelled' : 'failed', message: errorText(cause) });
      release();
    };
    run.controller.signal.addEventListener('abort', () => {
      if (!consumed) fail(new Error('分支候选准备已取消，未提交章节'));
    }, { once: true });
    return Object.freeze({
      signal: run.controller.signal,
      cancel: () => run.controller.abort(),
      fail,
      complete: async (records: CompletedStoryBranchRecords, result: ArenaDirectPartial): Promise<void> => {
        if (consumed || !ownsRun() || run.controller.signal.aborted || run.epoch !== this.executionEpoch) return;
        consumed = true;
        let title = '未命名分支章';
        try {
          title = typeof records?.chapter?.title === 'string' ? records.chapter.title : title;
          // Keep completed text before schema, graph or byte-budget validation.
          this.publish({ resultSource: 'direct', phase: 'completed', result: { ...result }, resultChapterIndex: identity.source.anchorIndex + 1,
            pending: { title, evidence: 'not-written', retryable: false, tooLarge: false }, message: '分支生成完成，正在准备本地保存。' });
          if (records.chapter.generationId !== generationId) throw new Error('分支完成章与原生成身份不一致');
          const prepared = (this.dependencies.branch!.prepareCommit ?? prepareStoryBranchCommit)(identity, records);
          if (!ownsRun() || run.controller.signal.aborted || run.epoch !== this.executionEpoch) return;
          this.pending = { kind: 'branch', prepared, selection: run.selection, evidence: 'not-written' };
          this.publish({ pending: { title: records.chapter.title, evidence: 'not-written', retryable: true, tooLarge: false } });
          await this.savePending();
        } catch (cause) {
          if (!ownsRun()) return;
          const tooLarge = cause instanceof BattleStoryCommitByteLimitError;
          this.publish({ pending: { title, evidence: 'not-written', retryable: false, tooLarge },
            message: `分支完成章未保存：${errorText(cause)} 原文保留在当前窗口，可导出；不会重新调用模型。` });
        } finally { release(); }
      },
    });
  }
  async savePending() {
    const pending = this.pending;
    if (this.disposed || !pending || this.state.saving || this.deletionBlocksWork()) return;
    const saveController = pending.kind === 'branch' ? this.runController ?? new AbortController() : null;
    if (saveController) this.branchSaveController = saveController;
    this.publish({ saving: true, message: pending.evidence === 'unknown' ? '正在查询原保存操作…' : '正在保存完整章节…' });
    try {
      const receipt = pending.kind === 'branch'
        ? pending.evidence === 'unknown'
          ? await queryStoryBranchReceipt(this.dependencies.branch!.port, pending.prepared)
          : await savePreparedStoryBranchCommit(this.dependencies.branch!.port, pending.prepared, pending.evidence, saveController?.signal)
        : pending.evidence === 'unknown'
          ? await queryStoryCommitReceipt(this.dependencies.port, pending.prepared)
          : await savePreparedStoryCommit(this.dependencies.port, pending.prepared, pending.evidence);
      if (!receipt) throw new StorySaveError('尚无可核对的原操作回执，保存状态仍待确认。请保留原文或导出。', 'unknown');
      const stored = pending.prepared.parts.find((part) => part.kind === 'session')!.prepared.value as Record<string, unknown>;
      let head = StorySessionHeadSchema.parse(Object.fromEntries(['id','revision','titlePreview','titleTruncated','mode','chapterPlan','createdAt','updatedAt','chapterCount','lastChapterId'].filter((key) => stored[key] !== undefined).map((key) => [key, stored[key]])));
      this.pending = null; this.savedResultChapterId = receipt.chapterId;
      this.publish({ pending: null, resultSaved: true, savedUnread: head, message: '完整章节已保存到本机故事。' });
      if (await this.refreshSessions()) {
        head = await this.currentSavedHead(head);
        this.publish({ savedUnread: head });
      }
      if (pending.selection.isCurrent()) {
        await this.openSavedChapter(head, receipt.chapterId);
        if (this.state.selected.status === 'loaded' && this.state.selected.chapterId === receipt.chapterId) this.publish({ savedUnread: null });
      } else if (this.state.active?.id === head.id) {
        // A manual old-chapter choice wins, while the same story's head can advance.
        // The immutable selected chapter keeps its real identity and content.
        this.publish({ active: head });
        await this.loadChapters(head, this.fence.capture('session'), false);
      }
    } catch (cause) {
      if (cause instanceof StorySaveError && cause.evidence === 'unknown') pending.evidence = 'unknown';
      this.publish({ pending: this.state.pending ? { ...this.state.pending, evidence: pending.evidence } : null, message: errorText(cause) });
    } finally {
      if (this.branchSaveController === saveController) this.branchSaveController = null;
      this.publish({ saving: false });
    }
  }
  // Only reader revision may advance after exact success. The frozen writer and
  // receipt identity are never rebuilt from this directory result.
  private async currentSavedHead(fallback: StorySessionHead): Promise<StorySessionHead> {
    let head = this.state.sessions.find(row => row.id === fallback.id), cursor = this.state.sessionCursor;
    while (!head && cursor) {
      const page = await listStorySessions(this.dependencies.port, cursor);
      head = page.rows.find(row => row.id === fallback.id); cursor = page.nextCursor;
    }
    return head ?? fallback;
  }
  private async openSavedChapter(head: StorySessionHead, chapterId: string) {
    const loading = this.selectSession(head), selection = this.captureSelection();
    await loading;
    if (selection.isCurrent() && head.lastChapterId !== chapterId) await this.selectChapter(chapterId);
  }
  async readSavedResult() {
    const original = this.state.savedUnread, chapterId = this.savedResultChapterId ?? original?.lastChapterId;
    if (!original || !chapterId || this.isBusy()) return;
    const selection = this.captureSelection();
    try {
      const head = await this.refreshSessions() ? await this.currentSavedHead(original) : original;
      if (!selection.isCurrent() || this.state.savedUnread?.id !== original.id || this.isBusy()) return;
      this.publish({ savedUnread: head });
      await this.openSavedChapter(head, chapterId);
      if (this.state.selected.status === 'loaded' && this.state.selected.chapterId === chapterId) this.publish({ savedUnread: null });
    } catch (cause) { this.publish({ message: `章节已保存，读取暂未完成：${errorText(cause)}` }); }
  }
  discardResult() { if (this.isBusy()) return; if (this.hosted?.hasCandidate()) { this.publish({ message: '请先导出或明确放弃原 Hosted 候选；清除预览不会释放候选。' }); return; } this.pending = null; this.publish({ resultSource: null, result: null, pending: null, phase: 'idle', resultSaved: false, resultChapterIndex: null, message: null }); }
  cancel() { if (this.hosted?.getSnapshot().busy === 'model') { void this.hosted.requestServerStop(); return; } this.runController?.abort(); this.branchSaveController?.abort(); }
  async exportSelectedStory() {
    const head = this.state.active;
    if (head) await this.exportStory(head);
  }
  private async exportStory(head: StorySessionHead) {
    if (this.disposed || this.isBusy()) return;
    const controller = new AbortController(); this.exportController = controller;
    this.publish({ exporting: true, exportProgress: null, exportResult: null, exportError: null });
    try {
      const result = await this.dependencies.exportMarkdown(head, controller.signal, (progress) => { if (!controller.signal.aborted && !this.disposed) this.publish({ exportProgress: progress }); });
      // A resolved sink result proves end published a complete, verified file, even if
      // cancellation raced the final receipt. Never hide that known success.
      this.publish({ exportResult: result });
    } catch (cause) { this.publish({ exportError: controller.signal.aborted ? '导出已取消，未发布不完整文件。' : errorText(cause) }); }
    finally { if (this.exportController === controller) this.exportController = null; this.publish({ exporting: false }); }
  }
  cancelExport() { this.exportController?.abort(); this.hosted?.cancelExport(); }
  detach() {
    // Leaving can dismiss an unsubmitted confirmation, never release an already
    // dispatched deletion flight or make the same owner dispatch it a second time.
    this.cancelDeleteSession();
    this.hosted?.detach(); this.runController?.abort(); this.branchSaveController?.abort(); this.cancelExport(); this.readController?.abort();
  }
  dispose() { this.detach(); this.hosted?.dispose(); this.disposed = true; this.fence.dispose(); this.listeners.clear(); }
}
