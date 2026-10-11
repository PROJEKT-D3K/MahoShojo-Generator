import { z } from './zod';
import { STORY_CANDIDATE_COMMIT_BYTES, StoryRecordDescriptorSchema } from './desktop-arena-story';

/** Closed Native storage v2 only: not a Hosted request or a registered IPC command. */
export const STORY_BRANCH_RECEIPT_BYTES = 2048;
export const STORY_BRANCH_REQUEST_DOMAIN = 'arena-story-branch-wire-v2\n';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const part = z.object({
  kind: z.enum(['session', 'chapter', 'checkpoint1']),
  byteLength: integer.max(STORY_CANDIDATE_COMMIT_BYTES), digest,
}).strict();

export const StoryBranchSourceSchema = z.object({
  session: StoryRecordDescriptorSchema.extend({ kind: z.literal('session') }),
  seed: StoryRecordDescriptorSchema.extend({ kind: z.literal('seed') }),
  expectedLastChapterId: id,
  expectedChapterCount: integer,
  anchor: StoryRecordDescriptorSchema.extend({ kind: z.literal('chapter') }),
  anchorIndex: integer.max(Number.MAX_SAFE_INTEGER - 1),
  checkpoint: StoryRecordDescriptorSchema.extend({ kind: z.literal('checkpoint') }),
}).strict().superRefine((value, context) => {
  if (value.session.recordId !== value.session.sessionId
    || value.seed.recordId !== value.session.sessionId
    || value.session.revision < value.expectedChapterCount
    || value.anchorIndex > value.expectedChapterCount
    || [value.seed, value.anchor, value.checkpoint].some((descriptor) =>
      descriptor.sessionId !== value.session.sessionId
      || descriptor.instance !== value.session.instance
      || descriptor.revision !== value.session.revision)) {
    context.addIssue({ code: 'custom', message: 'Invalid Native branch source identity' });
  }
});
export type StoryBranchSource = z.infer<typeof StoryBranchSourceSchema>;

/** Internal read-only resolution; intentionally no registered command or binder. */
export const StoryBranchAnchorRequestSchema = z.object({
  sessionId: id, revision: integer, expectedLastChapterId: id, expectedChapterCount: integer,
  anchorChapterId: id, anchorIndex: integer.max(Number.MAX_SAFE_INTEGER - 1),
}).strict().refine(value => value.revision >= value.expectedChapterCount && value.anchorIndex <= value.expectedChapterCount);
export type StoryBranchAnchorRequest = z.infer<typeof StoryBranchAnchorRequestSchema>;
export const StoryBranchAnchorDescriptorsSchema = z.object({
  source: StoryBranchSourceSchema,
  recentChapters: z.array(StoryRecordDescriptorSchema.extend({ kind: z.literal('chapter') })).min(1).max(12),
}).strict();


export const StoryBranchManifestSchema = z.object({
  version: z.literal(2), operationId: id, sessionId: id,
  source: StoryBranchSourceSchema,
  parts: z.tuple([
    part.extend({ kind: z.literal('session') }),
    part.extend({ kind: z.literal('chapter') }),
    part.extend({ kind: z.literal('checkpoint1') }),
  ]),
}).strict().superRefine((value, context) => {
  if (value.sessionId === value.source.session.sessionId
    || value.parts.reduce((sum, entry) => sum + entry.byteLength, 0) > STORY_CANDIDATE_COMMIT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Invalid Native branch declaration' });
  }
});
export type StoryBranchManifest = z.infer<typeof StoryBranchManifestSchema>;

export const StoryBranchReceiptSchema = z.object({
  version: z.literal(2), kind: z.literal('branch'), operationId: id, sessionId: id, chapterId: id,
  chapterIndex: integer, revision: integer, chapterCount: integer,
  prefixEndIndex: integer.max(Number.MAX_SAFE_INTEGER - 1),
  anchorChapterId: id, anchorCheckpointId: id, checkpointId: id, requestDigest: digest,
}).strict().superRefine((value, context) => {
  if (value.operationId !== value.chapterId
    || value.chapterIndex !== value.prefixEndIndex + 1
    || value.revision !== value.chapterIndex
    || value.chapterCount !== value.chapterIndex
    || value.anchorChapterId === value.chapterId
    || value.anchorCheckpointId === value.checkpointId) {
    context.addIssue({ code: 'custom', message: 'Invalid Native branch receipt relationships' });
  }
});
export type StoryBranchReceipt = z.infer<typeof StoryBranchReceiptSchema>;

function orderedDescriptor(value: z.infer<typeof StoryRecordDescriptorSchema>) {
  return {
    instance: value.instance, sessionId: value.sessionId, recordId: value.recordId,
    revision: value.revision, kind: value.kind, byteLength: value.byteLength, digest: value.digest,
  };
}

/** Rust serde struct declaration order, not generic sorted-key canonical JSON.
 * Explicit reconstruction makes input object insertion order irrelevant. All
 * strings in this closed shape are ASCII, and every integer is JS-safe.
 */
export function encodeStoryBranchManifest(input: unknown): string {
  const value = StoryBranchManifestSchema.parse(input);
  const source = value.source;
  return JSON.stringify({
    version: value.version, operationId: value.operationId, sessionId: value.sessionId,
    source: {
      session: orderedDescriptor(source.session), seed: orderedDescriptor(source.seed),
      expectedLastChapterId: source.expectedLastChapterId, expectedChapterCount: source.expectedChapterCount,
      anchor: orderedDescriptor(source.anchor), anchorIndex: source.anchorIndex,
      checkpoint: orderedDescriptor(source.checkpoint),
    },
    parts: value.parts.map((entry) => ({ kind: entry.kind, byteLength: entry.byteLength, digest: entry.digest })),
  });
}

/** Caller supplies SHA-256; the contract leaf has no crypto/runtime dependency. */
export function encodeStoryBranchRequestPreimage(input: unknown): Uint8Array {
  return new TextEncoder().encode(STORY_BRANCH_REQUEST_DOMAIN + encodeStoryBranchManifest(input));
}

/** Success receipts only; branch-copy markers deliberately have no success codec. */
export function encodeStoryBranchReceipt(input: unknown): string {
  const value = StoryBranchReceiptSchema.parse(input);
  const encoded = JSON.stringify({
    version: value.version, kind: value.kind, operationId: value.operationId, sessionId: value.sessionId,
    chapterId: value.chapterId, chapterIndex: value.chapterIndex, revision: value.revision,
    chapterCount: value.chapterCount, prefixEndIndex: value.prefixEndIndex,
    anchorChapterId: value.anchorChapterId, anchorCheckpointId: value.anchorCheckpointId,
    checkpointId: value.checkpointId, requestDigest: value.requestDigest,
  });
  if (new TextEncoder().encode(encoded).byteLength > STORY_BRANCH_RECEIPT_BYTES) {
    throw new RangeError('Native branch receipt exceeds its byte limit');
  }
  return encoded;
}
