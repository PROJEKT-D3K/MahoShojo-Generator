import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StoryBranchManifestSchema, StoryBranchReceiptSchema,
  encodeStoryBranchManifest, encodeStoryBranchRequestPreimage, encodeStoryBranchReceipt,
  type StoryBranchManifest, type StoryBranchReceipt,
} from '@mahoshojo/contracts/desktop-arena-story-branch';
import { StoryCommitManifestSchema, type StoryCommitManifest, type StoryPartKind } from '@mahoshojo/contracts/desktop-arena-story';
import { buildCompletedBattleStoryBranchRecords } from '@mahoshojo/domain/arena-story-branch';
import { digestBattleStoryCommitValue } from '@mahoshojo/domain/arena-story-commit';
import { storyWireDigest } from '../src/platform/arena-story-storage';
import { branchCopyId, byteDigest, prepareBranchGoldenParts, type BranchAssembly } from './helpers/arena-story-branch-golden';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
type RawPart = { kind: StoryPartKind; document: string };
interface BranchGolden {
  name: string; assembly: BranchAssembly;
  expected: ReturnType<typeof buildCompletedBattleStoryBranchRecords>;
  manifest: StoryBranchManifest; manifestJson: string; requestDigest: string;
  receipt: StoryBranchReceipt; receiptJson: string; parts: RawPart[];
}
// Static shared bytes are read by the real Rust writer suite as well. No test
// regenerates expectations, and zero instance is ONLY a serializer golden.
const golden = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/desktop-story-branch-storage.json', import.meta.url), 'utf8')) as {
  sourceCommits: Array<{ manifest: StoryCommitManifest; wireDigest: string; parts: RawPart[] }>;
  cases: BranchGolden[];
  copyIds: Array<{ sessionId: string; kind: 'c' | 'p'; index: number; id: string }>;
};

const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;

describe('Native branch shared-domain storage contract goldens', () => {
  it.each(golden.copyIds)('matches Rust physical mapping across the u64 range: $kind/$index', (vector) => {
    expect(branchCopyId(vector.sessionId, vector.kind, vector.index)).toBe(vector.id);
  });

  it('rejects invalid copy namespaces and non-safe or invalid indices', () => {
    expect(() => branchCopyId('bad/namespace', 'p', 0)).toThrow();
    expect(() => branchCopyId('target', 'c', 0)).toThrow();
    for (const index of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => branchCopyId('target', 'p', index)).toThrow();
  });
  it.each(golden.cases)('projects real shared-domain records into the three raw storage carriers: $name', (fixture) => {
    const assembly = structuredClone(fixture.assembly);
    const before = structuredClone(assembly);
    const target = assembly.session.id;
    const records = buildCompletedBattleStoryBranchRecords({ ...assembly, mapChapterId: (id) => {
      const match = /^source-c([1-3])$/u.exec(id);
      const index = match ? Number(match[1]) : 0;
      return index >= 1 && index <= assembly.prefixEndIndex ? branchCopyId(target, 'c', index) : undefined;
    } });
    expect(records).toEqual(fixture.expected);
    expect(assembly).toEqual(before);
    expect(records.chapter.action).toBe('branch');
    expect(records.chapter.sourceChapterId).toBe(branchCopyId(target, 'c', assembly.prefixEndIndex));
    expect(records.session.title).toBe(assembly.session.title);
    expect(records.session.summaryMeta?.coveredChapterIds).toEqual([branchCopyId(target, 'c', 1)]);
    const parts = prepareBranchGoldenParts(records, assembly.prefixEndIndex);
    expect(parts).toEqual(fixture.parts);
    expect(parts.map(({ kind }) => kind)).toEqual(['session', 'chapter', 'checkpoint1']);
    expect(parts.map(({ kind, document }) => ({ kind, byteLength: Buffer.byteLength(document), digest: byteDigest(document) }))).toEqual(fixture.manifest.parts);
    for (const part of parts) expect(digestBattleStoryCommitValue(JSON.parse(part.document))).toBe(byteDigest(part.document));
  });

  it.each(golden.cases)('matches ordered Rust manifest preimage and closed success receipt: $name', (fixture) => {
    expect(StoryBranchManifestSchema.parse(fixture.manifest)).toEqual(fixture.manifest);
    expect(StoryBranchReceiptSchema.parse(fixture.receipt)).toEqual(fixture.receipt);
    expect(encodeStoryBranchManifest(fixture.manifest)).toBe(fixture.manifestJson);
    expect(encodeStoryBranchManifest(reverseKeys(fixture.manifest))).toBe(fixture.manifestJson);
    expect(Buffer.from(encodeStoryBranchRequestPreimage(fixture.manifest)).toString('utf8')).toBe(`arena-story-branch-wire-v2\n${fixture.manifestJson}`);
    expect(byteDigest(encodeStoryBranchRequestPreimage(fixture.manifest))).toBe(fixture.requestDigest);
    expect(digestBattleStoryCommitValue(fixture.manifest)).not.toBe(fixture.requestDigest);
    expect(encodeStoryBranchReceipt(reverseKeys(fixture.receipt))).toBe(fixture.receiptJson);
    expect(Buffer.byteLength(fixture.receiptJson)).toBeLessThanOrEqual(2048);
    expect(fixture.receipt.requestDigest).toBe(fixture.requestDigest);
    expect(fixture.receipt.anchorCheckpointId).toBe(branchCopyId(fixture.manifest.sessionId, 'p', fixture.manifest.source.anchorIndex));
    expect(fixture.receipt.anchorChapterId).toBe(branchCopyId(fixture.manifest.sessionId, 'c', fixture.manifest.source.anchorIndex));
  });

  it('binds frozen source descriptors to the exact three-commit linear store bytes', async () => {
    expect(golden.sourceCommits).toHaveLength(3);
    for (const source of golden.sourceCommits) {
      expect(StoryCommitManifestSchema.parse(source.manifest)).toEqual(source.manifest);
      expect(await storyWireDigest(source.manifest)).toBe(source.wireDigest);
      expect(source.parts.map(({ kind, document }) => ({ kind, byteLength: Buffer.byteLength(document), digest: byteDigest(document) }))).toEqual(source.manifest.parts);
      for (const part of source.parts.filter(({ kind }) => kind === 'chapter' || kind.startsWith('checkpoint'))) {
        expect(part.document).toContain('"opaque":1e+02,"opaque":{"escaped":"\\u4e2d","lone":"\\ud800","duplicate":1,"duplicate":2}');
      }
      const chapter = JSON.parse(source.parts.find(({ kind }) => kind === 'chapter')!.document);
      expect(chapter.generationId).toBe(`historical-generation-${source.manifest.expectedRevision + 1}`);
    }
    for (const fixture of golden.cases) {
      const source = fixture.manifest.source;
      const descriptors = [source.session, source.seed, source.anchor, source.checkpoint];
      const documents = [golden.sourceCommits[2]!.parts[0]!.document, golden.sourceCommits[0]!.parts[1]!.document,
        golden.sourceCommits[source.anchorIndex - 1]!.parts.find(({ kind }) => kind === 'chapter')!.document,
        golden.sourceCommits[source.anchorIndex - 1]!.parts.find(({ kind }) => kind === 'checkpoint1')!.document];
      descriptors.forEach((descriptor, index) => {
        expect(descriptor.instance).toBe('0'.repeat(32));
        expect(descriptor.revision).toBe(3);
        expect(descriptor.byteLength).toBe(Buffer.byteLength(documents[index]!));
        expect(descriptor.digest).toBe(byteDigest(documents[index]!));
      });
    }
  });
});
