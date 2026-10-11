import { describe, expect, it } from 'vitest';
import { StoryChapterHeadSchema, StoryReceiptSchema } from '../src/desktop-arena-story';

describe('branch persisted read compatibility without a new write command', () => {
  it('reads branch history while still rejecting rewrite and superseded rows', () => {
    const chapter = { id: 'chapter', index: 2, action: 'branch', status: 'active',
      titlePreview: '', titleTruncated: false, createdAt: 1, markdownByteLength: 0 };
    expect(StoryChapterHeadSchema.parse(chapter).action).toBe('branch');
    expect(StoryChapterHeadSchema.safeParse({ ...chapter, action: 'rewrite' }).success).toBe(false);
    expect(StoryChapterHeadSchema.safeParse({ ...chapter, status: 'superseded' }).success).toBe(false);
  });
  it('does not widen linear receipt wire format to accept v2 disk markers', () => {
    expect(StoryReceiptSchema.safeParse({ version: 2, kind: 'branch-copy' }).success).toBe(false);
    expect(StoryReceiptSchema.safeParse({ version: 2, kind: 'branch' }).success).toBe(false);
  });
});
