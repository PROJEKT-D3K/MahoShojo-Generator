import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STORY_TAIL_REWRITE_REQUEST_DOMAIN, STORY_TAIL_REWRITE_WIRE_BYTES,
  StoryTailRewriteManifestSchema, StoryTailRewriteReceiptSchema, StoryTailRewriteSourceDescriptorsSchema,
  encodeStoryTailRewriteManifest, encodeStoryTailRewriteRequestPreimage, encodeStoryTailRewriteReceipt,
  decodeStoryTailRewriteManifest, decodeStoryTailRewriteReceipt,
  type StoryTailRewriteManifest, type StoryTailRewriteReceipt,
} from '../src/desktop-arena-story-tail-rewrite';
import { STORY_CANDIDATE_COMMIT_BYTES, StoryCommitManifestSchema, StoryReceiptSchema } from '../src/desktop-arena-story';
import { StoryBranchManifestSchema, StoryBranchReceiptSchema } from '../src/desktop-arena-story-branch';
import fixture from '../fixtures/desktop-story-tail-rewrite-storage.json';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const manifest = (): StoryTailRewriteManifest => structuredClone(fixture.cases[0]!.manifest) as StoryTailRewriteManifest;
const receipt = (): StoryTailRewriteReceipt => structuredClone(fixture.cases[0]!.receipt) as StoryTailRewriteReceipt;
const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;

describe('closed internal Native tail rewrite v3 wire', () => {
  it('exports the explicit leaf and shared static fixture', async () => {
    const leaf = await import('@mahoshojo/contracts/desktop-arena-story-tail-rewrite');
    const exported = await import('@mahoshojo/contracts/fixtures/desktop-story-tail-rewrite-storage.json');
    expect(leaf.encodeStoryTailRewriteManifest(manifest())).toBe(encodeStoryTailRewriteManifest(manifest()));
    expect(exported.default).toEqual(fixture);
  });

  it.each(fixture.cases)('pins Rust serde order, independent request domain and exact receipt: $name', entry => {
    expect(encodeStoryTailRewriteManifest(reverse(entry.manifest))).toBe(entry.manifestJson);
    expect(decodeStoryTailRewriteManifest(entry.manifestJson)).toEqual(entry.manifest);
    const preimage = encodeStoryTailRewriteRequestPreimage(entry.manifest);
    expect(new TextDecoder().decode(preimage)).toBe(STORY_TAIL_REWRITE_REQUEST_DOMAIN + entry.manifestJson);
    expect(hash(preimage)).toBe(entry.requestDigest);
    expect(hash(entry.manifestJson)).not.toBe(entry.requestDigest);
    expect(encodeStoryTailRewriteReceipt(reverse(entry.receipt))).toBe(entry.receiptJson);
    expect(decodeStoryTailRewriteReceipt(entry.receiptJson)).toEqual(entry.receipt);
    expect(Buffer.byteLength(entry.manifestJson)).toBeLessThanOrEqual(STORY_TAIL_REWRITE_WIRE_BYTES);
    expect(Buffer.byteLength(entry.receiptJson)).toBeLessThanOrEqual(STORY_TAIL_REWRITE_WIRE_BYTES);
    expect(StoryCommitManifestSchema.safeParse(entry.manifest).success).toBe(false);
    expect(StoryBranchManifestSchema.safeParse(entry.manifest).success).toBe(false);
    expect(StoryReceiptSchema.safeParse(entry.receipt).success).toBe(false);
    expect(StoryBranchReceiptSchema.safeParse(entry.receipt).success).toBe(false);
    for (const [index, part] of entry.parts.entries()) {
      expect(entry.manifest.parts[index]).toEqual({ kind: part.kind, byteLength: Buffer.byteLength(part.document), digest: hash(part.document) });
    }
  });

  it('pins every original proof to the exact Native source bytes', () => {
    for (const entry of fixture.cases) {
      const count = entry.sourceCommitCount, current = fixture.sourceCommits[count - 1]!;
      const input = count === 1 ? fixture.sourceCommits[0]!.parts.find(p => p.kind === 'checkpoint0')!
        : fixture.sourceCommits[count - 2]!.parts.find(p => p.kind === 'checkpoint1')!;
      for (const [key, part] of [['session', current.parts.find(p => p.kind === 'session')!],
        ['chapter', current.parts.find(p => p.kind === 'chapter')!], ['inputCheckpoint', input]] as const) {
        expect(entry.manifest.source[key]).toEqual({ byteLength: Buffer.byteLength(part.document), digest: hash(part.document) });
      }
      expect(JSON.parse(input.document).boundaryIndex).toBe(count - 1);
      expect(current.parts[0]!.document).toContain('"opaque":1e+02,"opaque":');
    }
  });

  it('binds changes to every frozen authority and part declaration', () => {
    const original = manifest(), originalHash = hash(encodeStoryTailRewriteRequestPreimage(original));
    const alternatives: StoryTailRewriteManifest[] = [];
    for (const key of ['operationId', 'sessionId'] as const) alternatives.push({ ...original, [key]: `different_${key}` });
    for (const [key, value] of Object.entries({ expectedInstance: 'f'.repeat(32), expectedRevision: 2,
      targetChapterId: 'different_target', inputCheckpointId: 'different_input' })) {
      alternatives.push({ ...original, source: { ...original.source, [key]: value } });
    }
    const third = structuredClone(fixture.cases[1]!.manifest) as StoryTailRewriteManifest;
    alternatives.push({ ...original, source: { ...third.source } });
    for (const key of ['session', 'chapter', 'inputCheckpoint'] as const) {
      alternatives.push({ ...original, source: { ...original.source, [key]: { ...original.source[key], byteLength: 1 } } });
      alternatives.push({ ...original, source: { ...original.source, [key]: { ...original.source[key], digest: `sha256:${'f'.repeat(64)}` } } });
    }
    for (let index = 0; index < 3; index += 1) {
      const changed = manifest(); changed.parts[index]!.byteLength += 1; alternatives.push(changed);
      const hashed = manifest(); hashed.parts[index]!.digest = `sha256:${'f'.repeat(64)}`; alternatives.push(hashed);
    }
    for (const changed of alternatives) expect(hash(encodeStoryTailRewriteRequestPreimage(changed))).not.toBe(originalHash);
  });

  it('rejects unknown members at each depth and reordered, missing or duplicated parts', () => {
    const value = manifest();
    expect(StoryTailRewriteManifestSchema.safeParse({ ...value, extra: true }).success).toBe(false);
    expect(StoryTailRewriteManifestSchema.safeParse({ ...value, source: { ...value.source, extra: true } }).success).toBe(false);
    expect(StoryTailRewriteManifestSchema.safeParse({ ...value, source: { ...value.source, session: { ...value.source.session, extra: true } } }).success).toBe(false);
    for (const parts of [[...value.parts].reverse(), value.parts.slice(0, 2), [...value.parts, value.parts[0]],
      value.parts.map((part, index) => index === 1 ? value.parts[0] : part), value.parts.map(part => ({ ...part, extra: true }))]) {
      expect(StoryTailRewriteManifestSchema.safeParse({ ...value, parts }).success).toBe(false);
    }
    expect(StoryTailRewriteReceiptSchema.safeParse({ ...receipt(), extra: true }).success).toBe(false);
  });

  it('rejects duplicate raw JSON members including escaped aliases before normalization', () => {
    const encoded = encodeStoryTailRewriteManifest(manifest());
    for (const changed of [encoded.replace('"version":3', '"version":3,"version":3'),
      encoded.replace('"version":3', '"version":3,"\\u0076ersion":3'),
      encoded.replace('"byteLength":', '"byteLength":1,"byteLength":'),
      encoded.replace('"expectedInstance":', '"expectedInstance":"' + '0'.repeat(32) + '","expectedInstance":')]) {
      expect(() => decodeStoryTailRewriteManifest(changed)).toThrow();
    }
    const result = encodeStoryTailRewriteReceipt(receipt());
    expect(() => decodeStoryTailRewriteReceipt(result.replace('"version":3', '"version":3,"version":3'))).toThrow();
    expect(decodeStoryTailRewriteManifest(' \n' + encoded + '\t')).toEqual(manifest());
  });

  it('enforces raw byte ceilings, exact integer range, ASCII IDs and hash grammar', () => {
    const value = manifest();
    for (const operationId of ['', 'x'.repeat(129), '中文', 'a/b', 'a b', value.source.targetChapterId, value.source.inputCheckpointId]) {
      expect(StoryTailRewriteManifestSchema.safeParse({ ...value, operationId }).success).toBe(false);
    }
    for (const expectedRevision of [0, 0.5, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      expect(StoryTailRewriteManifestSchema.safeParse({ ...value, source: { ...value.source, expectedRevision } }).success).toBe(false);
    }
    for (const bad of ['SHA256:' + 'f'.repeat(64), 'sha256:' + 'F'.repeat(64), 'f'.repeat(64)]) {
      expect(StoryTailRewriteManifestSchema.safeParse({ ...value, source: { ...value.source, session: { byteLength: 1, digest: bad } } }).success).toBe(false);
    }
    const oversized = manifest(); oversized.parts[0].byteLength = STORY_CANDIDATE_COMMIT_BYTES;
    expect(StoryTailRewriteManifestSchema.safeParse(oversized).success).toBe(false);
    const sourceBudget = manifest();
    for (const key of ['session', 'chapter', 'inputCheckpoint'] as const) sourceBudget.source[key].byteLength = STORY_CANDIDATE_COMMIT_BYTES;
    expect(StoryTailRewriteManifestSchema.safeParse(sourceBudget).success).toBe(true);
    const exact = encodeStoryTailRewriteManifest(value).padEnd(2048, ' ');
    expect(decodeStoryTailRewriteManifest(exact)).toEqual(value);
    expect(() => decodeStoryTailRewriteManifest(exact + ' ')).toThrow();
    expect(() => decodeStoryTailRewriteManifest(' '.repeat(2048) + encodeStoryTailRewriteManifest(value))).toThrow();
    expect(() => decodeStoryTailRewriteReceipt(' '.repeat(2048) + encodeStoryTailRewriteReceipt(receipt()))).toThrow();
    expect(() => decodeStoryTailRewriteManifest('{"version":3')).toThrow();
  });

  it('rejects non-u64 numeric spellings before JavaScript can round them', () => {
    const encoded = encodeStoryTailRewriteManifest(manifest());
    for (const token of ['1.0', '1e0', '1.0000000000000001', '9007199254740990.1', '-0', '9007199254740992']) {
      expect(() => decodeStoryTailRewriteManifest(encoded.replace('"expectedRevision":1', `"expectedRevision":${token}`))).toThrow();
    }
    const encodedReceipt = encodeStoryTailRewriteReceipt(receipt());
    expect(() => decodeStoryTailRewriteReceipt(encodedReceipt.replace('"revision":2', '"revision":2.0000000000000001'))).toThrow();
  });

  it('accepts maximum valid IDs and revisions while keeping the compact manifest bounded', () => {
    const value = manifest();
    value.operationId = 'o'.repeat(128); value.sessionId = 's'.repeat(128);
    value.source.targetChapterId = 't'.repeat(128); value.source.inputCheckpointId = 'i'.repeat(128);
    value.source.expectedRevision = Number.MAX_SAFE_INTEGER - 1;
    value.source.expectedChapterCount = Number.MAX_SAFE_INTEGER - 1;
    expect(Buffer.byteLength(encodeStoryTailRewriteManifest(value))).toBeLessThanOrEqual(2048);
    const result = receipt(); result.chapterIndex = result.chapterCount = Number.MAX_SAFE_INTEGER - 1;
    result.revision = Number.MAX_SAFE_INTEGER;
    expect(decodeStoryTailRewriteReceipt(encodeStoryTailRewriteReceipt(result))).toEqual(result);
  });

  it('keeps historical receipt revision independent from active count and binds all identities', () => {
    const value = receipt();
    expect(StoryTailRewriteReceiptSchema.parse({ ...value, revision: 50 }).revision).toBe(50);
    for (const changed of [{ ...value, revision: value.chapterCount }, { ...value, chapterCount: 2 },
      { ...value, operationId: 'other' }, { ...value, targetChapterId: value.chapterId },
      { ...value, checkpointId: value.inputCheckpointId }, { ...value, checkpointId: value.chapterId }]) {
      expect(StoryTailRewriteReceiptSchema.safeParse(changed).success).toBe(false);
    }
  });

  it('requires the content window to include the old tail independently of the input checkpoint', () => {
    const { source, sessionId } = manifest();
    const seed = { instance: source.expectedInstance, sessionId, recordId: sessionId, revision: source.expectedRevision,
      kind: 'seed', ...source.session };
    const tail = { ...seed, kind: 'chapter', recordId: source.targetChapterId, ...source.chapter };
    const value = { source, seed, recentChapters: [tail] };
    expect(StoryTailRewriteSourceDescriptorsSchema.parse(value)).toEqual(value);
    expect(StoryTailRewriteSourceDescriptorsSchema.safeParse({ ...value, recentChapters: [] }).success).toBe(false);
    expect(StoryTailRewriteSourceDescriptorsSchema.safeParse({ ...value, recentChapters: [{ ...tail, recordId: source.inputCheckpointId }] }).success).toBe(false);
  });
});
