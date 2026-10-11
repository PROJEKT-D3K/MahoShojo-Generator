import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { createIpcStoryNativePort, type StoryInvoke } from './arena-story-native';
import type { StoryBranchNativePort } from './arena-story-branch-storage';
import type { StoryBranchSourcePort } from './arena-story-branch-source';

/** Separate v2 commands. The v1 binder and Hosted protocol remain unchanged. */
export const STORY_BRANCH_IPC = {
  begin: 'begin_arena_story_branch_commit',
  end: 'end_arena_story_branch_commit',
  receipt: 'query_arena_story_branch_receipt',
  resolveAnchor: 'resolve_arena_story_branch_anchor',
} as const;

/** Transports the original frozen manifest and exact receipt identity without
 * describing source records, preparing content or acquiring fresh write authority. */
export const createIpcStoryBranchNativePort = (invoke: StoryInvoke = tauriInvoke): StoryBranchNativePort => {
  const shared = createIpcStoryNativePort(invoke);
  return {
    begin: (manifest) => invoke(STORY_BRANCH_IPC.begin, { manifest }),
    append: shared.append,
    end: (token) => invoke(STORY_BRANCH_IPC.end, { token }),
    abort: shared.abort,
    receipt: (sessionId, operationId, requestDigest) => invoke(STORY_BRANCH_IPC.receipt, { sessionId, operationId, requestDigest }),
  };
};

export const createIpcStoryBranchSourcePort = (invoke: StoryInvoke = tauriInvoke): StoryBranchSourcePort => ({
  resolveAnchor: (request) => invoke(STORY_BRANCH_IPC.resolveAnchor, { request }),
});
