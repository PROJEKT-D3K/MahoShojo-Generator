import { createHash } from 'node:crypto';
import type { buildCompletedBattleStoryBranchRecords } from '@mahoshojo/domain/arena-story-branch';
export { branchCopyId } from '../../src/platform/arena-story-branch-storage';
export const byteDigest = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export type BranchAssembly = Omit<Parameters<typeof buildCompletedBattleStoryBranchRecords>[0], 'mapChapterId'>;
