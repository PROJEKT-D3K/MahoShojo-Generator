import { StoryNativeFailureSchema, StorySessionHeadSchema, type StorySessionHead } from '@mahoshojo/contracts/desktop-arena-story';
import { buildBattleStoryBranchChain } from '@mahoshojo/domain/arena-story-branch';
import { projectBattleStoryBranchSession, type BattleStoryBranchSessionView } from '@mahoshojo/ui-web/arena-story-session';
import { readStorySessionDocument, type StoryNativePort } from '../../platform/arena-story-storage';

export type DesktopStoryBranchReadState = {
  open: boolean; activeSession: BattleStoryBranchSessionView | null; sessions: BattleStoryBranchSessionView[];
  loading: boolean; error: string | null; failedSessionId: string | null;
};
const empty = (): DesktopStoryBranchReadState => ({ open: false, activeSession: null, sessions: [], loading: false, error: null, failedSessionId: null });

/** Explicit, one-record-at-a-time ancestry reads through the existing verified native
 * transport. Only bounded display projections survive each read, never session bodies.
 * Directory rows are not relation evidence; no full-library scan or automatic recursion.
 */
export class DesktopStoryBranchReader {
  private state = empty();
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private heads = new Map<string, StorySessionHead>();
  private activeHead: StorySessionHead | null = null;
  private failedHead: StorySessionHead | null = null;
  private epoch = 0;
  private disposed = false;
  constructor(private readonly dependencies: {
    port: StoryNativePort;
    getHeads(): readonly StorySessionHead[];
    selectSession(head: StorySessionHead): Promise<void>;
  }) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<DesktopStoryBranchReadState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  async open(head: StorySessionHead) {
    if (this.disposed) return;
    this.close();
    this.activeHead = StorySessionHeadSchema.parse(head);
    this.publish({ open: true });
    await this.read(this.activeHead);
  }
  close() {
    this.epoch += 1; this.controller?.abort(); this.controller = null;
    this.heads.clear(); this.activeHead = null; this.failedHead = null;
    this.publish(empty());
  }
  getUnloadedParentId(): string | null {
    const stop = buildBattleStoryBranchChain(this.state).stop;
    return stop?.kind === 'missing' ? stop.sessionId : null;
  }
  getParentHead(): StorySessionHead | null {
    const id = this.getUnloadedParentId();
    return id ? this.dependencies.getHeads().find(head => head.id === id) ?? null : null;
  }
  async readParent() {
    if (!this.state.open || this.state.loading) return;
    const head = this.getParentHead();
    if (head) await this.read(StorySessionHeadSchema.parse(head));
  }
  async retry() {
    if (this.state.open && !this.state.loading && this.failedHead) await this.read(this.failedHead);
  }
  async select(sessionId: string) {
    const head = this.heads.get(sessionId);
    if (!this.state.open || !head) return;
    this.close();
    await this.dependencies.selectSession(head);
  }
  private async read(head: StorySessionHead) {
    if (this.disposed || !this.state.open || this.controller) return;
    const controller = new AbortController(), epoch = this.epoch;
    this.controller = controller; this.failedHead = null;
    this.publish({ loading: true, error: null, failedSessionId: null });
    const current = () => !this.disposed && !controller.signal.aborted && epoch === this.epoch;
    try {
      // This explicit read can still reach the existing single-record budget. It
      // is not a new small native DTO and does not hydrate seed/chapter/checkpoints.
      const view = projectBattleStoryBranchSession(await readStorySessionDocument(this.dependencies.port, head, controller.signal));
      if (!current()) return;
      this.heads.set(head.id, head);
      this.publish({ sessions: [...this.state.sessions.filter(session => session.id !== view.id), view],
        ...(head.id === this.activeHead?.id ? { activeSession: view } : {}) });
    } catch (cause) {
      if (!current()) return;
      const native = StoryNativeFailureSchema.safeParse(cause);
      const code = native.success ? native.data.code : undefined;
      const error = code === 'story-missing' ? '读取时该会话目前不存在；当前分支的完整章节仍独立保存在本机。'
        : code === 'story-corrupt' ? '分支来源原件损坏，已停止读取父链；当前分支的其它已保存内容不会被修改。'
        : code === 'story-stale' || code === 'story-conflict' ? '会话版本已变化。请关闭分支链，刷新目录并重新选择会话后再读取。'
          : '无法读取或核验分支来源，尚未确认父链。请重试读取；当前故事仍可独立阅读。';
      this.failedHead = head;
      this.publish({ error, failedSessionId: head.id });
    } finally {
      if (current()) { this.controller = null; this.publish({ loading: false }); }
    }
  }
  dispose() { this.close(); this.disposed = true; this.listeners.clear(); }
}
