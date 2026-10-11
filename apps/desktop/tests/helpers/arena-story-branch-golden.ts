import { createHash } from 'node:crypto';
import {
  STORY_CANDIDATE_COMMIT_BYTES, StorySessionDocumentSchema, StoryChapterDocumentSchema, StoryCheckpointDocumentSchema,
  type StoryPartKind,
} from '@mahoshojo/contracts/desktop-arena-story';
import { prepareBattleStoryCommitJson } from '@mahoshojo/domain/arena-story-commit';
import { buildCompletedBattleStoryBranchRecords } from '@mahoshojo/domain/arena-story-branch';

/** Test-only physical allocator, matched against Rust copy_id by the shared fixture.
 * The production domain deliberately accepts the host allocator as a parameter. */
export const branchCopyId = (sessionId: string, kind: 'c' | 'p', index: number): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) || !Number.isSafeInteger(index)
    || index < (kind === 'c' ? 1 : 0)) throw new RangeError('Invalid branch copy identity');
  const numbers = Buffer.alloc(16);
  numbers.writeBigUInt64BE(BigInt(index));
  numbers.writeBigUInt64BE(BigInt(Buffer.byteLength(sessionId)), 8);
  return `branch_${createHash('sha256').update('maho:arena-story-branch-record:v1\0')
    .update(kind).update(numbers).update(sessionId).digest('hex')}`;
};
export const byteDigest = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export type BranchAssembly = Omit<Parameters<typeof buildCompletedBattleStoryBranchRecords>[0], 'mapChapterId'>;

/** Deliberately test-only: no branch IPC or Desktop owner is introduced here.
 * Linear prepareStoryStorageCommit rejects action=branch, so this keeps branch
 * intact and projects only the three native carriers, using the real shared
 * streaming encoder and existing carrier schemas. Rust tests are the writer oracle. */
export const prepareBranchGoldenParts = (records: ReturnType<typeof buildCompletedBattleStoryBranchRecords>, anchor: number) => {
  const { seed: _seed, workingCombatants: _working, lastChapterInputCombatants: _input, ...rest } = records.session;
  void _seed; void _working; void _input;
  const preview = (title: string) => {
    let titlePreview = ''; let bytes = 0; let consumed = 0;
    for (const character of title) {
      const encoded = new TextEncoder().encode(character);
      if (bytes + encoded.byteLength > 192) break;
      titlePreview += new TextDecoder().decode(encoded); bytes += encoded.byteLength; consumed += character.length;
    }
    return { titlePreview, titleTruncated: consumed < title.length };
  };
  const session = { ...rest, revision: anchor + 1, ...preview(rest.title), mode: (rest.source as { mode: string }).mode,
    workingCheckpointId: records.checkpoints[0]!.id,
    lastInputCheckpointId: branchCopyId(rest.id, 'p', anchor) };
  const chapter = { ...records.chapter, ...preview(records.chapter.title), markdownByteLength: Buffer.byteLength(records.chapter.markdown) };
  StorySessionDocumentSchema.parse(session);
  StoryChapterDocumentSchema.parse(chapter);
  StoryCheckpointDocumentSchema.parse(records.checkpoints[0]);
  const values: Array<[StoryPartKind, unknown]> = [['session', session], ['chapter', chapter], ['checkpoint1', records.checkpoints[0]]];
  let remainingBytes = STORY_CANDIDATE_COMMIT_BYTES;
  return values.map(([kind, value]) => {
    const prepared = prepareBattleStoryCommitJson(value, remainingBytes);
    remainingBytes -= prepared.byteLength;
    return { kind, document: Buffer.concat([...prepared.chunks()]).toString('utf8') };
  });
};
