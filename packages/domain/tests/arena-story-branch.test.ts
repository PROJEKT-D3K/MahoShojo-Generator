import { describe, expect, it } from 'vitest';
import {
  buildBattleStoryBranchLabel,
  cloneBattleStoryActiveChaptersForNewSession,
  cloneBattleStoryCheckpointsForNewSession,
  remapBattleStorySummaryMeta,
  resolveAnchoredSummaryState,
  resolveBattleStoryChapterOutputCombatants,
  toBattleStoryRecordCombatants,
} from '../src/arena-story-branch';
import { willBattleStoryChapterExceedPlan } from '../src/arena-battle-story-session';

const chapter = (index: number) => ({
  id: `old-${index}`, sessionId: 'source', index, status: 'active' as const,
  sourceChapterId: index > 1 ? `old-${index - 1}` : null,
  action: index === 2 ? 'rewrite' : index === 3 ? 'branch' : 'continue',
  generationId: `generation-${index}`, markdown: '原文\u0000😀\ud800',
  extension: { '\ud800': { nested: ['old-1', null, false] } },
});

describe('story branch owned-snapshot pure projections', () => {
  it.each([1, 27, 53])('clones the supplied prefix through anchor %s without changing history or source', (anchor) => {
    const chapters = Array.from({ length: anchor }, (_, offset) => chapter(offset + 1)).reverse();
    const superseded = { ...chapter(1), id: 'superseded', status: 'superseded' as const };
    const source = [...chapters, superseded];
    const before = structuredClone(source);
    const allocations: string[] = [];
    const projected = cloneBattleStoryActiveChaptersForNewSession({
      chapters: source, newSessionId: 'target', allocateId: (item) => {
        allocations.push(item.id); return `new-${item.index}`;
      },
    });
    expect(source).toEqual(before);
    expect(allocations).toEqual(Array.from({ length: anchor }, (_, offset) => `old-${offset + 1}`));
    expect(projected.chapters).toHaveLength(anchor);
    for (const [offset, item] of projected.chapters.entries()) {
      const original = chapter(offset + 1);
      expect(item).toEqual({ ...original, id: `new-${offset + 1}`, sessionId: 'target',
        sourceChapterId: offset ? `new-${offset}` : null, supersededByChapterId: null });
      expect(item).not.toBe(source.find((row) => row.id === original.id));
    }
    expect(projected.chapterIdMap.has('superseded')).toBe(false);
  });

  it('maps only explicit local relationships, retaining opaque extension references', () => {
    const source = [{ ...chapter(1), sourceChapterId: 'outside-prefix' }];
    const result = cloneBattleStoryActiveChaptersForNewSession({ chapters: source,
      newSessionId: 'target', allocateId: () => 'new-1' });
    expect(result.chapters[0].sourceChapterId).toBeNull();
    expect(result.chapters[0].extension).toBe(source[0].extension);
    expect(result.chapters[0].extension['\ud800'].nested[0]).toBe('old-1');
  });

  it('keeps checkpoint boundary order, filters suffix and remaps references without mutating snapshots', () => {
    const checkpoints = [3, 1, 0, 2].map((index) => ({ id: `p${index}`, sessionId: 'source',
      boundaryIndex: index, chapterId: index ? `old-${index}` : null, combatants: [{ index }] }));
    const before = structuredClone(checkpoints);
    const result = cloneBattleStoryCheckpointsForNewSession({ checkpoints, newSessionId: 'target',
      chapterIdMap: new Map([['old-1', 'new-1']]), maxBoundaryIndex: 2.9,
      allocateId: (item) => `new-${item.id}` });
    expect(result.map((item) => [item.id, item.boundaryIndex, item.chapterId])).toEqual([
      ['new-p0', 0, null], ['new-p1', 1, 'new-1'], ['new-p2', 2, null],
    ]);
    expect(checkpoints).toEqual(before);
    expect(result.every((item) => item.sessionId === 'target')).toBe(true);
    expect(cloneBattleStoryCheckpointsForNewSession({ checkpoints, newSessionId: 'target',
      chapterIdMap: new Map(), allocateId: (item) => item.id }).length).toBe(4);
  });

  it('anchors summaries inclusively for branch and preserves the strict legacy rewrite option', () => {
    const summaryMeta = { coveredUntilChapterIndex: 2, coveredChapterIds: ['old-1', 'old-2'],
      refreshedAt: 100, mode: 'ai', extension: 'retain' };
    const input = { sessionSummary: '摘要', summaryMeta, maxCoveredChapterIndex: 2 };
    expect(resolveAnchoredSummaryState(input)).toEqual({ sessionSummary: '摘要', summaryMeta });
    expect(resolveAnchoredSummaryState({ ...input, maxCoveredChapterIndex: 1 })).toEqual({
      sessionSummary: undefined, summaryMeta: undefined,
    });
    expect(resolveAnchoredSummaryState({ ...input, invalidateWhenCoveredAtOrBeyond: true })).toEqual({
      sessionSummary: undefined, summaryMeta: undefined,
    });
    expect(resolveAnchoredSummaryState({ sessionSummary: '旧无meta摘要', maxCoveredChapterIndex: 1 }))
      .toEqual({ sessionSummary: '旧无meta摘要', summaryMeta: undefined });
    expect(remapBattleStorySummaryMeta(summaryMeta, new Map([['old-1', 'new-1']])))
      .toEqual({ ...summaryMeta, coveredChapterIds: ['new-1'] });
    expect(summaryMeta.coveredChapterIds).toEqual(['old-1', 'old-2']);
    expect(remapBattleStorySummaryMeta(undefined, new Map())).toBeUndefined();
  });

  it('prefers anchor checkpoint and only falls back to working roles for the latest chapter', () => {
    const anchor = { id: 'anchor', index: 2 };
    const current = { codename: 'current' }, checkpoint = { codename: 'anchor' };
    const input = { session: { workingCombatants: [current] }, chapter: anchor, latestChapter: anchor,
      checkpoints: [{ boundaryIndex: 2, combatants: [null, 'bad', checkpoint] }] };
    expect(resolveBattleStoryChapterOutputCombatants(input)).toEqual([checkpoint]);
    expect(resolveBattleStoryChapterOutputCombatants({ ...input, checkpoints: [] })).toEqual([current]);
    expect(resolveBattleStoryChapterOutputCombatants({ ...input, checkpoints: [], latestChapter: { id: 'later' } })).toBeNull();
    expect(resolveBattleStoryChapterOutputCombatants({ ...input, checkpoints: [], latestChapter: null })).toBeNull();
    expect(toBattleStoryRecordCombatants(undefined)).toBeNull();
    expect(toBattleStoryRecordCombatants([null, 1, false])).toBeNull();
    // Preserve legacy normalization; this helper is not a strict wire validator.
    expect(toBattleStoryRecordCombatants([[]])).toEqual([[]]);
  });

  it('keeps label normalization and the existing chapter-plan ceiling', () => {
    expect(buildBattleStoryBranchLabel({ chapterIndex: 2.9, chapterTitle: '  标题  ' })).toBe('从第 2 章《标题》分支');
    expect(buildBattleStoryBranchLabel({ chapterIndex: 0, chapterTitle: ' ' })).toBe('从第 1 章分支');
    expect(willBattleStoryChapterExceedPlan({ chapterPlan: { totalChapters: 3 }, nextChapterIndex: 4 })).toBe(true);
    expect(willBattleStoryChapterExceedPlan({ chapterPlan: { totalChapters: 3 }, nextChapterIndex: 3 })).toBe(false);
  });
});
