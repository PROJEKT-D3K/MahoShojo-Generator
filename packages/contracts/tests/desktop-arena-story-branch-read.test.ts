import { describe, expect, it } from 'vitest';
import { StoryChapterHeadSchema, StoryReceiptSchema } from '../src/desktop-arena-story';

describe('branch persisted read compatibility without a new write command', () => {
  it('reads active branch and rewrite heads while excluding superseded directory rows', () => {
    const chapter = { id: 'chapter', index: 2, action: 'branch', status: 'active',
      titlePreview: '', titleTruncated: false, createdAt: 1, markdownByteLength: 0 };
    expect(StoryChapterHeadSchema.parse(chapter).action).toBe('branch');
    expect(StoryChapterHeadSchema.safeParse({ ...chapter, action: 'rewrite' }).success).toBe(true);
    expect(StoryChapterHeadSchema.safeParse({ ...chapter, status: 'superseded' }).success).toBe(false);
  });
  it('does not widen linear receipt wire format to accept v2 disk markers', () => {
    expect(StoryReceiptSchema.safeParse({ version: 2, kind: 'branch-copy' }).success).toBe(false);
    expect(StoryReceiptSchema.safeParse({ version: 2, kind: 'branch' }).success).toBe(false);
  });
});

it('separates historical chapter documents from active directory heads', async () => {
  const { StoryChapterDocumentSchema } = await import('../src/desktop-arena-story');
  const chapter = { id: 'old', sessionId: 'story', index: 1, action: 'rewrite', status: 'superseded', supersededByChapterId: 'new', title: '', titlePreview: '', titleTruncated: false, createdAt: 1, markdownByteLength: 0, markdown: '', reportJson: {}, deterministicDigest: { chapterTitle: '' }, unknown: { original: true } };
  expect(StoryChapterDocumentSchema.parse(chapter)).toEqual(chapter);
  expect(StoryChapterHeadSchema.safeParse(chapter).success).toBe(false);
  expect(StoryChapterDocumentSchema.safeParse({ ...chapter, supersededByChapterId: null }).success).toBe(false);
  expect(StoryChapterDocumentSchema.safeParse({ ...chapter, status: 'active' }).success).toBe(false);
});
