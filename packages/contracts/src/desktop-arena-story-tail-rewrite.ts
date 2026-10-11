import { z } from './zod';
import { STORY_CANDIDATE_COMMIT_BYTES, StoryRecordDescriptorSchema } from './desktop-arena-story';

/** Independent Native v3 wire. Schema activation remains separate from IPC. */
export const STORY_TAIL_REWRITE_WIRE_BYTES = 2048;
export const STORY_TAIL_REWRITE_REQUEST_DOMAIN = 'arena-story-tail-rewrite-wire-v3\n';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const proof = z.object({ byteLength: integer.max(STORY_CANDIDATE_COMMIT_BYTES), digest }).strict();
const part = proof.extend({ kind: z.enum(['session', 'chapter', 'checkpoint1']) });

/** Record IDs and kind are fixed by the enclosing session, target and input CP.
 * Compact proofs avoid repeating those identities three times on the wire. */
export const StoryTailRewriteSourceSchema = z.object({
  expectedInstance: z.string().regex(/^[a-f0-9]{32}$/u),
  expectedRevision: integer.max(Number.MAX_SAFE_INTEGER - 1),
  expectedChapterCount: integer,
  targetChapterId: id,
  inputCheckpointId: id,
  session: proof,
  chapter: proof,
  inputCheckpoint: proof,
}).strict().refine(value => value.expectedChapterCount <= value.expectedRevision);
export type StoryTailRewriteSource = z.infer<typeof StoryTailRewriteSourceSchema>;

export const StoryTailRewriteSourceRequestSchema = z.object({
  sessionId: id, expectedRevision: integer.max(Number.MAX_SAFE_INTEGER - 1),
  expectedChapterCount: integer, targetChapterId: id,
}).strict().refine(value => value.expectedChapterCount <= value.expectedRevision);
export type StoryTailRewriteSourceRequest = z.infer<typeof StoryTailRewriteSourceRequestSchema>;

export const StoryTailRewriteSourceDescriptorsSchema = z.object({
  source: StoryTailRewriteSourceSchema,
  seed: StoryRecordDescriptorSchema.extend({ kind: z.literal('seed') }),
  recentChapters: z.array(StoryRecordDescriptorSchema.extend({ kind: z.literal('chapter') })).min(1).max(12),
}).strict().superRefine((value, context) => {
  const { source, seed, recentChapters } = value;
  const tail = recentChapters.at(-1)!;
  if (seed.recordId !== seed.sessionId || seed.instance !== source.expectedInstance
    || seed.revision !== source.expectedRevision
    || recentChapters.length !== Math.min(12, source.expectedChapterCount)
    || recentChapters.some(entry => entry.instance !== source.expectedInstance
      || entry.revision !== source.expectedRevision || entry.sessionId !== seed.sessionId)
    || new Set(recentChapters.map(entry => entry.recordId)).size !== recentChapters.length
    || tail.recordId !== source.targetChapterId || tail.byteLength !== source.chapter.byteLength
    || tail.digest !== source.chapter.digest) {
    context.addIssue({ code: 'custom', message: 'Invalid Native tail rewrite source descriptors' });
  }
});
export type StoryTailRewriteSourceDescriptors = z.infer<typeof StoryTailRewriteSourceDescriptorsSchema>;

export const StoryTailRewriteManifestSchema = z.object({
  version: z.literal(3), kind: z.literal('tail-rewrite'), operationId: id, sessionId: id,
  source: StoryTailRewriteSourceSchema,
  parts: z.tuple([
    part.extend({ kind: z.literal('session') }),
    part.extend({ kind: z.literal('chapter') }),
    part.extend({ kind: z.literal('checkpoint1') }),
  ]),
}).strict().superRefine((value, context) => {
  if (value.operationId === value.source.targetChapterId || value.operationId === value.source.inputCheckpointId
    || value.parts.reduce((sum, entry) => sum + entry.byteLength, 0) > STORY_CANDIDATE_COMMIT_BYTES
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > STORY_TAIL_REWRITE_WIRE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Invalid Native tail rewrite declaration' });
  }
});
export type StoryTailRewriteManifest = z.infer<typeof StoryTailRewriteManifestSchema>;

export const StoryTailRewriteReceiptSchema = z.object({
  version: z.literal(3), kind: z.literal('tail-rewrite'), operationId: id, sessionId: id, chapterId: id,
  chapterIndex: integer, revision: integer, chapterCount: integer,
  targetChapterId: id, inputCheckpointId: id, checkpointId: id, requestDigest: digest,
}).strict().superRefine((value, context) => {
  if (value.operationId !== value.chapterId || value.chapterIndex !== value.chapterCount
    || value.revision <= value.chapterCount || value.targetChapterId === value.chapterId
    || value.inputCheckpointId === value.checkpointId || value.checkpointId === value.chapterId
    || value.inputCheckpointId === value.chapterId
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > STORY_TAIL_REWRITE_WIRE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Invalid Native tail rewrite receipt' });
  }
});
export type StoryTailRewriteReceipt = z.infer<typeof StoryTailRewriteReceiptSchema>;

const orderedProof = (value: z.infer<typeof proof>) => ({ byteLength: value.byteLength, digest: value.digest });
/** Explicit Rust serde declaration order, independent of caller insertion order. */
export function encodeStoryTailRewriteManifest(input: unknown): string {
  const value = StoryTailRewriteManifestSchema.parse(input), source = value.source;
  return JSON.stringify({
    version: value.version, kind: value.kind, operationId: value.operationId, sessionId: value.sessionId,
    source: {
      expectedInstance: source.expectedInstance, expectedRevision: source.expectedRevision,
      expectedChapterCount: source.expectedChapterCount, targetChapterId: source.targetChapterId,
      inputCheckpointId: source.inputCheckpointId, session: orderedProof(source.session),
      chapter: orderedProof(source.chapter), inputCheckpoint: orderedProof(source.inputCheckpoint),
    },
    parts: value.parts.map(entry => ({ kind: entry.kind, byteLength: entry.byteLength, digest: entry.digest })),
  });
}
export function encodeStoryTailRewriteRequestPreimage(input: unknown): Uint8Array {
  return new TextEncoder().encode(STORY_TAIL_REWRITE_REQUEST_DOMAIN + encodeStoryTailRewriteManifest(input));
}
export function encodeStoryTailRewriteReceipt(input: unknown): string {
  const value = StoryTailRewriteReceiptSchema.parse(input);
  return JSON.stringify({
    version: value.version, kind: value.kind, operationId: value.operationId, sessionId: value.sessionId,
    chapterId: value.chapterId, chapterIndex: value.chapterIndex, revision: value.revision,
    chapterCount: value.chapterCount, targetChapterId: value.targetChapterId,
    inputCheckpointId: value.inputCheckpointId, checkpointId: value.checkpointId, requestDigest: value.requestDigest,
  });
}

/** Raw input is bounded before parsing. JSON.parse proves grammar; this small
 * token walk additionally rejects duplicate member names, including escaped aliases.
 * It never normalizes story originals, which intentionally permit opaque members. */
function decodeClosedWire(text: string): unknown {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > STORY_TAIL_REWRITE_WIRE_BYTES) {
    throw new RangeError('Native tail rewrite wire exceeds its byte limit');
  }
  const value: unknown = JSON.parse(text);
  const objects: Set<string>[] = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (!token.startsWith('"')) {
      // serde's u64 rejects fractional/exponent spellings, even when JS would
      // silently round them to an integer. Check the original numeric lexeme.
      if (!/^(?:0|[1-9]\d*)$/u.test(token) || !Number.isSafeInteger(Number(token))) {
        throw new Error('Invalid Native tail rewrite integer token');
      }
    } else if (/^\s*:/u.test(text.slice(match.index + token.length))) {
      const key: string = JSON.parse(token), keys = objects.at(-1)!;
      if (keys.has(key)) throw new Error('Duplicate Native tail rewrite member');
      keys.add(key);
    }
  }
  return value;
}
export const decodeStoryTailRewriteManifest = (text: string): StoryTailRewriteManifest =>
  StoryTailRewriteManifestSchema.parse(decodeClosedWire(text));
export const decodeStoryTailRewriteReceipt = (text: string): StoryTailRewriteReceipt =>
  StoryTailRewriteReceiptSchema.parse(decodeClosedWire(text));
