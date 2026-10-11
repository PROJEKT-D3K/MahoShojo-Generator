import {
  STORY_CANDIDATE_COMMIT_BYTES, STORY_CANDIDATE_FRAME_BYTES,
  StoryBeginOutcomeSchema, StoryAppendOutcomeSchema, StoryNativeFailureSchema,
  StorySessionDocumentSchema, StoryChapterDocumentSchema, StoryCheckpointDocumentSchema,
  type StoryPartKind,
} from '@mahoshojo/contracts/desktop-arena-story';
import {
  StoryBranchSourceSchema, StoryBranchManifestSchema, StoryBranchReceiptSchema,
  encodeStoryBranchRequestPreimage, encodeStoryBranchReceipt,
  type StoryBranchSource, type StoryBranchManifest, type StoryBranchReceipt,
} from '@mahoshojo/contracts/desktop-arena-story-branch';
import {
  createBattleStoryByteDigest, prepareBattleStoryCommitJson, freezeBattleStoryCommit,
  digestBattleStoryCommitValue, advanceBattleStorySaveEvidence, BattleStoryCommitByteLimitError,
  type BattleStoryCommitSession, type BattleStoryCommitChapter, type BattleStoryCommitCheckpoint,
  type BattleStorySaveEvidence,
} from '@mahoshojo/domain/arena-story-commit';
import { StorySaveError, storyTitlePreview, storySourceWithoutSecrets } from './arena-story-storage';

/** Deliberately separate from the v1 port; branch commands never widen its ABI. */
export interface StoryBranchNativePort {
  begin(manifest: StoryBranchManifest): Promise<unknown>;
  append(token: string, kind: StoryPartKind, offset: number, bytes: Uint8Array): Promise<unknown>;
  end(token: string): Promise<unknown>;
  abort(token: string): Promise<void>;
  receipt(sessionId: string, operationId: string, requestDigest: string): Promise<unknown>;
}
const encoder = new TextEncoder();
export const branchCopyId = (sessionId: string, kind: 'c' | 'p', index: number): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) || !['c', 'p'].includes(kind)
    || !Number.isSafeInteger(index) || index < (kind === 'c' ? 1 : 0)) throw new RangeError('Invalid branch copy identity');
  const numbers = new Uint8Array(16), view = new DataView(numbers.buffer);
  view.setBigUint64(0, BigInt(index), false);
  view.setBigUint64(8, BigInt(encoder.encode(sessionId).byteLength), false);
  const hash = createBattleStoryByteDigest();
  hash.update(encoder.encode(`maho:arena-story-branch-record:v1\0${kind}`));
  hash.update(numbers); hash.update(encoder.encode(sessionId));
  return `branch_${hash.digest().slice(7)}`;
};

declare const identityBrand: unique symbol;
export type FrozenStoryBranchIdentity = Readonly<{
  operationId: string; sessionId: string; source: StoryBranchSource;
  [identityBrand]: true;
}>;
const identities = new WeakSet<object>();
const consumed = new WeakSet<object>();
/** The controlled producer calls this BEFORE generation. No describe/refresh exists
 * in this seam. Only the bounded identity is copied; completion transfers its owned graph. */
export const freezeStoryBranchIdentity = (input: {
  operationId: string; sessionId: string; source: StoryBranchSource;
}): FrozenStoryBranchIdentity => {
  const source = StoryBranchSourceSchema.parse(input.source);
  if (![input.operationId, input.sessionId].every(id => /^[A-Za-z0-9_-]{1,128}$/u.test(id))
    || input.sessionId === source.session.sessionId) throw new Error('分支目标身份无效');
  const frozen = freezeBattleStoryCommit({ operationId: input.operationId, sessionId: input.sessionId, source }) as FrozenStoryBranchIdentity;
  identities.add(frozen); return frozen;
};
export type CompletedStoryBranchRecords = {
  session: BattleStoryCommitSession & { branchOf?: unknown }; chapter: BattleStoryCommitChapter<unknown>; checkpoints: BattleStoryCommitCheckpoint[];
};
export type PreparedStoryBranchCommit = Readonly<{
  manifest: StoryBranchManifest; requestDigest: string; byteLength: number;
  parts: ReadonlyArray<Readonly<{ kind: 'session' | 'chapter' | 'checkpoint1'; prepared: ReturnType<typeof prepareBattleStoryCommitJson> }>>;
}>;
/** One identity may prepare exactly once, even after validation failure. Retrying a
 * write uses the returned frozen handle, never new descriptors or reconstructed output. */
export const prepareStoryBranchCommit = (
  identity: FrozenStoryBranchIdentity, records: CompletedStoryBranchRecords,
  maxBytes = STORY_CANDIDATE_COMMIT_BYTES,
): PreparedStoryBranchCommit => {
  if (!identities.has(identity) || consumed.has(identity)) throw new Error('分支生成身份已使用或未预先冻结');
  consumed.add(identity);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > STORY_CANDIDATE_COMMIT_BYTES) throw new Error('无效的候选保存预算');
  const { session, chapter, checkpoints } = records;
  const anchor = identity.source.anchorIndex, output = checkpoints[0];
  const branchOf = session.branchOf as { sessionId?: unknown; chapterId?: unknown; chapterIndex?: unknown } | undefined;
  if (session.id !== identity.sessionId || chapter.id !== identity.operationId || chapter.sessionId !== session.id
    || session.lastChapterId !== chapter.id || session.chapterCount !== anchor + 1 || chapter.index !== anchor + 1
    || chapter.action !== 'branch' || chapter.status !== 'active'
    || chapter.sourceChapterId !== branchCopyId(session.id, 'c', anchor)
    || checkpoints.length !== 1 || !output || output.sessionId !== session.id
    || output.boundaryIndex !== anchor + 1 || output.chapterId !== chapter.id
    || branchOf?.sessionId !== identity.source.session.sessionId || branchOf.chapterId !== identity.source.anchor.recordId
    || branchOf.chapterIndex !== anchor) throw new Error('完成分支与生成前冻结身份不一致');
  const { seed: _seed, workingCombatants, lastChapterInputCombatants: _input, ...rest } = session;
  void _seed; void _input;
  const source = storySourceWithoutSecrets(session.source);
  const values = [
    ['session', { ...rest, source, revision: anchor + 1, ...storyTitlePreview(session.title), mode: source.mode,
      workingCheckpointId: output.id, lastInputCheckpointId: branchCopyId(session.id, 'p', anchor) }],
    ['chapter', { ...chapter, ...storyTitlePreview(chapter.title), markdownByteLength: encoder.encode(chapter.markdown).byteLength }],
    ['checkpoint1', output],
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
  if (digestBattleStoryCommitValue(workingCombatants) !== digestBattleStoryCommitValue(output.combatants)) throw new Error('故事角色检查点不一致');
  for (const part of parts) (part.kind === 'session' ? StorySessionDocumentSchema
    : part.kind === 'chapter' ? StoryChapterDocumentSchema : StoryCheckpointDocumentSchema).parse(part.prepared.value);
  const manifest = StoryBranchManifestSchema.parse({ version: 2, ...identity,
    parts: parts.map(({ kind, prepared }) => ({ kind, byteLength: prepared.byteLength, digest: prepared.contentDigest })),
  });
  const hash = createBattleStoryByteDigest(); hash.update(encodeStoryBranchRequestPreimage(manifest));
  return freezeBattleStoryCommit({ manifest, requestDigest: hash.digest(), byteLength, parts });
};
const exactReceipt = (value: unknown, commit: PreparedStoryBranchCommit): StoryBranchReceipt => {
  const receipt = StoryBranchReceiptSchema.parse(value);
  encodeStoryBranchReceipt(receipt);
  const { manifest } = commit, anchor = manifest.source.anchorIndex;
  const output = commit.parts[2]!.prepared.value as { id: string };
  if (receipt.sessionId !== manifest.sessionId || receipt.operationId !== manifest.operationId
    || receipt.requestDigest !== commit.requestDigest || receipt.prefixEndIndex !== anchor
    || receipt.anchorChapterId !== branchCopyId(manifest.sessionId, 'c', anchor)
    || receipt.anchorCheckpointId !== branchCopyId(manifest.sessionId, 'p', anchor)
    || receipt.checkpointId !== output.id) throw new Error('保存回执与原分支提交不一致');
  return receipt;
};
export const queryStoryBranchReceipt = async (port: StoryBranchNativePort, commit: PreparedStoryBranchCommit): Promise<StoryBranchReceipt | null> => {
  const value = await port.receipt(commit.manifest.sessionId, commit.manifest.operationId, commit.requestDigest);
  return value === null ? null : exactReceipt(value, commit);
};
/** The abort signal fences only pre-end dispatch. Once end was dispatched,
 * cancellation is not evidence of rollback; exact success still wins. */
export const savePreparedStoryBranchCommit = async (
  port: StoryBranchNativePort, commit: PreparedStoryBranchCommit,
  previousEvidence: BattleStorySaveEvidence = 'not-written', signal?: AbortSignal,
): Promise<StoryBranchReceipt> => {
  let token: string | undefined, endAttempted = false;
  try {
    const existing = await queryStoryBranchReceipt(port, commit);
    if (existing) return existing;
    if (previousEvidence === 'unknown') throw new StorySaveError('原分支保存仍待确认，只能查询原回执', 'unknown');
    signal?.throwIfAborted();
    const begun = StoryBeginOutcomeSchema.parse(await port.begin(commit.manifest)); token = begun.token;
    if (begun.totalBytes !== commit.byteLength) throw new Error('暂存长度声明不一致');
    for (const { kind, prepared } of commit.parts) {
      let offset = 0;
      for (const bytes of prepared.chunks(STORY_CANDIDATE_FRAME_BYTES)) {
        signal?.throwIfAborted();
        const appended = StoryAppendOutcomeSchema.parse(await port.append(token, kind, offset, bytes));
        offset += bytes.byteLength;
        if (appended.token !== token || appended.kind !== kind || appended.receivedBytes !== offset) throw new Error('暂存帧回执不一致');
      }
      if (offset !== prepared.byteLength) throw new Error('暂存原件长度不一致');
    }
    signal?.throwIfAborted(); endAttempted = true;
    return exactReceipt(await port.end(token), commit);
  } catch (cause) {
    const nativeFailure = StoryNativeFailureSchema.safeParse(cause);
    const knownNotWritten = nativeFailure.success && nativeFailure.data.writeEvidence === 'not-written';
    if (endAttempted) {
      try { const receipt = await queryStoryBranchReceipt(port, commit); if (receipt) return receipt; } catch { /* Preserve uncertainty. */ }
    }
    const evidence = advanceBattleStorySaveEvidence(previousEvidence, endAttempted && !knownNotWritten ? 'unknown' : 'not-written');
    throw new StorySaveError(evidence === 'unknown' ? '分支保存结果待确认，请查询原操作' : '分支尚未保存，保留原完成章后可显式重试', evidence, cause);
  } finally {
    if (token) { try { await port.abort(token); } catch { /* Cleanup never grants write authority. */ } }
  }
};
