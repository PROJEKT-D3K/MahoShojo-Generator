import { describe, expect, it } from 'vitest';
import { StorySessionDeleteTargetSchema, StorySessionDeleteOutcomeSchema } from '../src/desktop-arena-story';

const target = { session: { instance: 'a'.repeat(32), sessionId: 'story', recordId: 'story', revision: 1, kind: 'session', byteLength: 500, digest: `sha256:${'b'.repeat(64)}` }, expectedLastChapterId: 'chapter-1', expectedChapterCount: 1 };
describe('whole local-session deletion closed contract', () => {
  it('binds immutable session identity and accepts actual deletion or zero-count present absence', () => {
    expect(StorySessionDeleteTargetSchema.parse(target)).toEqual(target);
    expect(StorySessionDeleteOutcomeSchema.safeParse({ target, status: 'deleted', deletedChapterCount: 1, deletedCheckpointCount: 2 }).success).toBe(true);
    expect(StorySessionDeleteOutcomeSchema.safeParse({ target, status: 'currently-absent', deletedChapterCount: 0, deletedCheckpointCount: 0 }).success).toBe(true);
  });
  it('rejects extra authority, non-session descriptor, mismatched record, invalid count and pretend causal absence', () => {
    for (const value of [{ ...target, sql: 'DELETE' }, { ...target, expectedChapterCount: 0 }, { ...target, expectedChapterCount: Number.MAX_SAFE_INTEGER + 1 }, { ...target, session: { ...target.session, kind: 'chapter' } }, { ...target, session: { ...target.session, recordId: 'other' } }, { ...target, session: { ...target.session, path: 'arbitrary' } }]) {
      expect(StorySessionDeleteTargetSchema.safeParse(value).success).toBe(false);
    }
    for (const value of [{ target, status: 'currently-absent', deletedChapterCount: 1, deletedCheckpointCount: 2 }, { target, status: 'deleted', deletedChapterCount: 2, deletedCheckpointCount: 3 }, { target, status: 'deleted', deletedChapterCount: 1, deletedCheckpointCount: 0 }]) {
      expect(StorySessionDeleteOutcomeSchema.safeParse(value).success).toBe(false);
    }
  });
});
