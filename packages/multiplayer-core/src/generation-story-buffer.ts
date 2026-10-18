import type { StoryDeltaEvent } from '@mahoshojo/contracts/arena-room';

// Local preview budgets, not an estimate of total JavaScript heap usage.
export const GENERATION_STORY_BUFFER_MAX_FRAMES = 128;
export const GENERATION_STORY_BUFFER_MAX_BYTES = 256 * 1024;

export type GenerationStoryGap = {
  readonly expectedChunkSeq: number;
  readonly receivedChunkSeq: number;
};

/** Holds validated in-flight deltas until an authoritative GET establishes their baseline. */
export class GenerationStoryBuffer {
  private readonly frames = new Map<number, { event: StoryDeltaEvent; bytes: number }>();
  private bytes = 0;
  private discardedThrough: number | null = null;

  add(event: StoryDeltaEvent): void {
    if (this.discardedThrough !== null) {
      this.discardedThrough = Math.max(this.discardedThrough, event.chunkSeq);
      return;
    }
    const existing = this.frames.get(event.chunkSeq);
    if (existing?.event.payload.delta === event.payload.delta) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (
      existing
      || this.frames.size >= GENERATION_STORY_BUFFER_MAX_FRAMES
      || this.bytes + bytes > GENERATION_STORY_BUFFER_MAX_BYTES
    ) {
      // A conflicting duplicate is no more trustworthy than an overflow. Only a
      // newer authoritative baseline may cover what this bounded buffer lost.
      this.discardedThrough = Math.max(event.chunkSeq, ...this.frames.keys());
      this.frames.clear();
      this.bytes = 0;
      return;
    }
    this.frames.set(event.chunkSeq, { event, bytes });
    this.bytes += bytes;
  }

  rebase(nextChunkSeq: number): {
    readonly markdown: string;
    readonly nextChunkSeq: number;
    readonly gap: GenerationStoryGap | null;
  } {
    if (this.discardedThrough !== null) {
      if (nextChunkSeq <= this.discardedThrough) {
        return {
          markdown: '',
          nextChunkSeq,
          gap: { expectedChunkSeq: nextChunkSeq, receivedChunkSeq: this.discardedThrough },
        };
      }
      this.discardedThrough = null;
    }
    let markdown = '';
    for (const [seq, frame] of [...this.frames].sort(([left], [right]) => left - right)) {
      if (seq > nextChunkSeq) {
        return { markdown, nextChunkSeq, gap: { expectedChunkSeq: nextChunkSeq, receivedChunkSeq: seq } };
      }
      if (seq < nextChunkSeq) {
        this.frames.delete(seq);
        this.bytes -= frame.bytes;
        continue;
      }
      // Retain this suffix if a later hole needs another GET whose snapshot may
      // still predate these frames. A successful recovery drops the whole buffer.
      markdown += frame.event.payload.delta;
      nextChunkSeq += 1;
    }
    return { markdown, nextChunkSeq, gap: null };
  }
}
