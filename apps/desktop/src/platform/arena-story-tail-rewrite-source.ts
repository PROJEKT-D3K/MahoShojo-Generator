import {
  StoryTailRewriteSourceRequestSchema, StoryTailRewriteSourceDescriptorsSchema,
  type StoryTailRewriteSourceRequest,
} from '@mahoshojo/contracts/desktop-arena-story-tail-rewrite';
import {
  StorySessionDocumentSchema, StorySeedDocumentSchema, StoryCheckpointDocumentSchema, StoryChapterDocumentSchema,
  type StoryRecordDescriptor, type StorySessionDocument,
} from '@mahoshojo/contracts/desktop-arena-story';
import { freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';
import { resolveAnchoredSummaryState, toBattleStoryRecordCombatants, type BattleStoryBranchSummaryMeta } from '@mahoshojo/domain/arena-story-branch';
import { projectBattleStoryPromptWindowItem, type BattleStoryPromptWindowItem } from '@mahoshojo/domain/arena-battle-story-session';
import { readStoryRecord, storySourceWithoutSecrets, type StoryNativePort } from './arena-story-storage';

/** Read-only capability with a separate Native binder. No product UI entry point. */
export interface StoryTailRewriteSourcePort {
  resolveSource(request: StoryTailRewriteSourceRequest): Promise<unknown>;
}
const original = <T>(schema: { parse(value: unknown): T }, value: unknown): T => { schema.parse(value); return value as T; };

/** The old tail stays in the narrative window, exactly as Web rewrite does. Its
 * role output is never the generation input: that comes from the original n-1 checkpoint. */
export async function readStoryTailRewriteSource(port: Pick<StoryNativePort, 'read'>, resolver: StoryTailRewriteSourcePort,
  input: StoryTailRewriteSourceRequest, signal?: AbortSignal) {
  const request = freezeBattleStoryCommit(StoryTailRewriteSourceRequestSchema.parse(input));
  signal?.throwIfAborted();
  const { source, seed: seedDescriptor, recentChapters } = StoryTailRewriteSourceDescriptorsSchema.parse(await resolver.resolveSource(request));
  signal?.throwIfAborted();
  const n = request.expectedChapterCount;
  if (source.expectedRevision !== request.expectedRevision || source.expectedChapterCount !== n
    || source.targetChapterId !== request.targetChapterId || recentChapters.length !== Math.min(12, n)) throw new Error('尾章重写源读取身份不符');
  const descriptor = (kind: StoryRecordDescriptor['kind'], recordId: string, proof: { byteLength: number; digest: string }): StoryRecordDescriptor => ({
    instance: source.expectedInstance, sessionId: request.sessionId, revision: source.expectedRevision, kind, recordId, ...proof,
  });
  const sessionDescriptor = descriptor('session', request.sessionId, source.session);
  for (const d of [seedDescriptor, ...recentChapters]) {
    if (d.instance !== source.expectedInstance || d.revision !== request.expectedRevision || d.sessionId !== request.sessionId) throw new Error('尾章重写原件描述不符');
  }
  if (seedDescriptor.recordId !== request.sessionId || new Set(recentChapters.map(d => d.recordId)).size !== recentChapters.length) throw new Error('尾章重写原件身份重复或不符');
  const last = recentChapters.at(-1)!;
  if (last.recordId !== source.targetChapterId || last.byteLength !== source.chapter.byteLength || last.digest !== source.chapter.digest) throw new Error('尾章原件描述不符');
  const sessionValue = await readStoryRecord(port, sessionDescriptor, signal) as StorySessionDocument;
  // Validate only the known source carrier, retaining its original extension graph.
  StorySessionDocumentSchema.parse({ ...sessionValue, source: storySourceWithoutSecrets(sessionValue.source) });
  const session = sessionValue;
  const seed = original(StorySeedDocumentSchema, await readStoryRecord(port, seedDescriptor, signal));
  const checkpoint = original(StoryCheckpointDocumentSchema, await readStoryRecord(port, descriptor('checkpoint', source.inputCheckpointId, source.inputCheckpoint), signal));
  if (session.id !== request.sessionId || session.revision !== request.expectedRevision || session.chapterCount !== n
    || session.lastChapterId !== request.targetChapterId || session.lastInputCheckpointId !== source.inputCheckpointId
    || checkpoint.id !== source.inputCheckpointId || checkpoint.sessionId !== request.sessionId || checkpoint.boundaryIndex !== n - 1
    || (n === 1 ? checkpoint.chapterId != null : !checkpoint.chapterId)) throw new Error('尾章重写章前检查点关系不符');
  const workingCombatants = toBattleStoryRecordCombatants(checkpoint.combatants);
  if (!workingCombatants || workingCombatants.length !== checkpoint.combatants.length || workingCombatants.some(Array.isArray)) throw new Error('尾章重写章前角色无效');
  const recentWindow: BattleStoryPromptWindowItem[] = [];
  let target: ReturnType<typeof StoryChapterDocumentSchema.parse> | undefined;
  let previousId: string | undefined;
  for (const d of recentChapters) {
    const chapter = original(StoryChapterDocumentSchema, await readStoryRecord(port, d, signal));
    const index = n - recentChapters.length + recentWindow.length + 1;
    if (chapter.status !== 'active' || chapter.supersededByChapterId != null || chapter.id !== d.recordId
      || chapter.sessionId !== request.sessionId || chapter.index !== index
      || (chapter.action !== 'rewrite' && (index === 1 ? chapter.action !== 'start' || chapter.sourceChapterId != null
        : chapter.action === 'start' || !chapter.sourceChapterId || previousId !== undefined && chapter.sourceChapterId !== previousId))
      || (chapter.action === 'rewrite' && !chapter.sourceChapterId)) throw new Error('尾章重写章节窗口关系不符');
    if (index === n - 1 && checkpoint.chapterId !== chapter.id) throw new Error('尾章重写输入检查点不属于前章');
    recentWindow.push(projectBattleStoryPromptWindowItem(chapter, recentWindow.length < recentChapters.length - 2 ? 'digest' : 'full', 6000));
    previousId = chapter.id;
    if (index === n) target = chapter;
  }
  const meta = session.summaryMeta;
  if (meta !== undefined && (!meta || typeof meta !== 'object' || !('coveredUntilChapterIndex' in meta)
    || !Number.isSafeInteger(meta.coveredUntilChapterIndex) || (meta.coveredUntilChapterIndex as number) < 0
    || (meta.coveredUntilChapterIndex as number) > n || !('coveredChapterIds' in meta)
    || !Array.isArray(meta.coveredChapterIds) || meta.coveredChapterIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id))
    || new Set(meta.coveredChapterIds).size !== meta.coveredChapterIds.length)) throw new Error('尾章重写摘要覆盖记录无效');
  const summary = resolveAnchoredSummaryState({ sessionSummary: session.sessionSummary,
    summaryMeta: meta as BattleStoryBranchSummaryMeta | undefined, maxCoveredChapterIndex: n, invalidateWhenCoveredAtOrBeyond: true });
  signal?.throwIfAborted();
  // Validate the same original authority after the bounded reads, never refresh it.
  const proof = await port.read(sessionDescriptor, 0, 1);
  signal?.throwIfAborted();
  if (!(proof instanceof Uint8Array) || proof.byteLength !== 1) throw new Error('尾章重写源封口读取不符');
  return freezeBattleStoryCommit({ source, session, seed, checkpoint, target: target!, workingCombatants, recentWindow, ...summary });
}
export type StoryTailRewriteSourceSnapshot = Awaited<ReturnType<typeof readStoryTailRewriteSource>>;
