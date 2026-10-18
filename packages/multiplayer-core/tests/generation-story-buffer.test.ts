import { describe, expect, it } from 'vitest';
import type { StoryDeltaEvent } from '@mahoshojo/contracts/arena-room';
import {
  GENERATION_STORY_BUFFER_MAX_BYTES,
  GENERATION_STORY_BUFFER_MAX_FRAMES,
  GenerationStoryBuffer,
} from '@mahoshojo/multiplayer-core/generation-story-buffer';

const story = (chunkSeq: number, delta = String(chunkSeq)): StoryDeltaEvent => ({
  protocolVersion: 1,
  type: 'story.delta',
  roomId: 'room-1',
  roomEpoch: 'epoch-1',
  generationId: 'generation-1',
  chunkSeq,
  timestamp: '2026-08-28T00:02:00.000Z',
  payload: { delta },
});

describe('generation in-flight story buffer', () => {
  it('先由权威基线裁掉重叠，再按 exact-next 接入暂存后缀', () => {
    const buffer = new GenerationStoryBuffer();
    buffer.add(story(2, 'C'));
    buffer.add(story(0, 'A'));
    buffer.add(story(1, 'B'));
    buffer.add(story(2, 'C'));
    expect(buffer.rebase(1)).toEqual({ markdown: 'BC', nextChunkSeq: 3, gap: null });
  });

  it('真实缺口保持冻结，重读的较旧基线仍能接回已经验证的连续后缀', () => {
    const buffer = new GenerationStoryBuffer();
    buffer.add(story(0, 'A'));
    buffer.add(story(2, 'C'));
    expect(buffer.rebase(0)).toEqual({
      markdown: 'A', nextChunkSeq: 1, gap: { expectedChunkSeq: 1, receivedChunkSeq: 2 },
    });
    buffer.add(story(1, 'B'));
    expect(buffer.rebase(0)).toEqual({ markdown: 'ABC', nextChunkSeq: 3, gap: null });
  });

  it('帧数预算溢出时只保留丢失高水位，基线必须完全覆盖后才能继续', () => {
    const buffer = new GenerationStoryBuffer();
    for (let seq = 0; seq <= GENERATION_STORY_BUFFER_MAX_FRAMES; seq += 1) buffer.add(story(seq));
    buffer.add(story(200));
    expect(buffer.rebase(128)).toEqual({
      markdown: '', nextChunkSeq: 128, gap: { expectedChunkSeq: 128, receivedChunkSeq: 200 },
    });
    expect(buffer.rebase(201)).toEqual({ markdown: '', nextChunkSeq: 201, gap: null });
    buffer.add(story(201, '新'));
    expect(buffer.rebase(201)).toEqual({ markdown: '新', nextChunkSeq: 202, gap: null });
  });

  it('大量重复帧不重复消耗帧数预算', () => {
    const buffer = new GenerationStoryBuffer();
    for (let index = 0; index < GENERATION_STORY_BUFFER_MAX_FRAMES * 2; index += 1) buffer.add(story(0, 'A'));
    expect(buffer.rebase(0)).toEqual({ markdown: 'A', nextChunkSeq: 1, gap: null });
  });

  it('字节预算按完整 UTF-8 帧计算，不能按 JS 字符数低估中文', () => {
    const buffer = new GenerationStoryBuffer();
    const delta = '中'.repeat(20_000);
    expect(new TextEncoder().encode(JSON.stringify(story(0, delta))).byteLength).toBeLessThan(64 * 1024);
    expect(delta.length * 5).toBeLessThan(GENERATION_STORY_BUFFER_MAX_BYTES);
    for (let seq = 0; seq < 5; seq += 1) buffer.add(story(seq, delta));
    expect(buffer.rebase(0)).toEqual({
      markdown: '', nextChunkSeq: 0, gap: { expectedChunkSeq: 0, receivedChunkSeq: 4 },
    });
    expect(buffer.rebase(5).gap).toBeNull();
  });

  it('基线覆盖的帧释放字节预算', () => {
    const buffer = new GenerationStoryBuffer();
    const delta = '中'.repeat(20_000);
    for (let seq = 0; seq < 4; seq += 1) buffer.add(story(seq, delta));
    expect(buffer.rebase(4)).toEqual({ markdown: '', nextChunkSeq: 4, gap: null });
    for (let seq = 4; seq < 8; seq += 1) buffer.add(story(seq, delta));
    expect(buffer.rebase(4)).toEqual({ markdown: delta.repeat(4), nextChunkSeq: 8, gap: null });
  });

  it('同序号不同正文不可猜测选择，必须等待覆盖该位置的权威基线', () => {
    const buffer = new GenerationStoryBuffer();
    buffer.add(story(0, 'A'));
    buffer.add(story(0, 'B'));
    expect(buffer.rebase(0).gap).toEqual({ expectedChunkSeq: 0, receivedChunkSeq: 0 });
    expect(buffer.rebase(1)).toEqual({ markdown: '', nextChunkSeq: 1, gap: null });
  });
});
