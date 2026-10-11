import {
  StoryBranchAnchorRequestSchema, StoryBranchAnchorDescriptorsSchema,
  type StoryBranchAnchorRequest,
} from '@mahoshojo/contracts/desktop-arena-story-branch';
import {
  StorySessionDocumentSchema, StorySeedDocumentSchema, StoryCheckpointDocumentSchema, StoryChapterDocumentSchema,
  type StoryChapterPage,
} from '@mahoshojo/contracts/desktop-arena-story';
import { freezeBattleStoryCommit } from '@mahoshojo/domain/arena-story-commit';
import { resolveAnchoredSummaryState, toBattleStoryRecordCombatants } from '@mahoshojo/domain/arena-story-branch';
import { projectBattleStoryPromptWindowItem, isBattleStoryChapterPlanLimitReached, type BattleStoryPromptWindowItem } from '@mahoshojo/domain/arena-battle-story-session';
import { branchCopyId } from './arena-story-branch-storage';
import { readStoryRecord, listStoryChapters, type StoryNativePort } from './arena-story-storage';

/** Separate bounded read capability. Pages must explicitly opt in through their owner. */
export interface StoryBranchSourcePort {
  resolveAnchor(request: StoryBranchAnchorRequest): Promise<unknown>;
}
const original = <T>(schema: { parse(value: unknown): T }, value: unknown): T => { schema.parse(value); return value as T; };

/** Owns fresh parsed records, releases each historical full chapter after projection.
 * No describe refresh, prefix hydration, model dispatch or save authorization. */
export async function readStoryBranchSource(port: Pick<StoryNativePort, 'read'>, resolver: StoryBranchSourcePort,
  input: StoryBranchAnchorRequest, signal?: AbortSignal) {
  const request = freezeBattleStoryCommit(StoryBranchAnchorRequestSchema.parse(input));
  signal?.throwIfAborted();
  const descriptors = StoryBranchAnchorDescriptorsSchema.parse(await resolver.resolveAnchor(request));
  signal?.throwIfAborted();
  const { source, recentChapters } = descriptors;
  if (source.session.sessionId !== request.sessionId || source.session.revision !== request.revision
    || source.expectedLastChapterId !== request.expectedLastChapterId || source.expectedChapterCount !== request.expectedChapterCount
    || source.anchor.recordId !== request.anchorChapterId || source.anchorIndex !== request.anchorIndex
    || recentChapters.length !== Math.min(12, request.anchorIndex)) throw new Error('分支源读取身份不符');
  for (const d of recentChapters) {
    if (d.instance !== source.session.instance || d.revision !== request.revision || d.sessionId !== request.sessionId) throw new Error('分支章节读取身份不符');
  }
  const last = recentChapters.at(-1)!;
  if (last.recordId !== source.anchor.recordId || last.byteLength !== source.anchor.byteLength || last.digest !== source.anchor.digest) throw new Error('分支锚点描述不符');
  const session = original(StorySessionDocumentSchema, await readStoryRecord(port, source.session, signal));
  const seed = original(StorySeedDocumentSchema, await readStoryRecord(port, source.seed, signal));
  const checkpoint = original(StoryCheckpointDocumentSchema, await readStoryRecord(port, source.checkpoint, signal));
  if (session.id !== request.sessionId || session.revision !== request.revision || session.chapterCount !== request.expectedChapterCount
    || session.lastChapterId !== request.expectedLastChapterId || checkpoint.id !== source.checkpoint.recordId
    || checkpoint.sessionId !== request.sessionId || checkpoint.boundaryIndex !== request.anchorIndex || checkpoint.chapterId !== request.anchorChapterId) throw new Error('分支源原件关系不符');
  const workingCombatants = toBattleStoryRecordCombatants(checkpoint.combatants);
  if (!workingCombatants || workingCombatants.length !== checkpoint.combatants.length || workingCombatants.some(Array.isArray)) throw new Error('分支锚点角色状态无效');
  if (isBattleStoryChapterPlanLimitReached({ chapterPlan: session.chapterPlan, completedChapterCount: request.anchorIndex })) throw new Error('分支下一章超出显式章节计划');
  const recentWindow: BattleStoryPromptWindowItem[] = [];
  let previousId: string | undefined;
  let anchor: ReturnType<typeof StoryChapterDocumentSchema.parse> | undefined;
  for (const descriptor of recentChapters) {
    const chapter = original(StoryChapterDocumentSchema, await readStoryRecord(port, descriptor, signal));
    const index = request.anchorIndex - recentChapters.length + recentWindow.length + 1;
    if (chapter.id !== descriptor.recordId || chapter.sessionId !== request.sessionId || chapter.index !== index
      || (index === 1 && (chapter.action !== 'start' || chapter.sourceChapterId != null))
      || (index > 1 && (chapter.action === 'start' || !chapter.sourceChapterId))
      || (previousId !== undefined && chapter.sourceChapterId !== previousId)
      || chapter.supersededByChapterId != null) throw new Error('分支章节原件序列不符');
    recentWindow.push(projectBattleStoryPromptWindowItem(chapter, recentWindow.length < recentChapters.length - 2 ? 'digest' : 'full', 6000));
    previousId = chapter.id;
    if (index === request.anchorIndex) anchor = chapter;
  }
  // Missing coverage metadata cannot authorize an old anchor to see a later summary.
  const meta = session.summaryMeta;
  if (meta !== undefined && (!meta || typeof meta !== 'object' || !('coveredUntilChapterIndex' in meta)
    || !Number.isSafeInteger(meta.coveredUntilChapterIndex) || (meta.coveredUntilChapterIndex as number) < 0
    || (meta.coveredUntilChapterIndex as number) > session.chapterCount || !('coveredChapterIds' in meta)
    || !Array.isArray(meta.coveredChapterIds) || meta.coveredChapterIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) || new Set(meta.coveredChapterIds).size !== meta.coveredChapterIds.length)) throw new Error('分支摘要覆盖记录无效');
  const summary = resolveAnchoredSummaryState({ sessionSummary: meta === undefined ? undefined : session.sessionSummary,
    summaryMeta: meta as { coveredUntilChapterIndex: number; coveredChapterIds: string[] } | undefined, maxCoveredChapterIndex: request.anchorIndex });
  signal?.throwIfAborted();
  return freezeBattleStoryCommit({ source, session: { ...session, ...summary }, seed, checkpoint, anchor: anchor!,
    workingCombatants, recentWindow, ...summary });
}
export type StoryBranchSourceSnapshot = Awaited<ReturnType<typeof readStoryBranchSource>>;

/** Scan bounded heads only, retaining IDs solely for the inherited summary subset.
 * Old/missing IDs keep the shared Web filter semantics. Never re-describe a source:
 * the original descriptor fences restart/restore and source changes after the scan. */
export async function readStoryBranchSummaryIds(port: StoryNativePort, snapshot: StoryBranchSourceSnapshot,
  targetSessionId: string, signal?: AbortSignal): Promise<Readonly<Record<string, string>>> {
  const head = { id: snapshot.source.session.sessionId, revision: snapshot.source.session.revision }, k = snapshot.source.anchorIndex;
  const wanted = new Set(snapshot.summaryMeta?.coveredChapterIds ?? []);
  const mapped: Array<[string, string]> = [];
  if (wanted.size) {
    let seen = 0, cursor: StoryChapterPage['nextCursor'] = null;
    while (seen < k) {
      signal?.throwIfAborted();
      const page = await listStoryChapters(port, head, cursor, Math.min(50, k - seen));
      signal?.throwIfAborted();
      if (!page.rows.length || new Set(page.rows.map(row => row.id)).size !== page.rows.length) throw new Error('分支摘要目录未前进或身份重复');
      for (const row of page.rows) {
        if (row.index !== seen + 1 || row.index > k || row.index === k && row.id !== snapshot.anchor.id) throw new Error('分支摘要目录序列不符');
        seen = row.index;
        if (wanted.delete(row.id)) mapped.push([row.id, branchCopyId(targetSessionId, 'c', row.index)]);
      }
      const last = page.rows.at(-1)!;
      if (page.nextCursor && (page.nextCursor.index !== last.index || page.nextCursor.id !== last.id)
        || seen < k && !page.nextCursor) throw new Error('分支摘要目录游标不符');
      cursor = page.nextCursor;
    }
  }
  signal?.throwIfAborted();
  // Native checks instance, revision, bytes and digest under its read lock even
  // for this one byte. This is validation of the original authority, not renewal.
  const proof = await port.read(snapshot.source.session, 0, 1);
  signal?.throwIfAborted();
  if (!(proof instanceof Uint8Array) || proof.byteLength !== 1) throw new Error('分支源封口读取不符');
  return freezeBattleStoryCommit(Object.fromEntries(mapped));
}
