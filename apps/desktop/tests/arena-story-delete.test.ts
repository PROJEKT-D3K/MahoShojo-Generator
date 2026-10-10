import { describe, expect, it, vi } from 'vitest';
import { type StoryRecordDescriptor, type StorySessionHead } from '@mahoshojo/contracts/desktop-arena-story';
import { createIpcStoryNativePort, STORY_IPC, type StoryInvoke } from '../src/platform/arena-story-native';
import { prepareStorySessionDeletion, deleteStorySession, observeStorySessionDeletion, type StoryNativePort } from '../src/platform/arena-story-storage';

const descriptor: StoryRecordDescriptor = { instance: 'a'.repeat(32), sessionId: 'story', recordId: 'story', revision: 1, kind: 'session', byteLength: 300, digest: `sha256:${'b'.repeat(64)}` };
const head: StorySessionHead = { id: 'story', revision: 1, titlePreview: '故事', titleTruncated: false, mode: 'classic', createdAt: 1, updatedAt: 2, chapterCount: 1, lastChapterId: 'chapter-1' };
const port = (): StoryNativePort => ({ begin: vi.fn(), append: vi.fn(), end: vi.fn(), abort: vi.fn(), receipt: vi.fn(), listSessions: vi.fn(), listChapters: vi.fn(), describe: vi.fn(async () => ({ ...descriptor })), read: vi.fn(), continueState: vi.fn(), deleteSession: vi.fn() });
const failure = (code: string) => ({ code, message: 'native checked failure', writeEvidence: code === 'story-commit-unknown' ? 'unknown' : 'not-written' });

describe('confirmed local story deletion adapter', () => {
  it('freezes one freshly described clicked generation without hydrating body or changing target', async () => {
    const native = port(), target = await prepareStorySessionDeletion(native, head);
    expect(target).toEqual({ session: descriptor, expectedLastChapterId: 'chapter-1', expectedChapterCount: 1 });
    expect(Object.isFrozen(target)).toBe(true); expect(Object.isFrozen(target.session)).toBe(true);
    expect(native.describe).toHaveBeenCalledWith('story', 1, 'session', 'story');
    expect(native.read).not.toHaveBeenCalled(); expect(native.continueState).not.toHaveBeenCalled();
    for (const patch of [{ sessionId: 'other' }, { recordId: 'other' }, { revision: 2 }, { kind: 'seed' }]) {
      vi.mocked(native.describe).mockResolvedValueOnce({ ...descriptor, ...patch });
      await expect(prepareStorySessionDeletion(native, head)).rejects.toThrow();
    }
    expect(native.deleteSession).not.toHaveBeenCalled();
  });
  it('dispatches the closed small target once through the default IPC binder', async () => {
    const invoke = vi.fn<StoryInvoke>(), native = createIpcStoryNativePort(invoke);
    invoke.mockResolvedValueOnce(descriptor);
    const target = await prepareStorySessionDeletion(native, head);
    const response = { target, status: 'deleted', deletedChapterCount: 1, deletedCheckpointCount: 2 };
    invoke.mockResolvedValueOnce(response);
    expect(await deleteStorySession(native, target)).toEqual(response);
    expect(invoke.mock.calls).toEqual([[STORY_IPC.describe, { sessionId: 'story', revision: 1, kind: 'session', recordId: 'story' }], [STORY_IPC.deleteSession, { target }]]);
  });
  it('captures primitive head fields before the descriptor read yields', async () => {
    const native = port(), clicked = { ...head };
    let resolve!: (value: unknown) => void;
    vi.mocked(native.describe).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = prepareStorySessionDeletion(native, clicked);
    Object.assign(clicked, { id: 'new-selection', revision: 2, lastChapterId: 'new-chapter', chapterCount: 2 });
    resolve(descriptor);
    expect(await pending).toEqual({ session: descriptor, expectedLastChapterId: 'chapter-1', expectedChapterCount: 1 });
  });
  it('rejects nonexact or malformed success as unknown rather than safely repeating deletion', async () => {
    const native = port(), target = await prepareStorySessionDeletion(native, head);
    for (const response of [undefined, { target: { ...target, expectedLastChapterId: 'other' }, status: 'deleted', deletedChapterCount: 1, deletedCheckpointCount: 2 }, { target, status: 'currently-absent', deletedChapterCount: 1, deletedCheckpointCount: 0 }]) {
      vi.mocked(native.deleteSession).mockResolvedValueOnce(response);
      await expect(deleteStorySession(native, target)).rejects.toMatchObject({ evidence: 'unknown' });
    }
    expect(native.deleteSession).toHaveBeenCalledTimes(3); expect(native.receipt).not.toHaveBeenCalled();
  });
  it('distinguishes checked rollback failures from transport loss and unresolved commits', async () => {
    const native = port(), target = await prepareStorySessionDeletion(native, head);
    for (const cause of [new Error('lost ACK'), failure('story-commit-unknown'), { ...failure('story-stale'), writeEvidence: 'unknown' }]) {
      vi.mocked(native.deleteSession).mockRejectedValueOnce(cause);
      await expect(deleteStorySession(native, target)).rejects.toMatchObject({ evidence: 'unknown' });
    }
    for (const code of ['story-stale', 'story-staging-busy', 'story-corrupt', 'story-io', 'maintenance-busy']) {
      vi.mocked(native.deleteSession).mockRejectedValueOnce(failure(code));
      await expect(deleteStorySession(native, target)).rejects.toMatchObject({ evidence: 'not-written' });
    }
    expect(native.begin).not.toHaveBeenCalled(); expect(native.receipt).not.toHaveBeenCalled();
  });
  it('observes absent, unchanged, changed and unknown only with original describe', async () => {
    const native = port(), target = await prepareStorySessionDeletion(native, head);
    expect(await observeStorySessionDeletion(native, target)).toBe('unchanged');
    for (const patch of [{ instance: 'f'.repeat(32) }, { digest: `sha256:${'f'.repeat(64)}` }, { revision: 2 }, { byteLength: 301 }]) {
      vi.mocked(native.describe).mockResolvedValueOnce({ ...descriptor, ...patch });
      expect(await observeStorySessionDeletion(native, target)).toBe('changed');
    }
    for (const [code, expected] of [['story-missing', 'currently-absent'], ['story-stale', 'changed'], ['story-io', 'unknown'], ['story-corrupt', 'unknown'], ['story-commit-unknown', 'unknown']]) {
      vi.mocked(native.describe).mockRejectedValueOnce(failure(code!));
      expect(await observeStorySessionDeletion(native, target)).toBe(expected);
    }
    vi.mocked(native.describe).mockRejectedValueOnce(new Error('missing'));
    expect(await observeStorySessionDeletion(native, target)).toBe('unknown');
    vi.mocked(native.describe).mockResolvedValueOnce(null);
    expect(await observeStorySessionDeletion(native, target)).toBe('unknown');
    expect(native.deleteSession).not.toHaveBeenCalled(); expect(native.begin).not.toHaveBeenCalled(); expect(native.read).not.toHaveBeenCalled(); expect(native.listSessions).not.toHaveBeenCalled();
    expect(vi.mocked(native.describe).mock.calls.every((args) => JSON.stringify(args) === JSON.stringify(['story', 1, 'session', 'story']))).toBe(true);
  });
});
