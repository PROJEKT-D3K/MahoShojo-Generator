import { describe, expect, it } from 'vitest';
import { buildCompletedBattleStoryMiddleRewriteRecords } from '../src/arena-story-middle-rewrite';
import { buildBattleStoryTruncatedSession } from '../src/arena-story-truncation';

const fixture = () => ({
  session: {
    id: 'story', title: '未命名连续战报', createdAt: 1, updatedAt: 2,
    source: { mode: 'daily' }, seed: { combatants: [{ name: 'seed' }] },
    chapterPlan: { totalChapters: 4, locked: true }, chapterCount: 4, lastChapterId: 'c4',
    workingCombatants: [{ name: 'state4' }], lastChapterInputCombatants: [{ name: 'state3' }],
    branchOf: { sessionId: 'parent', chapterId: 'parent-chapter', chapterIndex: 2 },
    sessionSummary: '原摘要', summaryMeta: { coveredUntilChapterIndex: 1, coveredChapterIds: ['c1'], opaque: true },
    opaque: { keep: ['原文\u0000😀\ud800'] },
  },
  targetChapter: { id: 'c2', index: 2 }, previousChapter: { id: 'c1', index: 1 },
  checkpoints: [0, 1, 2, 3, 4].map((boundaryIndex) => ({ boundaryIndex, combatants: [{ name: `state${boundaryIndex}` }] })),
  operationId: 'operation', checkpointId: 'checkpoint', now: 100,
  source: { mode: 'daily', model: 'new-model' }, inputCombatants: [{ name: 'state1' }],
  generated: { chapterIndex: 2, markdown: '# 全文\n\u0000😀\ud800', reportJson: { nested: [null, false] },
    digest: { chapterTitle: '  新标题  ' }, generationId: 'generation', cardSnapshot: { extra: true },
    nextWorkingCombatants: [{ name: 'rewritten' }] },
});

describe('middle rewrite pure projection', () => {
  it('retains all content and opaque session data while replacing the head and count', () => {
    const input = fixture(); const before = structuredClone(input);
    const output = buildCompletedBattleStoryMiddleRewriteRecords(input);
    expect(input).toEqual(before);
    expect(output.session).toEqual({ ...input.session, source: input.source, chapterCount: 2, lastChapterId: 'operation',
      updatedAt: 100, workingCombatants: input.generated.nextWorkingCombatants, lastChapterInputCombatants: input.inputCombatants });
    expect(output.session.opaque).toBe(input.session.opaque);
    expect(output.chapter).toMatchObject({ id: 'operation', index: 2, action: 'rewrite', sourceChapterId: 'c2',
      markdown: input.generated.markdown, reportJson: input.generated.reportJson, cardSnapshot: input.generated.cardSnapshot });
    expect(output.checkpoint).toMatchObject({ boundaryIndex: 2, chapterId: 'operation', combatants: input.generated.nextWorkingCombatants });
  });
  it.each([0, 3, Number.NaN])('retains invalid generated index %s for save-time rejection', (chapterIndex) => {
    const input = fixture(); input.generated.chapterIndex = chapterIndex;
    const output = buildCompletedBattleStoryMiddleRewriteRecords(input);
    expect(output.chapter.index).toBe(chapterIndex); expect(output.checkpoint.boundaryIndex).toBe(chapterIndex);
    expect(output.session.chapterCount).toBe(2); expect(output.chapter.markdown).toBe(input.generated.markdown);
  });
});

describe('truncation pure projection', () => {
  it('restores the preceding output/input states and preserves source and extensions', () => {
    const input = fixture(); const before = structuredClone(input); const output = buildBattleStoryTruncatedSession(input);
    expect(input).toEqual(before);
    expect(output).toEqual({ ...input.session, chapterCount: 1, lastChapterId: 'c1', updatedAt: 100,
      workingCombatants: [{ name: 'state1' }], lastChapterInputCombatants: [{ name: 'state0' }] });
    expect(output.opaque).toBe(input.session.opaque); expect(output.summaryMeta).toBe(input.session.summaryMeta);
  });
  it('uses legacy latest input and first chapter seed fallbacks, but never current output', () => {
    const input = fixture(); const session = { ...input.session, chapterCount: 2, lastChapterId: 'c2' };
    expect(buildBattleStoryTruncatedSession({ ...input, session, checkpoints: [] })).toMatchObject({
      workingCombatants: session.lastChapterInputCombatants, lastChapterInputCombatants: session.seed.combatants,
    });
    expect(() => buildBattleStoryTruncatedSession({ ...input, checkpoints: [] })).toThrow('回退状态');
  });
  it('leaves unavailable previous-middle input undefined rather than borrowing latest input', () => {
    const input = fixture(); const output = buildBattleStoryTruncatedSession({ ...input,
      targetChapter: { id: 'c3', index: 3 }, previousChapter: { id: 'c2', index: 2 },
      checkpoints: [{ boundaryIndex: 2, combatants: [{ name: 'state2' }] }],
    });
    expect(output.workingCombatants).toEqual([{ name: 'state2' }]); expect(output.lastChapterInputCombatants).toBeUndefined();
  });
});

for (const [name, project] of [
  ['middle rewrite', (input: ReturnType<typeof fixture>) => buildCompletedBattleStoryMiddleRewriteRecords(input).session],
  ['truncation', buildBattleStoryTruncatedSession],
] as const) describe(`${name} summary safety`, () => {
  it.each([2, 3, 4])('clears summaries covering %s at or beyond the edited chapter', (coveredUntilChapterIndex) => {
    const input = fixture(); input.session.summaryMeta.coveredUntilChapterIndex = coveredUntilChapterIndex;
    expect(project(input).sessionSummary).toBeUndefined(); expect(project(input).summaryMeta).toBeUndefined();
  });
  it('retains a legacy summary without metadata', () => {
    const input = fixture(); Reflect.deleteProperty(input.session, 'summaryMeta');
    expect(project(input).sessionSummary).toBe('原摘要');
  });
});
