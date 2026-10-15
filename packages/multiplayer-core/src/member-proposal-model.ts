import { ArenaProposalIdSchema, type ArenaProposalChange, type ArenaRoomProposalSubmitRequest, type ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { ArenaProposalEditorError, createArenaProposalEditor, editWorkingConfig, previewArenaProposal, resetArenaProposalEditor, syncArenaProposalEditor, type ArenaProposalEditorSnapshot, type ArenaProposalEditorState } from './proposal-editor';
import { validateProposalChanges, type ProposalSelectionIssue } from './selection';
import { createArenaMemberProposalActions, type ArenaMemberProposalActions, type ArenaMemberProposalUpdate } from './member-proposal-actions';

export type ArenaMemberProposalState = Readonly<{ editor: ArenaProposalEditorState; generation: number; disposed: boolean }>;
export type ArenaMemberProposalPreview = Readonly<{
  generation: number;
  proposalId: string;
  editor: ArenaProposalEditorState;
  changes: readonly ArenaProposalChange[];
  selectedChangeIds: readonly string[];
  issues: readonly ProposalSelectionIssue[];
  intent: ArenaRoomProposalSubmitRequest | null;
}>;
export type ArenaMemberProposalModel = Readonly<{
  store: Readonly<{ getState(): ArenaMemberProposalState; getInitialState(): ArenaMemberProposalState; subscribe(_listener: () => void): () => void }>;
  actions: ArenaMemberProposalActions;
  update: ArenaMemberProposalUpdate;
  sync(_snapshot: ArenaProposalEditorSnapshot): void;
  replace(_snapshot: ArenaProposalEditorSnapshot): void;
  exportSharedConfig(): ArenaRoomSharedConfig;
  preparePreview(_proposalId: string): ArenaMemberProposalPreview;
  selectPreview(_preview: ArenaMemberProposalPreview, _selectedChangeIds: readonly string[]): ArenaMemberProposalPreview;
  isPreviewCurrent(_preview: ArenaMemberProposalPreview): boolean;
  assertPreviewCurrent(_preview: ArenaMemberProposalPreview): void;
  takePreviewIntent(_preview: ArenaMemberProposalPreview): ArenaRoomProposalSubmitRequest;
  invalidatePreview(): void;
  dismissPreview(): void;
  dispose(): void;
}>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Detached, in-memory member session. No default/global session, persistence or transport. */
export function createArenaMemberProposalModel(snapshot: ArenaProposalEditorSnapshot): ArenaMemberProposalModel {
  let observed = createArenaProposalEditor(snapshot);
  let state: ArenaMemberProposalState = freeze({ editor: observed, generation: 0, disposed: false });
  const initial = state;
  const listeners = new Set<() => void>();
  const previews = new WeakSet<ArenaMemberProposalPreview>();
  const consumed = new WeakSet<ArenaMemberProposalPreview>();
  let currentPreview: ArenaMemberProposalPreview | null = null;
  const active = () => { if (state.disposed) throw new Error('Arena editor session is disposed'); };
  const commit = (editor = state.editor, disposed = state.disposed) => {
    state = freeze({ editor, generation: state.generation + 1, disposed });
    listeners.forEach(listener => listener());
  };
  const update: ArenaMemberProposalUpdate = updater => {
    active();
    const next = editWorkingConfig(state.editor, updater);
    if (!same(next, state.editor)) commit(next);
  };
  const current = (preview: ArenaMemberProposalPreview) => !state.disposed && currentPreview === preview && previews.has(preview)
    && !consumed.has(preview) && preview.generation === state.generation && !state.editor.replacementRequired;
  const assertCurrent = (preview: ArenaMemberProposalPreview) => {
    if (!current(preview)) throw new Error('提案预览已失效，请重新预览');
  };
  const select = (preview: ArenaMemberProposalPreview, ids: readonly string[]): ArenaMemberProposalPreview => {
    assertCurrent(preview);
    const validation = validateProposalChanges(preview.changes, ids);
    const selected = new Set(ids);
    const next = freeze({ ...preview, selectedChangeIds: [...ids], issues: clone(validation.issues),
      intent: validation.valid && selected.size > 0 ? {
        proposalId: preview.proposalId, expectedRoomEpoch: preview.editor.baselineEpoch,
        baseRevision: preview.editor.baselineRevision,
        changes: clone(preview.changes.filter(change => selected.has(change.changeId))),
      } : null,
    });
    // A new selection supersedes the previous confirmation, even if it later returns to the same IDs.
    consumed.add(preview);
    previews.add(next);
    currentPreview = next;
    return next;
  };
  return Object.freeze({
    store: Object.freeze({ getState: () => state, getInitialState: () => initial,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } }),
    actions: createArenaMemberProposalActions(update), update,
    sync(incoming: ArenaProposalEditorSnapshot) {
      active();
      const authority = createArenaProposalEditor(incoming);
      const next = syncArenaProposalEditor(state.editor, incoming);
      const sameScope = authority.roomId === observed.roomId && authority.baselineEpoch === observed.baselineEpoch;
      if (sameScope && authority.baselineRevision === observed.baselineRevision && !same(authority.baselineConfig, observed.baselineConfig)) {
        throw new ArenaProposalEditorError('revision-inconsistent', '同一房间配置版本不能对应不同的共享配置');
      }
      const observe = !sameScope || authority.baselineRevision >= observed.baselineRevision;
      const authorityChanged = observe && !same(authority, observed);
      if (observe) observed = authority;
      if (authorityChanged || !same(next, state.editor)) commit(next);
    },
    replace(incoming: ArenaProposalEditorSnapshot) {
      active();
      const next = resetArenaProposalEditor(incoming);
      observed = next;
      if (!same(next, state.editor)) commit(next);
    },
    exportSharedConfig() { active(); return clone(state.editor.workingConfig); },
    preparePreview(proposalId: string) {
      active();
      if (ArenaProposalIdSchema.parse(proposalId) !== proposalId) throw new Error('提案标识无效');
      const result = previewArenaProposal(state.editor);
      const preview: ArenaMemberProposalPreview = freeze({ generation: state.generation, proposalId,
        editor: clone(state.editor), changes: result.changes, selectedChangeIds: result.selectedChangeIds, issues: [], intent: null });
      previews.add(preview);
      currentPreview = preview;
      return select(preview, result.selectedChangeIds);
    },
    selectPreview: select, isPreviewCurrent: current, assertPreviewCurrent: assertCurrent,
    takePreviewIntent(preview: ArenaMemberProposalPreview) {
      assertCurrent(preview);
      if (!preview.intent) throw new Error('所选变更缺少依赖或拆分了联动变更组');
      consumed.add(preview);
      return preview.intent;
    },
    invalidatePreview() { active(); commit(); },
    dismissPreview() { currentPreview = null; },
    dispose() { if (!state.disposed) commit(state.editor, true); },
  });
}
