import { createStore } from 'zustand/vanilla';
import { createArenaMemberProposalModel } from '@mahoshojo/multiplayer-core/member-proposal';
import { buildArenaProposalSubmitIntent, previewArenaProposal } from '@mahoshojo/multiplayer-core';
import { isBuiltinWebPackageRef } from '@mahoshojo/web-package';
import { cloneArenaEditorSharedConfig, mapSharedConfigToArenaEditorView } from './shared-config-mapper';
import type { ArenaEditorActions, ArenaEditorCapabilities, ArenaEditorState, ArenaProposalEditorSnapshotInput, RoomProposalArenaEditorSession } from './types';

export const ROOM_PROPOSAL_ARENA_EDITOR_CAPABILITIES: ArenaEditorCapabilities = Object.freeze({
  canUploadLocalPayload: false,
  canPasteLocalPayload: false,
  canBrowsePrivateCards: false,
  canAddPresetRefs: true,
  canEditSharedConfig: true,
  canPublishRoomConfig: false,
  canStartGeneration: false,
  canPersistCharacterUpdate: false,
  canUseHostOnlyGenerationOptions: false,
});

/** Web compatibility bridge; the detached member model owns all working-copy mutations. */
export const createRoomProposalArenaEditorSession = (snapshot: ArenaProposalEditorSnapshotInput): RoomProposalArenaEditorSession => {
  const memberModel = createArenaMemberProposalModel(snapshot);
  const actions: ArenaEditorActions = Object.freeze({
    ...memberModel.actions,
    setWebPackageRef: value => memberModel.actions.setWebPackageRef(value && isBuiltinWebPackageRef(value) ? value : null),
  });
  const buildState = (): ArenaEditorState => {
    const { editor, disposed } = memberModel.store.getState();
    return Object.freeze({ mode: 'room-proposal', ...mapSharedConfigToArenaEditorView(editor.workingConfig),
      roomId: editor.roomId, baselineEpoch: editor.baselineEpoch, baselineRevision: editor.baselineRevision,
      baselineConfig: cloneArenaEditorSharedConfig(editor.baselineConfig), dirty: editor.dirty, stale: editor.stale,
      replacementRequired: editor.replacementRequired, workspaceStatus: null, disposed, actions });
  };
  const store = createStore<ArenaEditorState>()(() => buildState());
  const unsubscribe = memberModel.store.subscribe(() => store.setState(buildState(), true));
  const assertActive = () => { if (memberModel.store.getState().disposed) throw new Error('Arena editor session is disposed'); };
  return Object.freeze({ mode: 'room-proposal', capabilities: ROOM_PROPOSAL_ARENA_EDITOR_CAPABILITIES,
    memberModel, store, update: memberModel.update, sync: memberModel.sync, replace: memberModel.replace,
    exportSharedConfig: memberModel.exportSharedConfig,
    preview(selectedChangeIds) { assertActive(); return previewArenaProposal(memberModel.store.getState().editor, selectedChangeIds); },
    buildSubmitIntent(proposalId, selectedChangeIds) { assertActive(); return buildArenaProposalSubmitIntent(memberModel.store.getState().editor, proposalId, selectedChangeIds); },
    dispose() { memberModel.dispose(); unsubscribe(); },
  });
};
