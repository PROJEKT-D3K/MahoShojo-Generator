import {
  STORY_CANDIDATE_FRAME_BYTES, STORY_PENDING_LIMITS,
  StoryPendingSnapshotSchema, StoryPendingManifestSchema, StoryPendingPartKindSchema,
  StoryPendingBeginOutcomeSchema, StoryPendingAppendOutcomeSchema, StoryPendingUploadSchema,
  StoryPendingSavePreparationSchema, StoryPendingInputSchema, StoryPendingAbandonRequestSchema,
  StoryPendingAbandonOutcomeSchema, StoryReceiptSchema, StoryNativeFailureSchema,
  StoryPendingExportSourceSchema, StoryPendingExportBeginSchema, StoryPendingExportAdvanceSchema,
  StoryPendingExportOutcomeSchema,
  type StoryPendingKey, type StoryPendingManifest, type StoryPendingSnapshot, type StoryPendingPartKind,
  type StoryReceipt, type StoryPendingAbandonRequest, type StoryPendingAbandonOutcome,
  type StoryPendingExportSource, type StoryPendingExportOutcome,
} from '@mahoshojo/contracts/desktop-arena-story';
import {
  createBattleStoryByteDigest, digestBattleStoryCommitValue, freezeBattleStoryCommit,
  prepareBattleStoryCommitJson,
} from '@mahoshojo/domain/arena-story-commit';
import { storyWireDigest, StorySaveError } from './arena-story-storage';
import type { StoryPendingNativePort, StoryPendingExportPort } from './arena-story-pending-native';

const same = (left: unknown, right: unknown): boolean => digestBattleStoryCommitValue(left) === digestBattleStoryCommitValue(right);
export const storyPendingKey = (manifest: StoryPendingManifest): StoryPendingKey => ({
  product: manifest.product, requestId: manifest.requestId, pendingRevision: manifest.pendingRevision,
});
const checkedSnapshot = (value: unknown): StoryPendingSnapshot => freezeBattleStoryCommit(StoryPendingSnapshotSchema.parse(value));
const exactSnapshot = (value: unknown, expected: StoryPendingSnapshot): StoryPendingSnapshot => {
  const result = checkedSnapshot(value);
  if (!same(result, expected)) throw new Error('故事候选快照已变化');
  return result;
};
export const describeStoryPending = async (port: StoryPendingNativePort, product: StoryPendingKey['product']): Promise<StoryPendingSnapshot | null> => {
  const value = await port.describe(product);
  if (value === null) return null;
  const snapshot = checkedSnapshot(value);
  if (snapshot.manifest.product !== product) throw new Error('故事候选产品不符');
  return snapshot;
};
const assertCurrent = async (port: StoryPendingNativePort, snapshot: StoryPendingSnapshot): Promise<void> => {
  exactSnapshot(await port.describe(snapshot.manifest.product), snapshot);
};

/** Each raw frame is revision/snapshot bound. Consumers must exhaust this stream
 * successfully before treating the complete part as verified or publishing a file. */
export async function* streamStoryPendingPart(
  port: StoryPendingNativePort, expected: StoryPendingSnapshot, kind: StoryPendingPartKind, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const snapshot = checkedSnapshot(expected);
  const checkedKind = StoryPendingPartKindSchema.parse(kind);
  const part = snapshot.manifest.parts.find((item) => item.kind === checkedKind);
  if (!part) throw new Error('故事候选没有指定原件');
  const key = storyPendingKey(snapshot.manifest), hash = createBattleStoryByteDigest();
  let offset = 0;
  while (offset < part.byteLength) {
    signal?.throwIfAborted(); await assertCurrent(port, snapshot);
    const length = Math.min(STORY_CANDIDATE_FRAME_BYTES, part.byteLength - offset);
    const bytes = await port.read(key, checkedKind, offset, length);
    signal?.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('故事候选读取帧长度不符');
    await assertCurrent(port, snapshot);
    hash.update(bytes); offset += bytes.byteLength;
    yield bytes;
  }
  if (offset !== part.byteLength || hash.digest() !== part.digest) throw new Error('故事候选原件长度或摘要不符');
  await assertCurrent(port, snapshot);
}
export const readStoryPendingPartText = async (
  port: StoryPendingNativePort, snapshot: StoryPendingSnapshot, kind: StoryPendingPartKind, signal?: AbortSignal,
): Promise<string> => {
  const decoder = new TextDecoder('utf-8', { fatal: true }), pieces: string[] = [];
  for await (const bytes of streamStoryPendingPart(port, snapshot, kind, signal)) pieces.push(decoder.decode(bytes, { stream: true }));
  pieces.push(decoder.decode()); return pieces.join('');
};

/** Repeatable original bytes, not a parse/serialize projection. The caller retains
 * the same source for preflight and send; both passes verify its declared digest. */
export type StoryPendingByteSource = Readonly<{
  kind: StoryPendingPartKind;
  chunks: () => Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}>;
export type PreparedStoryPendingUpload = Readonly<{
  manifest: StoryPendingManifest; parts: readonly StoryPendingByteSource[]; byteLength: number;
}>;
/** Use only for a newly captured owned JSON graph. Existing JSON originals retain
 * their original byte source, including whitespace, unknown extensions and Unicode. */
export const prepareStoryPendingJsonSource = (kind: StoryPendingPartKind, value: unknown, maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STORY_PENDING_LIMITS.slotBytes) throw new Error('故事候选字节预算无效');
  const prepared = prepareBattleStoryCommitJson(value, maxBytes);
  return { part: { kind, byteLength: prepared.byteLength, digest: prepared.contentDigest },
    source: { kind, chunks: () => prepared.chunks(STORY_CANDIDATE_FRAME_BYTES) } satisfies StoryPendingByteSource };
};
async function* checkedSource(part: StoryPendingManifest['parts'][number], source: StoryPendingByteSource): AsyncGenerator<Uint8Array> {
  const hash = createBattleStoryByteDigest(); let size = 0;
  for await (const bytes of source.chunks()) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > STORY_CANDIDATE_FRAME_BYTES) throw new Error('故事候选上传帧超限');
    size += bytes.byteLength;
    if (size > part.byteLength) throw new Error('故事候选上传原件超出声明');
    hash.update(bytes); yield bytes;
  }
  if (size !== part.byteLength || hash.digest() !== part.digest) throw new Error('故事候选上传原件长度或摘要不符');
}
export const prepareStoryPendingUpload = async (
  input: StoryPendingManifest, sources: readonly StoryPendingByteSource[],
): Promise<PreparedStoryPendingUpload> => {
  const manifest = freezeBattleStoryCommit(StoryPendingManifestSchema.parse(input));
  if (sources.length !== manifest.parts.length || sources.some((part, i) => part.kind !== manifest.parts[i]?.kind)) throw new Error('故事候选上传原件序列不符');
  const parts = sources.map((source) => Object.freeze({ kind: source.kind, chunks: source.chunks }));
  for (const [i, part] of manifest.parts.entries()) for await (const bytes of checkedSource(part, parts[i]!)) { void bytes; /* bounded byte/hash preflight */ }
  return Object.freeze({ manifest, parts: Object.freeze(parts), byteLength: manifest.parts.reduce((total, part) => total + part.byteLength, 0) });
};

const assertReplacement = (previous: StoryPendingSnapshot | null, next: StoryPendingManifest): void => {
  if (!previous) {
    if (next.pendingRevision !== 1) throw new Error('故事候选初始版本不符');
    return;
  }
  const old = previous.manifest;
  if (previous.restored || previous.abandonRequested || previous.saveAttemptId !== null || old.commitManifest !== null) throw new Error('故事候选仅允许读取和查询回执');
  const fields = ['product', 'requestId', 'actor', 'sessionId', 'operationId', 'outputCheckpointId', 'initialCheckpointId',
    'createdAt', 'expectedRevision', 'expectedLastChapterId', 'lastInputCheckpointId', 'inputDigest', 'writeOptions'] as const;
  if (next.pendingRevision !== old.pendingRevision + 1 || fields.some((key) => !same(old[key], next[key]))
    || (old.modelCompleted && !next.modelCompleted)
    || (old.roleInputDigest !== null && old.roleInputDigest !== next.roleInputDigest)
    || (old.roleState === 'unresolved' && next.roleState === 'not-requested')
    || ((old.roleState === 'accepted' || old.roleState === 'old-roles') && next.roleState !== old.roleState)
    || old.parts.some((part) => !next.parts.some((candidate) => same(part, candidate)))) throw new Error('故事候选替换改变了原身份或不可变原件');
};
export class StoryPendingPublishError extends Error {
  constructor(readonly phase: 'begin' | 'append' | 'seal', readonly cause?: unknown) {
    super('故事候选封存尚未证实，请保留原件；此结果不允许重新生成或角色同步'); this.name = 'StoryPendingPublishError';
  }
}
const bufferedKinds = new Set<StoryPendingPartKind>(['input', 'meta', 'header', 'roleResponse', 'telemetry']);
/** Bounded local recovery only: begin twice at most, one query after an uncertain
 * append/seal, and at most one exact seal replay. No model/role/save dependency. */
export const publishStoryPending = async (
  port: StoryPendingNativePort, prepared: PreparedStoryPendingUpload, previous: StoryPendingSnapshot | null,
  signal?: AbortSignal,
): Promise<StoryPendingSnapshot> => {
  const manifest = freezeBattleStoryCommit(StoryPendingManifestSchema.parse(prepared.manifest));
  previous = previous === null ? null : checkedSnapshot(previous);
  if (prepared.parts.length !== manifest.parts.length || prepared.parts.some((part, i) => part.kind !== manifest.parts[i]?.kind)
    || prepared.byteLength !== manifest.parts.reduce((total, part) => total + part.byteLength, 0)) throw new Error('故事候选上传预检不符');
  if (manifest.roleState === 'old-roles' && !manifest.commitManifest) throw new Error('保留旧角色的决定必须与冻结提交一并封存');
  assertReplacement(previous, manifest);
  const current = await describeStoryPending(port, manifest.product);
  if (current && same(current.manifest, manifest)) {
    if (current.restored || current.abandonRequested || current.saveAttemptId !== null) throw new Error('故事候选仅允许读取和查询回执');
    return current;
  }
  if (!same(current, previous)) throw new Error('故事候选上传基线已变化');
  let token: string | undefined, phase: 'begin' | 'append' | 'seal' = 'begin';
  const query = async () => {
    const upload = StoryPendingUploadSchema.parse(await port.queryUpload(token!));
    if (upload.token !== token || !same(upload.manifest, manifest)) throw new Error('故事候选上传查询身份不符');
    return upload;
  };
  const sealed = (value: unknown) => {
    const result = checkedSnapshot(value);
    if (!same(result.manifest, manifest) || result.restored || result.abandonRequested || result.saveAttemptId !== null
      || !same(result.createClaim, previous?.createClaim ?? null)) throw new Error('故事候选封存回执不符');
    return result;
  };
  try {
    signal?.throwIfAborted();
    let begun: unknown;
    try { begun = await port.begin(manifest); }
    catch (cause) {
      if (StoryNativeFailureSchema.safeParse(cause).success) throw cause;
      signal?.throwIfAborted(); begun = await port.begin(manifest);
    }
    const result = StoryPendingBeginOutcomeSchema.parse(begun); token = result.token;
    if (result.totalBytes !== prepared.byteLength) throw new Error('故事候选上传声明回执不符');
    const upload = await query(); phase = 'append';
    for (const [index, part] of manifest.parts.entries()) {
      let offset = 0, known = upload.receivedBytes[index]!.receivedBytes;
      for await (const bytes of checkedSource(part, prepared.parts[index]!)) {
        signal?.throwIfAborted(); const end = offset + bytes.byteLength;
        if (end <= known) { offset = end; continue; }
        if (offset < known) throw new Error('故事候选上传查询位置不是原帧边界');
        try {
          const receipt = StoryPendingAppendOutcomeSchema.parse(await port.append(token, part.kind, offset, bytes));
          if (receipt.token !== token || receipt.kind !== part.kind || receipt.receivedBytes !== end) throw new Error('故事候选上传帧回执不符');
        } catch (cause) {
          // A buffered JSON carrier can report durable zero after an accepted
          // in-memory prefix. Zero is never permission to rewind/replay that prefix.
          const recovered = await query();
          const received = recovered.receivedBytes[index]!.receivedBytes;
          if (received !== end || (bufferedKinds.has(part.kind) && end !== part.byteLength)) throw cause;
          for (let i = 0; i < recovered.receivedBytes.length; i += 1) {
            const expected = i < index ? manifest.parts[i]!.byteLength : i === index ? end : upload.receivedBytes[i]!.receivedBytes;
            if (recovered.receivedBytes[i]!.receivedBytes !== expected) throw new Error('故事候选上传恢复位置不符');
          }
        }
        known = end; offset = end;
      }
    }
    phase = 'seal'; signal?.throwIfAborted();
    try { return sealed(await port.seal(token)); }
    catch (cause) {
      const active = await describeStoryPending(port, manifest.product);
      if (active && same(active.manifest, manifest)) return sealed(active);
      if (!same(active, previous)) throw cause;
      const pending = await query();
      if (pending.receivedBytes.some((part, i) => part.receivedBytes !== manifest.parts[i]!.byteLength)) throw cause;
      signal?.throwIfAborted(); return sealed(await port.seal(token));
    }
  } catch (cause) { throw new StoryPendingPublishError(phase, cause); }
  // An unresolved upload is retained for inspection, never automatically aborted.
};

export type StoryPendingReceiptExpectation = Readonly<StoryReceipt>;
export const prepareStoryPendingReceiptExpectation = async (
  snapshot: StoryPendingSnapshot, chapterIndex: number,
): Promise<StoryPendingReceiptExpectation> => {
  const { manifest } = checkedSnapshot(snapshot);
  if (!manifest.commitManifest) throw new Error('故事候选尚未冻结提交');
  return freezeBattleStoryCommit(StoryReceiptSchema.parse({ version: 1, sessionId: manifest.sessionId,
    operationId: manifest.operationId, chapterId: manifest.operationId, chapterIndex, chapterCount: chapterIndex,
    revision: manifest.expectedRevision + 1,
    checkpointIds: manifest.initialCheckpointId === null ? [manifest.outputCheckpointId] : [manifest.initialCheckpointId, manifest.outputCheckpointId],
    wireDigest: await storyWireDigest(manifest.commitManifest),
  }));
};
const exactReceipt = (value: unknown, expected: StoryPendingReceiptExpectation): StoryReceipt => {
  const receipt = StoryReceiptSchema.parse(value);
  if (!same(receipt, expected)) throw new Error('故事候选保存回执与原提交不一致');
  return receipt;
};
export const queryStoryPendingReceipt = async (
  port: Pick<StoryPendingNativePort, 'receipt'>, expected: StoryPendingReceiptExpectation,
): Promise<StoryReceipt | null> => {
  StoryReceiptSchema.parse(expected);
  const value = await port.receipt(expected.sessionId, expected.operationId);
  return value === null ? null : exactReceipt(value, expected);
};

/** One live action owns one durable save attempt. Repeated clicks share the exact
 * Promise; unknown prepare/save results never expose a resend or alternate-ID API.
 * A restored/attempted/abandoning snapshot has only the receipt path. */
export const createStoryPendingSaveAttempt = async (
  port: StoryPendingNativePort, original: StoryPendingSnapshot, chapterIndex: number,
) => {
  const snapshot = checkedSnapshot(original), key = storyPendingKey(snapshot.manifest);
  const expected = await prepareStoryPendingReceiptExpectation(snapshot, chapterIndex);
  const queryReceipt = () => queryStoryPendingReceipt(port, expected);
  let promise: Promise<StoryReceipt> | undefined;
  const save = async (): Promise<StoryReceipt> => {
    const receipt = await queryReceipt(); if (receipt) return receipt;
    if (snapshot.restored || snapshot.abandonRequested || snapshot.saveAttemptId !== null) throw new StorySaveError('原候选只允许查询保存回执', 'unknown');
    await assertCurrent(port, snapshot);
    // Check chapter identity against exact hashed input, not a mutable UI index.
    const input = JSON.parse(await readStoryPendingPartText(port, snapshot, 'input')) as unknown;
    const checked = StoryPendingInputSchema.parse(input);
    if (checked.chapterIndex !== chapterIndex || checked.sessionId !== snapshot.manifest.sessionId
      || checked.generationRequestId !== snapshot.manifest.requestId) throw new Error('故事候选输入与保存身份不符');
    let saveInvoked = false;
    try {
      const prepared = StoryPendingSavePreparationSchema.parse(await port.prepareSave(key, expected.wireDigest));
      const durable = checkedSnapshot(await port.describe(key.product));
      if (!same(durable, { ...snapshot, saveAttemptId: prepared.attemptId })) throw new Error('故事候选保存尝试回执不符');
      saveInvoked = true;
      return exactReceipt(await port.save(key, expected.wireDigest, prepared.attemptId), expected);
    } catch (cause) {
      try { const found = await queryReceipt(); if (found) return found; } catch { /* keep original uncertainty */ }
      const failure = StoryNativeFailureSchema.safeParse(cause);
      let rolledBack = false;
      if (saveInvoked && failure.success && failure.data.writeEvidence === 'not-written') {
        try { exactSnapshot(await port.describe(key.product), snapshot); rolledBack = true; } catch { /* an attempt may still be durable */ }
      }
      throw new StorySaveError(rolledBack ? '本次保存已回滚，保留原候选' : '保存结果待确认，只能查询原操作回执', rolledBack ? 'not-written' : 'unknown', cause);
    }
  };
  return Object.freeze({ expected, queryReceipt, saveOnce: (): Promise<StoryReceipt> => { promise ??= save(); return promise; } });
};

/** Explicit local exit only. No automatic retry, remote cancellation or save retry. */
export const abandonStoryPending = async (
  port: Pick<StoryPendingNativePort, 'abandon'>, request: StoryPendingAbandonRequest,
): Promise<StoryPendingAbandonOutcome> => {
  const checked = StoryPendingAbandonRequestSchema.parse(request);
  const result = StoryPendingAbandonOutcomeSchema.parse(await port.abandon(checked));
  if (!same(result.key, checked.key) || result.inputDigest !== checked.inputDigest || !same(result.actor, checked.actor)) throw new Error('故事候选放弃回执身份不符');
  return result;
};

export type StoryPendingExportProgress = Readonly<{ kind: StoryPendingPartKind | 'manifest'; bytes: number; totalBytes: number }>;
/** Native-to-file bounded copying; only a fully checked end receipt means success. */
export const exportStoryPendingOriginal = async (
  sink: StoryPendingExportPort, input: StoryPendingExportSource,
  options: { signal?: AbortSignal; onProgress?: (progress: StoryPendingExportProgress) => void } = {},
): Promise<StoryPendingExportOutcome> => {
  const source = StoryPendingExportSourceSchema.parse(input), { signal, onProgress } = options;
  let token: string | undefined;
  try {
    signal?.throwIfAborted();
    const begun = StoryPendingExportBeginSchema.parse(await sink.begin(source)); token = begun.token;
    if (source.scope === 'pending-part' ? begun.expectedByteLength !== source.byteLength || begun.digest !== source.digest
      : begun.expectedByteLength > STORY_PENDING_LIMITS.metadataBytes) throw new Error('故事候选导出声明回执不符');
    let offset = 0;
    const progress = () => onProgress?.({ kind: source.scope === 'pending-part' ? source.kind : 'manifest', bytes: offset, totalBytes: begun.expectedByteLength });
    progress();
    while (offset < begun.expectedByteLength) {
      signal?.throwIfAborted();
      const frame = StoryPendingExportAdvanceSchema.parse(await sink.advance(token, offset));
      if (frame.token !== token || frame.receivedBytes <= offset || frame.receivedBytes > Math.min(offset + 64 * 1024, begun.expectedByteLength)) throw new Error('故事候选导出帧回执不符');
      offset = frame.receivedBytes; progress();
    }
    signal?.throwIfAborted();
    const result = StoryPendingExportOutcomeSchema.parse(await sink.end(token));
    if (result.token !== token || result.byteLength !== begun.expectedByteLength || result.digest !== begun.digest) throw new Error('故事候选导出完成回执不符');
    return result;
  } finally {
    if (token) try { await sink.abort(token); } catch { /* Native idle expiry reclaims unpublished files */ }
  }
};
export const exportAllStoryPendingOriginals = async (
  port: StoryPendingNativePort, sink: StoryPendingExportPort, original: StoryPendingSnapshot,
  options: { signal?: AbortSignal; onProgress?: (progress: StoryPendingExportProgress) => void;
    onExported?: (kind: StoryPendingPartKind | 'manifest', receipt: StoryPendingExportOutcome) => void } = {},
): Promise<ReadonlyArray<StoryPendingExportOutcome>> => {
  const snapshot = checkedSnapshot(original), key = storyPendingKey(snapshot.manifest), receipts: StoryPendingExportOutcome[] = [];
  const sources: StoryPendingExportSource[] = snapshot.manifest.parts.map((part) => ({ scope: 'pending-part', key,
    inputDigest: snapshot.manifest.inputDigest, ...part }));
  sources.push({ scope: 'pending-manifest', key, inputDigest: snapshot.manifest.inputDigest });
  for (const source of sources) {
    options.signal?.throwIfAborted(); await assertCurrent(port, snapshot);
    const receipt = await exportStoryPendingOriginal(sink, source, options);
    receipts.push(receipt); options.onExported?.(source.scope === 'pending-part' ? source.kind : 'manifest', receipt);
    await assertCurrent(port, snapshot);
  }
  return Object.freeze(receipts);
};
