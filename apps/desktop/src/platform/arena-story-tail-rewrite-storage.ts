import {
  STORY_CANDIDATE_COMMIT_BYTES, STORY_CANDIDATE_FRAME_BYTES,
  StoryBeginOutcomeSchema, StoryAppendOutcomeSchema, StoryNativeFailureSchema,
  StorySessionDocumentSchema, StoryChapterDocumentSchema, StoryCheckpointDocumentSchema, StorySessionHeadSchema,
  type StoryPartKind, type StorySessionHead,
} from '@mahoshojo/contracts/desktop-arena-story';
import {
  StoryTailRewriteSourceSchema, StoryTailRewriteManifestSchema, StoryTailRewriteReceiptSchema,
  encodeStoryTailRewriteRequestPreimage, encodeStoryTailRewriteReceipt,
  type StoryTailRewriteSource, type StoryTailRewriteManifest, type StoryTailRewriteReceipt,
} from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import {
  createBattleStoryByteDigest, prepareBattleStoryCommitJson, freezeBattleStoryCommit,
  digestBattleStoryCommitValue, advanceBattleStorySaveEvidence, BattleStoryCommitByteLimitError,
  type BattleStoryCommitSession, type BattleStoryCommitChapter, type BattleStoryCommitCheckpoint, type BattleStorySaveEvidence,
} from '@mahoshojo/domain/arena-story-commit';
import { StorySaveError, storyTitlePreview, storySourceWithoutSecrets } from './arena-story-storage';

/** Separately injected v3 capability. It does not widen the v1/v2 IPC ABI. */
export interface StoryTailRewriteNativePort {
  begin(manifest: StoryTailRewriteManifest): Promise<unknown>;
  append(token: string, kind: StoryPartKind, offset: number, bytes: Uint8Array): Promise<unknown>;
  end(token: string): Promise<unknown>;
  abort(token: string): Promise<void>;
  receipt(sessionId: string, operationId: string, requestDigest: string): Promise<unknown>;
}
declare const identityBrand: unique symbol;
export type FrozenStoryTailRewriteIdentity = Readonly<{
  operationId: string; sessionId: string; source: StoryTailRewriteSource; [identityBrand]: true;
}>;
const identities = new WeakSet<object>(), consumed = new WeakSet<object>(), preparedHandles = new WeakSet<object>();
export const isPreparedStoryTailRewriteCommit = (value: PreparedStoryTailRewriteCommit): boolean => preparedHandles.has(value);
export const freezeStoryTailRewriteIdentity = (input: {
  operationId: string; sessionId: string; source: StoryTailRewriteSource;
}): FrozenStoryTailRewriteIdentity => {
  const source = StoryTailRewriteSourceSchema.parse(input.source);
  if (![input.operationId, input.sessionId].every(id => /^[A-Za-z0-9_-]{1,128}$/u.test(id))
    || input.operationId === source.targetChapterId) throw new Error('尾章重写身份无效');
  const identity = freezeBattleStoryCommit({ operationId: input.operationId, sessionId: input.sessionId, source }) as FrozenStoryTailRewriteIdentity;
  identities.add(identity); return identity;
};
export type CompletedStoryTailRewriteRecords = {
  session: BattleStoryCommitSession; chapter: BattleStoryCommitChapter<unknown>; checkpoint: BattleStoryCommitCheckpoint;
};
export type PreparedStoryTailRewriteCommit = Readonly<{
  manifest: StoryTailRewriteManifest; requestDigest: string; byteLength: number; head: StorySessionHead;
  parts: ReadonlyArray<Readonly<{ kind: 'session' | 'chapter' | 'checkpoint1'; prepared: ReturnType<typeof prepareBattleStoryCommitJson> }>>;
}>;
/** Prepare once after full prose retention. Every retry sends this same owned graph. */
export const prepareStoryTailRewriteCommit = (identity: FrozenStoryTailRewriteIdentity, records: CompletedStoryTailRewriteRecords,
  maxBytes = STORY_CANDIDATE_COMMIT_BYTES): PreparedStoryTailRewriteCommit => {
  if (!identities.has(identity) || consumed.has(identity)) throw new Error('尾章重写身份已使用或未预先冻结');
  consumed.add(identity);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > STORY_CANDIDATE_COMMIT_BYTES) throw new Error('无效的候选保存预算');
  const { session, chapter, checkpoint } = records, sourceIdentity = identity.source, n = sourceIdentity.expectedChapterCount;
  if (session.id !== identity.sessionId || session.lastChapterId !== identity.operationId || session.chapterCount !== n
    || chapter.id !== identity.operationId || chapter.sessionId !== identity.sessionId || chapter.index !== n
    || chapter.action !== 'rewrite' || chapter.status !== 'active' || chapter.sourceChapterId !== sourceIdentity.targetChapterId
    || checkpoint.sessionId !== identity.sessionId || checkpoint.boundaryIndex !== n || checkpoint.chapterId !== chapter.id
    || checkpoint.id === sourceIdentity.inputCheckpointId || checkpoint.id === chapter.id) throw new Error('完成尾章与生成前冻结身份不一致');
  const { seed: _seed, workingCombatants, lastChapterInputCombatants: _input, ...rest } = session;
  void _seed; void _input;
  const source = storySourceWithoutSecrets(session.source);
  const values = [
    ['session', { ...rest, source, revision: sourceIdentity.expectedRevision + 1, ...storyTitlePreview(session.title), mode: source.mode,
      workingCheckpointId: checkpoint.id, lastInputCheckpointId: sourceIdentity.inputCheckpointId }],
    ['chapter', { ...chapter, ...storyTitlePreview(chapter.title), markdownByteLength: new TextEncoder().encode(chapter.markdown).byteLength }],
    ['checkpoint1', checkpoint],
  ] as const;
  let byteLength = 0;
  const parts = values.map(([kind, value]) => {
    let prepared;
    try { prepared = prepareBattleStoryCommitJson(value, maxBytes - byteLength); }
    catch (cause) {
      if (cause instanceof BattleStoryCommitByteLimitError) throw new BattleStoryCommitByteLimitError(maxBytes, byteLength + cause.observedBytes);
      throw cause;
    }
    byteLength += prepared.byteLength; return { kind, prepared };
  });
  if (digestBattleStoryCommitValue(workingCombatants) !== digestBattleStoryCommitValue(checkpoint.combatants)) throw new Error('尾章重写角色检查点不一致');
  for (const part of parts) (part.kind === 'session' ? StorySessionDocumentSchema
    : part.kind === 'chapter' ? StoryChapterDocumentSchema : StoryCheckpointDocumentSchema).parse(part.prepared.value);
  const stored = parts[0]!.prepared.value as Record<string, unknown>;
  const head = StorySessionHeadSchema.parse(Object.fromEntries(['id','revision','titlePreview','titleTruncated','mode','chapterPlan','createdAt','updatedAt','chapterCount','lastChapterId']
    .filter(key => stored[key] !== undefined).map(key => [key, stored[key]])));
  const manifest = StoryTailRewriteManifestSchema.parse({ version: 3, kind: 'tail-rewrite', ...identity,
    parts: parts.map(({ kind, prepared }) => ({ kind, byteLength: prepared.byteLength, digest: prepared.contentDigest })),
  });
  const hash = createBattleStoryByteDigest(); hash.update(encodeStoryTailRewriteRequestPreimage(manifest));
  const prepared = freezeBattleStoryCommit({ manifest, requestDigest: hash.digest(), byteLength, head, parts });
  preparedHandles.add(prepared); return prepared;
};
const exactReceipt = (value: unknown, commit: PreparedStoryTailRewriteCommit): StoryTailRewriteReceipt => {
  const receipt = StoryTailRewriteReceiptSchema.parse(value); encodeStoryTailRewriteReceipt(receipt);
  const { manifest } = commit, source = manifest.source;
  const checkpoint = commit.parts[2]!.prepared.value as { id: string };
  if (receipt.sessionId !== manifest.sessionId || receipt.operationId !== manifest.operationId
    || receipt.requestDigest !== commit.requestDigest || receipt.revision !== source.expectedRevision + 1
    || receipt.chapterCount !== source.expectedChapterCount || receipt.chapterIndex !== source.expectedChapterCount
    || receipt.targetChapterId !== source.targetChapterId || receipt.inputCheckpointId !== source.inputCheckpointId
    || receipt.checkpointId !== checkpoint.id) throw new Error('保存回执与原尾章重写提交不一致');
  return receipt;
};
export const queryStoryTailRewriteReceipt = async (port: StoryTailRewriteNativePort, commit: PreparedStoryTailRewriteCommit): Promise<StoryTailRewriteReceipt | null> => {
  const value = await port.receipt(commit.manifest.sessionId, commit.manifest.operationId, commit.requestDigest);
  return value === null ? null : exactReceipt(value, commit);
};
export const savePreparedStoryTailRewriteCommit = async (port: StoryTailRewriteNativePort, commit: PreparedStoryTailRewriteCommit,
  previousEvidence: BattleStorySaveEvidence = 'not-written', signal?: AbortSignal): Promise<StoryTailRewriteReceipt> => {
  let token: string | undefined, endAttempted = false;
  try {
    const existing = await queryStoryTailRewriteReceipt(port, commit);
    if (existing) return existing;
    if (previousEvidence === 'unknown') throw new StorySaveError('原尾章保存仍待确认，只能查询原回执', 'unknown');
    signal?.throwIfAborted();
    const begun = StoryBeginOutcomeSchema.parse(await port.begin(commit.manifest)); token = begun.token;
    if (begun.totalBytes !== commit.byteLength) throw new Error('暂存长度声明不一致');
    for (const { kind, prepared } of commit.parts) {
      let offset = 0;
      for (const bytes of prepared.chunks(STORY_CANDIDATE_FRAME_BYTES)) {
        signal?.throwIfAborted();
        const appended = StoryAppendOutcomeSchema.parse(await port.append(token, kind, offset, bytes)); offset += bytes.byteLength;
        if (appended.token !== token || appended.kind !== kind || appended.receivedBytes !== offset) throw new Error('暂存帧回执不一致');
      }
      if (offset !== prepared.byteLength) throw new Error('暂存原件长度不一致');
    }
    signal?.throwIfAborted(); endAttempted = true;
    return exactReceipt(await port.end(token), commit);
  } catch (cause) {
    const failure = StoryNativeFailureSchema.safeParse(cause), knownNotWritten = failure.success && failure.data.writeEvidence === 'not-written';
    if (endAttempted) { try { const receipt = await queryStoryTailRewriteReceipt(port, commit); if (receipt) return receipt; } catch { /* Same receipt only. */ } }
    const evidence = advanceBattleStorySaveEvidence(previousEvidence, endAttempted && !knownNotWritten ? 'unknown' : 'not-written');
    throw new StorySaveError(evidence === 'unknown' ? '尾章保存结果待确认，请查询原操作' : '尾章尚未保存，保留原完成章后可显式重试', evidence, cause);
  } finally { if (token) { try { await port.abort(token); } catch { /* Cleanup grants no write authority. */ } } }
};
