import { describe, expect, it } from 'vitest';
import { buildCompletedBattleStoryTailRewriteRecords, resolveBattleStoryChapterInputCombatants } from '../src/arena-story-tail-rewrite';

const fixture = () => ({
  session: {
    id: 'story', title: '未命名连续战报', createdAt: 1, updatedAt: 2,
    source: { mode: 'daily', opaque: { provider: true } },
    seed: { combatants: [{ name: 'seed' }], extra: { keep: true } },
    chapterPlan: { totalChapters: 3, locked: true }, chapterCount: 3, lastChapterId: 'old',
    workingCombatants: [{ name: 'old-output' }], lastChapterInputCombatants: [{ name: 'old-input' }],
    branchOf: { sessionId: 'parent', chapterId: 'parent-chapter', chapterIndex: 2 },
    sessionSummary: '旧摘要',
    summaryMeta: { coveredUntilChapterIndex: 2, coveredChapterIds: ['c1', 'c2'], opaque: ['keep'] },
    opaque: { nested: ['原文\u0000😀\ud800', null, false] },
  },
  targetChapter: { id: 'old', index: 3 }, operationId: 'operation', checkpointId: 'checkpoint', now: 100,
  source: { mode: 'daily', opaque: { provider: false } }, inputCombatants: [{ name: 'input' }],
  generated: { chapterIndex: 3, markdown: '# 全文\n\u0000😀\ud800', reportJson: { opaque: [null, false] },
    digest: { chapterTitle: '  新标题  ' }, generationId: 'generation', cardSnapshot: { unknown: true },
    nextWorkingCombatants: [{ name: 'output' }] },
});

describe('tail rewrite pure record projection', () => {
  it('preserves session identity, title, count and opaque members without mutating owned inputs', () => {
    const input = fixture(); const before = structuredClone(input);
    const result = buildCompletedBattleStoryTailRewriteRecords(input);
    expect(input).toEqual(before);
    expect(result.session).toEqual({ ...input.session, source: input.source,
      updatedAt: input.now, lastChapterId: input.operationId,
      lastChapterInputCombatants: input.inputCombatants, workingCombatants: input.generated.nextWorkingCombatants });
    expect(result.session.opaque).toBe(input.session.opaque);
    expect(result.session.seed).toBe(input.session.seed);
    expect(result.session.summaryMeta).toBe(input.session.summaryMeta);
    expect(result.chapter).toEqual({
      id: 'operation', sessionId: 'story', index: 3, action: 'rewrite', status: 'active', sourceChapterId: 'old',
      title: '新标题', markdown: input.generated.markdown, reportJson: input.generated.reportJson,
      deterministicDigest: input.generated.digest, generationId: 'generation', cardSnapshot: input.generated.cardSnapshot, createdAt: 100,
    });
    expect(result.checkpoint).toEqual({ id: 'checkpoint', sessionId: 'story', boundaryIndex: 3,
      chapterId: 'operation', combatants: input.generated.nextWorkingCombatants, createdAt: 100 });
  });

  it.each([3, 4])('invalidates summaries covering chapter %s at or beyond the replaced tail', (coveredUntilChapterIndex) => {
    const input = fixture(); input.session.summaryMeta.coveredUntilChapterIndex = coveredUntilChapterIndex;
    const result = buildCompletedBattleStoryTailRewriteRecords(input);
    expect(result.session.sessionSummary).toBeUndefined(); expect(result.session.summaryMeta).toBeUndefined();
    expect(input.session.sessionSummary).toBe('旧摘要');
  });

  it('retains legacy summaries without metadata and optional generation fields stay absent', () => {
    const input = fixture();
    const session = { ...input.session, summaryMeta: undefined };
    const generated = { ...input.generated, generationId: undefined, cardSnapshot: undefined };
    const result = buildCompletedBattleStoryTailRewriteRecords({ ...input, session, generated });
    expect(result.session.sessionSummary).toBe('旧摘要');
    expect(result.chapter).not.toHaveProperty('generationId'); expect(result.chapter).not.toHaveProperty('cardSnapshot');
  });

  it.each([0, 4, Number.NaN])('retains the generated index %s for save-time validation after content retention', (chapterIndex) => {
    const input = fixture(); input.generated.chapterIndex = chapterIndex;
    const result = buildCompletedBattleStoryTailRewriteRecords(input);
    expect(result.chapter.index).toBe(chapterIndex); expect(result.checkpoint.boundaryIndex).toBe(chapterIndex);
    expect(result.session.chapterCount).toBe(3); expect(result.chapter.markdown).toBe(input.generated.markdown);
  });
});

describe('chapter input role snapshot projection', () => {
  const first = { id: 'first', index: 1 }; const latest = { id: 'latest', index: 3 };
  const session = { seed: { combatants: [{ name: 'seed' }] }, lastChapterInputCombatants: [{ name: 'last-input' }] };
  it('prefers boundary n-1 even on the first and latest chapter', () => {
    const combatants = [null, 'bad', { name: 'checkpoint' }];
    for (const chapter of [first, latest]) expect(resolveBattleStoryChapterInputCombatants({ session,
      chapter, latestChapter: latest, checkpoints: [{ boundaryIndex: chapter.index - 1, combatants }] })).toEqual([{ name: 'checkpoint' }]);
  });
  it('falls back to seed only for the first chapter, and last input only for the current latest', () => {
    expect(resolveBattleStoryChapterInputCombatants({ session, chapter: first, latestChapter: latest, checkpoints: [] })).toEqual(session.seed.combatants);
    expect(resolveBattleStoryChapterInputCombatants({ session, chapter: latest, latestChapter: latest, checkpoints: [] })).toEqual(session.lastChapterInputCombatants);
    expect(resolveBattleStoryChapterInputCombatants({ session, chapter: { id: 'middle', index: 2 }, latestChapter: latest, checkpoints: [] })).toBeNull();
    expect(resolveBattleStoryChapterInputCombatants({ session, chapter: latest, latestChapter: null, checkpoints: [] })).toBeNull();
  });
  it('rejects absent or unusable snapshots rather than returning current output roles', () => {
    const invalid = { seed: { combatants: [null, 'bad'] }, lastChapterInputCombatants: [null, false] };
    expect(resolveBattleStoryChapterInputCombatants({ session: invalid, chapter: first, latestChapter: first, checkpoints: [] })).toBeNull();
    expect(resolveBattleStoryChapterInputCombatants({ session: invalid, chapter: latest, latestChapter: latest, checkpoints: [{ boundaryIndex: 2, combatants: [] }] })).toBeNull();
  });
});
