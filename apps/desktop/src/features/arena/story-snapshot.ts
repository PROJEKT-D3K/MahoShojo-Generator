import {
  buildBattleStoryDeterministicDigest, buildBattleStorySummaryFallback,
  type BattleStoryChapterPlan,
} from '@mahoshojo/domain/arena-battle-story-session';
import type { BattleStoryArenaSeed } from '@mahoshojo/domain/arena-battle-story-request';
import { buildCompletedBattleStoryRecords, freezeBattleStoryCommit, projectHostedStoryPendingContent, type BattleStoryCommitSession } from '@mahoshojo/domain/arena-story-commit';
import { buildCompletedBattleStoryBranchRecords, buildBattleStoryBranchLabel } from '@mahoshojo/domain/arena-story-branch';
import { buildCompletedBattleStoryTailRewriteRecords } from '@mahoshojo/domain/arena-story-tail-rewrite';
import type { StoryTailRewriteSourceSnapshot } from '../../platform/arena-story-tail-rewrite-source';
import type { StoryBranchSourceSnapshot } from '../../platform/arena-story-branch-source';
import { branchCopyId } from '../../platform/arena-story-branch-storage';
import { getArenaPostBattleWorldLineIndices } from '@mahoshojo/domain/arena-post-battle';
import { planUnsignedArenaPostBattleCandidates } from '@mahoshojo/domain/arena-post-battle-candidates';
import type { AdjudicationResult } from '@mahoshojo/domain/arena-types';
import { StorySourceSchema } from '@mahoshojo/contracts/desktop-arena-story';
import type { ArenaDirectOutcome } from './direct';
import { inheritedArenaAdjudication, type ArenaDraft, type DesktopArenaProduct } from './session';

export type StorySource = ReturnType<typeof StorySourceSchema.parse>;
export type StorySessionSnapshot = BattleStoryCommitSession & {
  source: StorySource; seed: Omit<BattleStoryArenaSeed, 'mode' | 'language' | 'storyLength' | 'customStoryLength'>;
  chapterPlan?: BattleStoryChapterPlan; sessionSummary?: string;
  summaryMeta?: { coveredUntilChapterIndex: number; coveredChapterIds: string[]; refreshedAt: number; mode: 'deterministic-fallback' };
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连续故事角色快照无效');
  return value as Record<string, unknown>;
};

/** Same seed fields as the Hosted session. Single-shot drafts, teams' display names and
 * activity/history-reference lists are deliberately not extra implicit chapter inputs. */
export const captureDesktopStorySeed = (draft: ArenaDraft, product: DesktopArenaProduct): StorySessionSnapshot['seed'] => {
  return {
    combatants: draft.combatants.map((combatant) => ({ type: combatant.type, data: combatant.data, isNative: combatant.isValid, isPreset: combatant.isPreset, filename: combatant.isPreset ? combatant.filename : null, teamId: typeof combatant.teamId === 'number' ? combatant.teamId : null, characterGuidance: typeof combatant.characterGuidance === 'string' ? combatant.characterGuidance : null, sourceDataCardId: combatant.sourceDataCardId, sourceDataCardUpdatedAt: combatant.sourceDataCardUpdatedAt })),
    scenario: draft.battleMode === 'scenario' ? draft.scenario.content : null,
    auxScenarios: draft.battleMode === 'scenario' ? draft.auxScenarios.map((scenario) => scenario.content) : [],
    materials: [...draft.materials],
    questionnaires: (draft.selectedQuestionnaires ?? []).map(({ questionnaire, useLore }) => ({
      id: questionnaire.id, title: questionnaire.title, kind: questionnaire.kind,
      ...(useLore === false ? { useLore: false } : questionnaire.loreMarkdown ? { loreMarkdown: questionnaire.loreMarkdown } : {}),
    })),
    adjudicationEvents: inheritedArenaAdjudication(draft, product).events,
    settings: (({ userGuidance: _userGuidance, ...settings }) => settings)(draft.settings),
  };
};

/** Uses the canonical copy-on-write effect producer and completed-record assembly.
 * No amplified deep clone, no mutation of the single-shot draft or original card. */
export const buildDesktopStoryGeneratedContent = (input: {
  session: StorySessionSnapshot; chapterIndex: number;
  now: number; source: StorySource; workingCombatants: unknown[]; userGuidance: string;
  outcome: Extract<ArenaDirectOutcome, { status: 'completed' }>; adjudicationResults: AdjudicationResult[];
}) => {
  const { outcome, session, workingCombatants, now } = input;
  const report = outcome.report as unknown as Record<string, unknown>;
  const settings = session.seed.settings;
  const effectsInput = {
    combatants: workingCombatants, report, impacts: outcome.impacts,
    userGuidance: input.userGuidance, scenario: session.seed.scenario ?? null,
    writeArenaHistory: settings.writeArenaHistory, writeCurrentState: settings.writeCurrentState,
    // The story's chapter is its narrative history. Never append into a single-shot activity draft.
    writeNarrativeHistory: false,
    narrativeHistory: { entries: [], title: outcome.report.headline, content: outcome.markdown },
  };
  const worldLineIds = Object.fromEntries(getArenaPostBattleWorldLineIndices({ ...effectsInput, generationId: outcome.requestId })
    .map((index) => [index, `${outcome.requestId}:${index}`]));
  const candidates = planUnsignedArenaPostBattleCandidates(effectsInput, {
    scopeKey: outcome.scopeKey, requestId: outcome.requestId, generationId: outcome.requestId,
    occurredAt: new Date(now).toISOString(), worldLineIds,
  });
  const effects = new Map(candidates.characterEffects.map((item) => [item.combatantIndex, item.data]));
  const nextWorkingCombatants = workingCombatants.map((value, index) => effects.has(index)
    ? { ...object(value), data: effects.get(index)!, isNative: false, isPreset: false }
    : value);
  const digest = buildBattleStoryDeterministicDigest({ markdown: outcome.markdown, reportJson: report, impacts: outcome.impacts, chapterIndex: input.chapterIndex });
  return { chapterIndex: input.chapterIndex, markdown: outcome.markdown, reportJson: { report, impacts: outcome.impacts },
    digest, generationId: outcome.requestId, nextWorkingCombatants,
    cardSnapshot: {
      mode: outcome.report.mode ?? session.source.mode,
      scenarioName: outcome.report.scenario ?? outcome.presentation?.scenarioName,
      characterGuidances: outcome.report.characterGuidances ?? outcome.presentation?.characterGuidances,
      narrativeHistoryReadCount: outcome.report.narrativeHistoryReadCount ?? outcome.presentation?.narrativeHistoryReadCount,
      reporterInfo: outcome.report.reporterInfo, userGuidance: input.userGuidance,
      adjudicationResults: input.adjudicationResults, aiUsage: outcome.usage ?? outcome.report.aiUsage ?? null,
      aiModel: outcome.report.aiModel ?? outcome.presentation?.aiModel ?? input.source.modelId,
      ...(outcome.reasoning ? { aiReasoning: { status: 'done', source: 'provider', text: outcome.reasoning } } : {}),
    },
  };
};

/** Linear completion keeps its existing immediate deterministic summary advance. */
export const completeDesktopStoryRecords = (input: Parameters<typeof buildDesktopStoryGeneratedContent>[0] & {
  action: 'start' | 'continue'; operationId: string; checkpointId: string; initialCheckpointId?: string;
}) => {
  const { session, now } = input;
  const generated = buildDesktopStoryGeneratedContent(input);
  const sessionSummary = buildBattleStorySummaryFallback({ previousSummary: session.sessionSummary, digests: [{ ...generated.digest, index: input.chapterIndex }] });
  return freezeBattleStoryCommit(buildCompletedBattleStoryRecords({
    action: input.action, session: { ...session, sessionSummary, summaryMeta: {
      coveredUntilChapterIndex: input.chapterIndex,
      coveredChapterIds: [...(session.summaryMeta?.coveredChapterIds ?? []), input.operationId],
      refreshedAt: now, mode: 'deterministic-fallback' as const,
    } },
    operationId: input.operationId, checkpointId: input.checkpointId, initialCheckpointId: input.initialCheckpointId,
    now, source: input.source, inputCombatants: input.workingCombatants, generated,
  }));
};

/** Same unsigned effects and Web-consumed branch assembly. The safe inherited
 * summary is mapped, not advanced with this new chapter before mapping. */
export const completeDesktopBranchRecords = (input: {
  snapshot: StoryBranchSourceSnapshot; session: StorySessionSnapshot; summaryIds: Readonly<Record<string, string>>;
  operationId: string; checkpointId: string; now: number; source: StorySource; userGuidance: string;
  outcome: Extract<ArenaDirectOutcome, { status: 'completed' }>; adjudicationResults: AdjudicationResult[];
}) => {
  const { snapshot, session, now } = input;
  const generated = buildDesktopStoryGeneratedContent({ ...input, chapterIndex: snapshot.source.anchorIndex + 1,
    workingCombatants: snapshot.workingCombatants });
  return freezeBattleStoryCommit(buildCompletedBattleStoryBranchRecords({
    session: { ...session, title: `${snapshot.session.title || snapshot.anchor.title}（分支）`,
      updatedAt: now, lastChapterInputCombatants: snapshot.workingCombatants,
      branchLabel: buildBattleStoryBranchLabel({ chapterIndex: snapshot.anchor.index, chapterTitle: snapshot.anchor.title }),
      branchOf: { sessionId: snapshot.session.id, chapterId: snapshot.anchor.id, chapterIndex: snapshot.anchor.index,
        ...(snapshot.anchor.title ? { chapterTitle: snapshot.anchor.title } : {}), createdAt: session.createdAt },
    },
    prefixEndIndex: snapshot.source.anchorIndex,
    targetAnchorChapterId: branchCopyId(session.id, 'c', snapshot.source.anchorIndex),
    operationId: input.operationId, checkpointId: input.checkpointId, now, source: input.source,
    inputCombatants: snapshot.workingCombatants, generated,
    mapChapterId: id => Object.hasOwn(input.summaryIds, id) ? input.summaryIds[id] : undefined,
  }));
};

/** Tail replacement consumes the same effects producer and shared Web projection. */
export const completeDesktopTailRewriteRecords = (input: {
  snapshot: StoryTailRewriteSourceSnapshot; session: StorySessionSnapshot;
  operationId: string; checkpointId: string; now: number; source: StorySource; userGuidance: string;
  outcome: Extract<ArenaDirectOutcome, { status: 'completed' }>; adjudicationResults: AdjudicationResult[];
}) => {
  const generated = buildDesktopStoryGeneratedContent({ ...input, chapterIndex: input.snapshot.target.index,
    workingCombatants: input.snapshot.workingCombatants });
  return freezeBattleStoryCommit(buildCompletedBattleStoryTailRewriteRecords({
    session: input.session, targetChapter: input.snapshot.target, operationId: input.operationId,
    checkpointId: input.checkpointId, now: input.now, source: { ...input.snapshot.session.source, ...input.source },
    inputCombatants: input.snapshot.workingCombatants, generated,
  }));
};

/** Hosted consumes checked server-role originals. It never invokes the unsigned
 * Direct role-effect producer and never saves display-only usage projections. */
export const completeHostedStoryRecords = (input: {
  session: StorySessionSnapshot; source: StorySource;
  manifest: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingManifest;
  originals: {
    input: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingInput; markdown: string; reasoning: string;
    meta?: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingMeta;
    header?: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingHeader;
    telemetry?: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingTelemetry;
    roleResponse?: import('@mahoshojo/contracts/desktop-arena-story').StoryPendingRoleResponse;
  };
  generationId: string | null; roleState: 'not-requested' | 'accepted' | 'old-roles';
  fallbackReason?: 'http-failure' | 'user-kept-original';
}) => {
  const { session, originals, manifest } = input;
  // Native binds the chapter timestamp to the original pending identity. Cold
  // assembly and role retries must not create a different chapter time.
  const now = manifest.createdAt;
  const combatants = originals.input.chapterContext.workingCombatants.map(object);
  const projection = projectHostedStoryPendingContent({ inputUserGuidance: originals.input.userGuidance,
    reasoning: originals.reasoning, meta: originals.meta, header: originals.header, telemetry: originals.telemetry,
    roleState: input.roleState, roleResponse: originals.roleResponse, fallbackReason: input.fallbackReason,
    workingCombatants: combatants });
  const digest = buildBattleStoryDeterministicDigest({ markdown: originals.markdown, reportJson: projection.reportJson,
    chapterIndex: originals.input.chapterIndex });
  const sessionSummary = buildBattleStorySummaryFallback({ previousSummary: session.sessionSummary, digests: [{ ...digest, index: originals.input.chapterIndex }] });
  return freezeBattleStoryCommit(buildCompletedBattleStoryRecords({ action: originals.input.action,
    session: { ...session, sessionSummary, summaryMeta: { coveredUntilChapterIndex: originals.input.chapterIndex,
      coveredChapterIds: [...(session.summaryMeta?.coveredChapterIds ?? []), manifest.operationId], refreshedAt: now, mode: 'deterministic-fallback' as const } },
    source: input.source, operationId: manifest.operationId, checkpointId: manifest.outputCheckpointId,
    ...(manifest.initialCheckpointId ? { initialCheckpointId: manifest.initialCheckpointId } : {}), now, inputCombatants: combatants,
    generated: { chapterIndex: originals.input.chapterIndex, markdown: originals.markdown, digest,
      generationId: input.generationId, ...projection,
      cardSnapshot: { ...projection.cardSnapshot, mode: originals.header?.mode ?? originals.input.seed.mode,
        ...(originals.input.seed.mode === 'scenario' && projection.cardSnapshot.scenarioDisplayName === undefined
          && typeof originals.input.seed.scenario?.title === 'string' && originals.input.seed.scenario.title.trim()
          ? { scenarioDisplayName: originals.input.seed.scenario.title.trim() } : {}),
      } } }));
};
