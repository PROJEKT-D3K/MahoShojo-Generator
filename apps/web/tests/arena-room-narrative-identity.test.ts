// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appendArenaNarrativeHistoryResult } from '@/lib/arena-room/narrative-history-runtime';
import { useNarrativeHistoryStore } from '@/components/arena/stores/useNarrativeHistoryStore';

const mocks = vi.hoisted(() => ({ quickCheck: vi.fn() }));
vi.mock('@/lib/sensitive-word-filter', () => ({ quickCheck: mocks.quickCheck }));

beforeEach(() => {
  useNarrativeHistoryStore.getState().clear();
  mocks.quickCheck.mockReset();
});

describe('Room narrative identity fence', () => {
  it('内容过滤晚返回时不把旧身份战报写入历史', async () => {
    let current = true;
    let release!: () => void;
    const filtered = new Promise<void>((resolve) => { release = resolve; });
    mocks.quickCheck.mockImplementation(async (text: string) => {
      await filtered;
      return { filteredText: text };
    });
    const pending = appendArenaNarrativeHistoryResult({
      title: '旧房间战报', contentMarkdown: '旧身份正文', generationId: 'old-generation',
    }, () => current);
    expect(mocks.quickCheck).toHaveBeenCalledTimes(2);
    current = false;
    release();
    await pending;
    expect(useNarrativeHistoryStore.getState().entries).toEqual([]);
  });

  it('身份仍有效时正常写入', async () => {
    mocks.quickCheck.mockImplementation(async (text: string) => ({ filteredText: text }));
    await appendArenaNarrativeHistoryResult({
      title: '当前房间战报', contentMarkdown: '当前身份正文', generationId: 'current-generation',
    }, () => true);
    expect(useNarrativeHistoryStore.getState().entries).toHaveLength(1);
  });
});
