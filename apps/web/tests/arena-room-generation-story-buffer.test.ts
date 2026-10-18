import { describe, expect, it } from 'vitest';
import * as shared from '@mahoshojo/multiplayer-core/generation-story-buffer';
import * as web from '@/lib/arena-room/generation-story-buffer';

describe('Web generation preview buffer', () => {
  it('reuses the shared implementation and its original preview budgets', () => {
    expect(web.GenerationStoryBuffer).toBe(shared.GenerationStoryBuffer);
    expect(web.GENERATION_STORY_BUFFER_MAX_FRAMES).toBe(128);
    expect(web.GENERATION_STORY_BUFFER_MAX_BYTES).toBe(256 * 1024);
  });
});
