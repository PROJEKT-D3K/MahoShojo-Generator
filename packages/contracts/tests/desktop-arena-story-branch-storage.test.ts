import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STORY_BRANCH_RECEIPT_BYTES, STORY_BRANCH_REQUEST_DOMAIN,
  StoryBranchManifestSchema, StoryBranchReceiptSchema,
  encodeStoryBranchManifest, encodeStoryBranchReceipt, encodeStoryBranchRequestPreimage,
  type StoryBranchManifest, type StoryBranchReceipt,
} from '../src/desktop-arena-story-branch';
import { STORY_CANDIDATE_COMMIT_BYTES, StoryCommitManifestSchema, StoryReceiptSchema } from '../src/desktop-arena-story';
import fixture from '../fixtures/desktop-story-branch-storage.json';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = `sha256:${'f'.repeat(64)}`;
function manifest(): StoryBranchManifest {
  const descriptor = { instance: 'a'.repeat(32), sessionId: 'source', recordId: 'source',
    revision: 2, byteLength: 1, digest };
  return {
    version: 2, operationId: 'operation', sessionId: 'target', source: {
      session: { ...descriptor, kind: 'session' }, seed: { ...descriptor, kind: 'seed' },
      expectedLastChapterId: 'last', expectedChapterCount: 2,
      anchor: { ...descriptor, kind: 'chapter', recordId: 'anchor' }, anchorIndex: 1,
      checkpoint: { ...descriptor, kind: 'checkpoint', recordId: 'checkpoint' },
    },
    parts: [{ kind: 'session', byteLength: 1, digest }, { kind: 'chapter', byteLength: 1, digest },
      { kind: 'checkpoint1', byteLength: 1, digest }],
  };
}
function receipt(): StoryBranchReceipt {
  return { version: 2, kind: 'branch', operationId: 'operation', sessionId: 'target', chapterId: 'operation',
    chapterIndex: 2, revision: 2, chapterCount: 2, prefixEndIndex: 1,
    anchorChapterId: 'anchor', anchorCheckpointId: 'anchor_checkpoint', checkpointId: 'checkpoint', requestDigest: digest };
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)]));
  }
  return value;
}

describe('closed Native branch v2 storage contract', () => {
  it('uses the explicit leaf and shared fixture exports', async () => {
    const leaf = await import('@mahoshojo/contracts/desktop-arena-story-branch');
    const exported = await import('@mahoshojo/contracts/fixtures/desktop-story-branch-storage.json');
    expect(leaf.encodeStoryBranchManifest(manifest())).toBe(encodeStoryBranchManifest(manifest()));
    expect(exported.default).toEqual(fixture);
  });
  it('matches shared Native serializer and request digest goldens', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const entry of fixture.cases) {
      expect(encodeStoryBranchManifest(entry.manifest)).toBe(entry.manifestJson);
      expect(encodeStoryBranchManifest(reverseKeys(entry.manifest))).toBe(entry.manifestJson);
      expect(new TextDecoder().decode(encodeStoryBranchRequestPreimage(entry.manifest)))
        .toBe(STORY_BRANCH_REQUEST_DOMAIN + entry.manifestJson);
      expect(hash(encodeStoryBranchRequestPreimage(entry.manifest))).toBe(entry.requestDigest);
      expect(encodeStoryBranchReceipt(entry.receipt)).toBe(entry.receiptJson);
      expect(encodeStoryBranchReceipt(reverseKeys(entry.receipt))).toBe(entry.receiptJson);
      expect(StoryCommitManifestSchema.safeParse(entry.manifest).success).toBe(false);
      expect(StoryReceiptSchema.safeParse(entry.receipt).success).toBe(false);
    }
  });
  it('keeps explicit serde field order independent of input insertion order', () => {
    const encoded = encodeStoryBranchManifest(manifest());
    expect(encodeStoryBranchManifest(reverseKeys(manifest()))).toBe(encoded);
    const value = JSON.parse(encoded);
    expect(Object.keys(value)).toEqual(['version', 'operationId', 'sessionId', 'source', 'parts']);
    expect(Object.keys(value.source)).toEqual([
      'session', 'seed', 'expectedLastChapterId', 'expectedChapterCount', 'anchor', 'anchorIndex', 'checkpoint',
    ]);
    expect(Object.keys(value.source.anchor)).toEqual([
      'instance', 'sessionId', 'recordId', 'revision', 'kind', 'byteLength', 'digest',
    ]);
    expect(Object.keys(value.parts[0])).toEqual(['kind', 'byteLength', 'digest']);
  });
  it('binds every valid identity, hash, length, head, count, instance and anchor change', () => {
    const original = manifest();
    const originalDigest = hash(encodeStoryBranchRequestPreimage(original));
    const changedDigest = `sha256:${'e'.repeat(64)}`;
    // Core ESLint no-unused-vars also inspects this type-only parameter.
    // eslint-disable-next-line no-unused-vars
    const mutations: Array<[string, (value: StoryBranchManifest) => void]> = [
      ['operation', (value) => { value.operationId = 'other_operation'; }],
      ['target', (value) => { value.sessionId = 'other_target'; }],
      ['head', (value) => { value.source.expectedLastChapterId = 'other_head'; }],
      ['anchor ID', (value) => { value.source.anchor.recordId = 'other_anchor'; }],
      ['checkpoint ID', (value) => { value.source.checkpoint.recordId = 'other_checkpoint'; }],
      ['anchor index', (value) => { value.source.anchorIndex = 2; }],
      ['source identity', (value) => {
        for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) value.source[key].sessionId = 'other_source';
        value.source.session.recordId = 'other_source'; value.source.seed.recordId = 'other_source';
      }],
      ['source instance', (value) => {
        for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) value.source[key].instance = 'b'.repeat(32);
      }],
      ['source count and revision', (value) => {
        value.source.expectedChapterCount = 3;
        for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) value.source[key].revision = 3;
      }],
    ];
    for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) {
      mutations.push([`${key} hash`, (value) => { value.source[key].digest = changedDigest; }]);
      mutations.push([`${key} length`, (value) => { value.source[key].byteLength = 2; }]);
    }
    for (const index of [0, 1, 2] as const) {
      mutations.push([`part ${index} hash`, (value) => { value.parts[index].digest = changedDigest; }]);
      mutations.push([`part ${index} length`, (value) => { value.parts[index].byteLength = 2; }]);
    }
    for (const [name, mutate] of mutations) {
      const value = manifest(); mutate(value);
      expect(StoryBranchManifestSchema.safeParse(value).success, name).toBe(true);
      expect(hash(encodeStoryBranchRequestPreimage(value)), name).not.toBe(originalDigest);
    }
  });
  it('rejects unknown fields at every manifest depth', () => {
    const value = manifest();
    for (const invalid of [
      { ...value, extra: true }, { ...value, source: { ...value.source, extra: true } },
      ...(['session', 'seed', 'anchor', 'checkpoint'] as const).map((key) => ({
        ...value, source: { ...value.source, [key]: { ...value.source[key], extra: true } },
      })),
      { ...value, parts: [{ ...value.parts[0], extra: true }, ...value.parts.slice(1)] },
    ]) expect(() => encodeStoryBranchManifest(invalid)).toThrow();
  });
  it('enforces source identity, instance, revision, count and anchor bounds', () => {
    for (const mutate of [
      (v: StoryBranchManifest) => { v.version = 1 as 2; },
      (v: StoryBranchManifest) => { v.sessionId = v.source.session.sessionId; },
      (v: StoryBranchManifest) => { v.operationId = 'invalid/id'; },
      (v: StoryBranchManifest) => { v.source.session.recordId = 'other'; },
      (v: StoryBranchManifest) => { v.source.seed.recordId = 'other'; },
      (v: StoryBranchManifest) => { v.source.expectedChapterCount = 3; },
      (v: StoryBranchManifest) => { v.source.expectedLastChapterId = ''; },
      (v: StoryBranchManifest) => { v.source.anchorIndex = 0; },
      (v: StoryBranchManifest) => { v.source.anchorIndex = 3; },
      (v: StoryBranchManifest) => { v.source.anchorIndex = Number.MAX_SAFE_INTEGER; },
    ]) {
      const value = manifest(); mutate(value);
      expect(StoryBranchManifestSchema.safeParse(value).success).toBe(false);
    }
    for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) {
      for (const patch of [
        { instance: 'b'.repeat(32) }, { instance: 'A'.repeat(32) }, { sessionId: 'other' },
        { revision: 1 }, { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
        { byteLength: 0 }, { byteLength: STORY_CANDIDATE_COMMIT_BYTES + 1 },
        { digest: digest.toUpperCase() }, { recordId: 'x'.repeat(129) }, { kind: 'incorrect' },
      ]) {
        const value = manifest(); Object.assign(value.source[key], patch);
        expect(StoryBranchManifestSchema.safeParse(value).success, `${key}: ${JSON.stringify(patch)}`).toBe(false);
      }
    }
  });
  it('accepts safe integer boundaries and only three new parts within 128 MiB', () => {
    const value = manifest();
    value.source.expectedChapterCount = Number.MAX_SAFE_INTEGER;
    value.source.anchorIndex = Number.MAX_SAFE_INTEGER - 1;
    for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) {
      value.source[key].revision = Number.MAX_SAFE_INTEGER;
      value.source[key].byteLength = STORY_CANDIDATE_COMMIT_BYTES;
    }
    value.parts[0].byteLength = STORY_CANDIDATE_COMMIT_BYTES - 2;
    expect(StoryBranchManifestSchema.safeParse(value).success).toBe(true);
    value.parts[0].byteLength += 1;
    expect(StoryBranchManifestSchema.safeParse(value).success).toBe(false);
    const original = manifest();
    for (const parts of [original.parts.slice(0, 2), [...original.parts, original.parts[0]],
      [...original.parts].reverse(), [{ ...original.parts[0], kind: 'seed' }, ...original.parts.slice(1)],
      [{ ...original.parts[0], byteLength: 0 }, ...original.parts.slice(1)]]) {
      expect(StoryBranchManifestSchema.safeParse({ ...original, parts }).success).toBe(false);
    }
  });
  it('matches the 1123-byte maximal receipt and 2048-byte ceiling', () => {
    const value = { ...receipt(), operationId: 'o'.repeat(128), sessionId: 's'.repeat(128),
      chapterId: 'o'.repeat(128), anchorChapterId: 'a'.repeat(128), anchorCheckpointId: 'p'.repeat(128),
      checkpointId: 'q'.repeat(128), prefixEndIndex: Number.MAX_SAFE_INTEGER - 1,
      chapterIndex: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER, chapterCount: Number.MAX_SAFE_INTEGER };
    const encoded = encodeStoryBranchReceipt(value);
    expect(new TextEncoder().encode(encoded).byteLength).toBe(1123);
    expect(STORY_BRANCH_RECEIPT_BYTES).toBe(2048);
    expect(hash(encoded)).toBe('sha256:93d6b217eb2635b61b98b502f0b2ee9948d35cb8bef61320e4a2f4c1b0b67861');
  });
  it('rejects malformed receipts and never interprets copy markers as success', () => {
    const value = receipt();
    for (const patch of [
      { version: 1 }, { kind: 'branch-copy' }, { extra: true }, { chapterId: 'other' },
      { chapterIndex: 3 }, { revision: 3 }, { chapterCount: 3 }, { prefixEndIndex: 0 },
      { prefixEndIndex: Number.MAX_SAFE_INTEGER }, { anchorChapterId: value.chapterId },
      { anchorCheckpointId: value.checkpointId }, { requestDigest: digest.toUpperCase() },
      { operationId: 'x'.repeat(129) }, { sessionId: 'invalid/id' },
    ]) expect(() => encodeStoryBranchReceipt({ ...value, ...patch })).toThrow();
    expect(StoryBranchReceiptSchema.safeParse({ version: 2, kind: 'branch-copy', branchOperationId: 'operation',
      sessionId: 'target', chapterId: 'copy', chapterIndex: 1, sourceSessionId: 'source',
      sourceChapterId: 'anchor', requestDigest: digest }).success).toBe(false);
  });
});

it('keeps source revision independent from the active chapter count', () => {
  const value = manifest();
  for (const key of ['session', 'seed', 'anchor', 'checkpoint'] as const) value.source[key].revision = 4;
  expect(StoryBranchManifestSchema.parse(value).source.expectedChapterCount).toBe(2);
  expect(StoryBranchManifestSchema.parse(value).source.session.revision).toBe(4);
});
