import { withFixtureStreamReceipt } from './stream-receipt-fixture';
/** Synthetic model transport and small canonical source records. The producer and
 * storage adapters are production code; this file does not claim real model IO. */
import { randomUUID } from 'node:crypto';
import type { AiExecutionRequest, AiExecutionUsage } from '@mahoshojo/contracts/ai-execution';
import type { AiStreamEvent } from '@mahoshojo/ai-core/stream-events';
import { StorySessionHeadSchema } from '@mahoshojo/contracts/desktop-arena-story';
import { buildCompletedBattleStoryRecords } from '@mahoshojo/domain/arena-story-commit';
import { captureDesktopStorySeed, type StorySessionSnapshot } from '../../src/features/arena/story-snapshot';
import { createInitialArenaDraft } from '../../src/features/arena/session';
import type { PrepareStoryExecution, StoryExecutionTarget } from '../../src/features/arena/story-session';
import { prepareStoryStorageCommit, savePreparedStoryCommit, type StoryNativePort } from '../../src/platform/arena-story-storage';

export const branchFixtureRoles = (boundary: number) => ['甲', '乙'].map(name => ({
  type: 'general-character', data: { name: `${name}-boundary-${boundary}`, content: '完整角色设定', extension: { keep: '中😀' } },
  isNative: false, isPreset: false, filename: null, teamId: null, characterGuidance: null,
}));
export async function buildDirectBranchFixture(k = 53, total = 55) {
  const sessionId = randomUUID(), chapterIds = Array.from({ length: total + 1 }, () => randomUUID());
  const checkpointIds = Array.from({ length: total + 2 }, () => randomUUID()), unknownId = randomUUID();
  const draft = createInitialArenaDraft();
  const seed = { ...captureDesktopStorySeed(draft, 'battle'), combatants: branchFixtureRoles(0),
    settings: { ...draft.settings, writeArenaHistory: false, writeCurrentState: false } };
  const coveredIndices = [...new Set([1, Math.min(3, k), k])];
  const coveredChapterIds = [...coveredIndices.map(i => chapterIds[i - 1]!), unknownId, chapterIds[total - 1]!];
  const source = { mode: 'classic' as const, language: 'zh-CN', storyLength: 'short' as const, generationMode: 'stream' as const, providerMode: 'direct-local' as const, providerId: 'historic-profile', modelId: 'historic-model' };
  let session: StorySessionSnapshot = { id: sessionId, title: '随机身份源故事', createdAt: 1, updatedAt: 1, source, seed, workingCombatants: seed.combatants, chapterCount: 0 };
  const commits = [];
  for (let i = 1; i <= total + 1; i++) {
    const inputCombatants = session.workingCombatants;
    const records = buildCompletedBattleStoryRecords({ action: i === 1 ? 'start' : 'continue',
      session: { ...session, ...(i >= k ? { sessionSummary: '仅锚点之前的安全摘要', summaryMeta: {
        coveredUntilChapterIndex: k, coveredChapterIds, refreshedAt: i, mode: 'deterministic-fallback' as const,
      } } : {}) }, source, operationId: chapterIds[i - 1]!, checkpointId: checkpointIds[i]!,
      ...(i === 1 ? { initialCheckpointId: checkpointIds[0]! } : {}), now: i, inputCombatants,
      generated: { chapterIndex: i, markdown: `# 源章 ${i}\n\n边界 ${i} 的历史完整正文。`, reportJson: { historical: i },
        digest: { chapterTitle: `源章 ${i}` }, generationId: randomUUID(), nextWorkingCombatants: branchFixtureRoles(i) },
    });
    commits.push(await prepareStoryStorageCommit({ ...records, expectedRevision: i - 1,
      expectedLastChapterId: i === 1 ? null : chapterIds[i - 2]!, lastInputCheckpointId: checkpointIds[i - 1]! }));
    session = records.session;
  }
  const document = commits[total - 1]!.parts[0]!.prepared.value as Record<string, unknown>;
  const head = StorySessionHeadSchema.parse(Object.fromEntries(['id', 'revision', 'titlePreview', 'titleTruncated', 'mode', 'chapterPlan', 'createdAt', 'updatedAt', 'chapterCount', 'lastChapterId'].filter(key => document[key] !== undefined).map(key => [key, document[key]])));
  return { sessionId, k, total, head, chapterIds, checkpointIds, coveredIndices, coveredChapterIds, unknownId,
    commits: commits.slice(0, total), next: commits[total]!,
    anchor: { sessionId, revision: total, expectedLastChapterId: chapterIds[total - 1]!, expectedChapterCount: total,
      anchorChapterId: chapterIds[k - 1]!, anchorIndex: k } };
}
export async function installDirectBranchFixture(port: StoryNativePort, fixture: Awaited<ReturnType<typeof buildDirectBranchFixture>>) {
  for (const commit of fixture.commits) await savePreparedStoryCommit(port, commit);
}
export const directBranchText = '# 分支新章\n\n甲与乙在既定边界后走入另一条道路，完整尾文中😀。';
export function directBranchExecution(options: { rawText?: string; reasoning?: string; usage?: AiExecutionUsage; afterText?: () => Promise<void>; onRequest?: (request: AiExecutionRequest) => Promise<void> } = {}) {
  const requests: AiExecutionRequest[] = [];
  const invoke = withFixtureStreamReceipt(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'cancel_direct_ai') return true;
    if (command !== 'stream_target_ai' && command !== 'stream_direct_ai') throw new Error(`unexpected model command ${command}`);
    const request = args!.request as AiExecutionRequest; requests.push(request); await options.onRequest?.(request);
    const onmessage = (args!.onEvent as { onmessage(event: AiStreamEvent): void }).onmessage;
    const id = { requestId: request.requestId, contractVersion: 1 as const, mode: request.mode };
    const text = options.rawText ?? directBranchText;
    let sequence = 0;
    onmessage({ ...id, type: 'started', sequence: sequence++ });
    if (options.reasoning) onmessage({ ...id, type: 'reasoning-delta', sequence: sequence++, delta: options.reasoning });
    onmessage({ ...id, type: 'text-delta', sequence: sequence++, delta: text });
    if (options.usage) onmessage({ ...id, type: 'usage', sequence: sequence++, usage: options.usage });
    await options.afterText?.();
    onmessage({ ...id, type: 'result', sequence: sequence++, result: { ...id, status: 'completed', output: { text, ...(options.reasoning ? { reasoning: options.reasoning } : {}) }, finishReason: 'stop', resolvedModelId: 'synthetic-branch-model', ...(options.usage ? { usage: options.usage } : {}) } });
  });
  const target: StoryExecutionTarget = { options: { invoke, profileId: 'current-profile', providerTarget: { kind: 'custom', profileId: 'current-profile' }, createChannel: () => ({}) }, intent: { mode: 'direct-local', modelId: 'selected-model' } };
  const prepare: PrepareStoryExecution = async run => run(target);
  return { requests, invoke, target, prepare };
}
