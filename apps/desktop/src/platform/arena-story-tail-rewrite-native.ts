import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { encodeStoryTailRewriteManifest, decodeStoryTailRewriteReceipt } from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import { createIpcStoryNativePort, type StoryInvoke } from './arena-story-native';
import type { StoryTailRewriteNativePort } from './arena-story-tail-rewrite-storage';
import type { StoryTailRewriteSourcePort } from './arena-story-tail-rewrite-source';

/** Independent v3 wire. Registration does not activate schema 11 or a page entry. */
export const STORY_TAIL_REWRITE_IPC = {
  begin: 'begin_arena_story_tail_rewrite_commit',
  end: 'end_arena_story_tail_rewrite_commit',
  receipt: 'query_arena_story_tail_rewrite_receipt',
  resolveSource: 'resolve_arena_story_tail_rewrite_source',
} as const;
const receipt = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('尾章重写回执不是原始 JSON 文本');
  try { return decodeStoryTailRewriteReceipt(value); }
  catch { throw new Error('尾章重写回执格式无效，请重新查询原操作'); }
};

/** Keep the canonical frozen package as text so Native sees byte length and
 * duplicate keys before parsing. Shared raw frames and abort remain unchanged. */
export const createIpcStoryTailRewriteNativePort = (invoke: StoryInvoke = tauriInvoke): StoryTailRewriteNativePort => {
  const shared = createIpcStoryNativePort(invoke);
  return {
    begin: (manifest) => invoke(STORY_TAIL_REWRITE_IPC.begin, { manifestJson: encodeStoryTailRewriteManifest(manifest) }),
    append: shared.append,
    end: async (token) => receipt(await invoke(STORY_TAIL_REWRITE_IPC.end, { token })),
    abort: shared.abort,
    receipt: async (sessionId, operationId, requestDigest) => {
      const value = await invoke(STORY_TAIL_REWRITE_IPC.receipt, { sessionId, operationId, requestDigest });
      return value === null ? null : receipt(value);
    },
  };
};
export const createIpcStoryTailRewriteSourcePort = (invoke: StoryInvoke = tauriInvoke): StoryTailRewriteSourcePort => ({
  resolveSource: (request) => invoke(STORY_TAIL_REWRITE_IPC.resolveSource, { request }),
});
