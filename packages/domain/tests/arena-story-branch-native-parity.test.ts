import { describe, expect, it } from 'vitest';
import fixture from '@mahoshojo/contracts/fixtures/desktop-story-branch-copy.json';
import { cloneBattleStoryActiveChaptersForNewSession, cloneBattleStoryCheckpointsForNewSession,
  remapBattleStorySummaryMeta } from '../src/arena-story-branch';

describe('Native physical-copy fixture matches the domain projection', () => {
  it('projects chapters/checkpoints with host-allocated target identities and preserves historical actions', () => {
    const cloned = cloneBattleStoryActiveChaptersForNewSession({
      chapters: fixture.chapters.map((chapter) => ({ ...chapter, status: 'active' as const })),
      newSessionId: fixture.targetSession,
      allocateId: (chapter) => fixture.expectedChapters[chapter.index - 1]!.id,
    });
    expect(cloned.chapters).toEqual(fixture.expectedChapters);
    const checkpoints = cloneBattleStoryCheckpointsForNewSession({ checkpoints: fixture.checkpoints,
      newSessionId: fixture.targetSession, chapterIdMap: cloned.chapterIdMap,
      allocateId: (checkpoint) => fixture.expectedCheckpoints[checkpoint.boundaryIndex]!.id });
    expect(checkpoints).toEqual(fixture.expectedCheckpoints);
    expect(remapBattleStorySummaryMeta({ coveredUntilChapterIndex: 2, coveredChapterIds: ['c1', 'c2'] },
      cloned.chapterIdMap)?.coveredChapterIds).toEqual(fixture.expectedChapters.slice(0, 2).map((c) => c.id));
  });
});
