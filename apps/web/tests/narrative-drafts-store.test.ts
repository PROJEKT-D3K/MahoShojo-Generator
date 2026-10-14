import { describe, expect, it } from 'vitest';
import { createNarrativeDraftsStore, NARRATIVE_DRAFTS_STORAGE_KEY } from '@/components/arena/stores/useNarrativeDraftsStore';
import { createNarrativeDraftCandidate } from '@mahoshojo/domain/narrative-drafts';

const draft = (requestId = 'request-one') => createNarrativeDraftCandidate({ requestId, createdAt: '2026-10-14T00:00:00Z', source: 'hosted', acceptedText: '# 未完成\n正文', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' }, reportFormat: 'markdown', generationMode: 'stream', current: true, cancelled: false, completed: false })!;
const backend = () => {
  const map = new Map<string, string>();
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
};
describe('independent unfinished draft storage', () => {
  it('persists only the dedicated archive and reopens it without formal entries', () => {
    const disk = backend(), first = createNarrativeDraftsStore(disk);
    first.getState().offerDraft(draft(), true);
    expect(first.getState().status).toBe('stored');
    expect([...disk.map.keys()]).toEqual([NARRATIVE_DRAFTS_STORAGE_KEY]);
    expect(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).not.toContain('"entries"');
    const reopened = createNarrativeDraftsStore(disk); reopened.getState().loadDrafts();
    expect(reopened.getState().drafts).toEqual([draft()]);
  });
  it('requires explicit saving when disabled or terminal is unconfirmed', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk);
    state.getState().offerDraft(draft(), false);
    expect(state.getState().status).toBe('available'); expect(disk.map.size).toBe(0);
    state.getState().saveCandidate(); expect(state.getState().status).toBe('stored');
    const unknown = { ...draft('request-two'), completion: { kind: 'unconfirmed' } as const };
    state.getState().offerDraft(unknown, true); expect(state.getState().status).toBe('available');
    expect(state.getState().drafts).toEqual([draft()]);
  });
  it('keeps old disk and exportable memory on quota failure or damaged storage', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk);
    state.getState().offerDraft(draft(), true);
    const old = disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY);
    disk.setItem = () => { throw new Error('quota'); };
    state.getState().offerDraft(draft('request-two'), true);
    expect(state.getState().status).toBe('memory-only'); expect(state.getState().drafts).toHaveLength(2);
    expect(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBe(old);
    const broken = backend(); broken.map.set(NARRATIVE_DRAFTS_STORAGE_KEY, '{broken');
    const damaged = createNarrativeDraftsStore(broken); damaged.getState().offerDraft(draft(), true);
    expect(damaged.getState().status).toBe('memory-only'); expect(damaged.getState().candidate).toEqual(draft());
    expect(broken.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBe('{broken');
  });
  it('merges observed different-tab IDs and rejects conflicting same-ID text', () => {
    const disk = backend(), a = createNarrativeDraftsStore(disk), b = createNarrativeDraftsStore(disk);
    a.getState().offerDraft(draft(), true); b.getState().offerDraft(draft('request-two'), true);
    a.getState().observeStorage(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY));
    expect(a.getState().drafts).toHaveLength(2);
    a.getState().offerDraft({ ...draft(), markdown: '更长正文不得替换'.repeat(9) }, true);
    expect(a.getState().drafts[0]).toEqual(draft());
    expect(a.getState().candidate?.markdown).toContain('更长正文不得替换');
    a.getState().saveCandidate();
    expect(a.getState().status).toBe('memory-only');
    expect(a.getState().drafts[0]).toEqual(draft());
    expect(createNarrativeDraftsStore(disk).getState().drafts).toEqual([]);
  });
  it('does not claim an unsaved candidate is stored after another request completes', () => {
    const state = createNarrativeDraftsStore(backend());
    state.getState().offerDraft(draft(), false);
    state.getState().completeRequest('request-other');
    expect(state.getState().status).toBe('available'); expect(state.getState().drafts).toEqual([]);
  });
  it('applies a different tab completion even when this tab already completed another scope', () => {
    const disk = backend(), a = createNarrativeDraftsStore(disk), b = createNarrativeDraftsStore(disk);
    a.getState().offerDraft(draft('request-a'), true); b.getState().loadDrafts();
    b.getState().completeRequest('request-b');
    b.getState().offerDraft(draft('request-a'), false);
    a.getState().completeRequest('request-a');
    b.getState().observeStorage(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY));
    expect(b.getState().drafts).toEqual([]); expect(b.getState().candidate).toBeNull();
    expect(b.getState().completedRequestIds).toHaveLength(1);
    b.getState().offerDraft(draft('request-a'), false);
    expect(b.getState().candidate).toBeNull();
    expect(b.getState().drafts).toEqual([]);
  });
  it('never resurrects the completed current request, including after reopening', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk);
    state.getState().offerDraft(draft(), true); state.getState().completeRequest('request-one');
    state.getState().offerDraft(draft(), true); expect(state.getState().drafts).toEqual([]);
    const reopened = createNarrativeDraftsStore(disk); reopened.getState().offerDraft(draft(), true);
    expect(reopened.getState().drafts).toEqual([]); expect(reopened.getState().candidate).toBeNull();
    for (let i = 0; i < 10; i++) reopened.getState().completeRequest(`request-${i}`);
    expect(reopened.getState().completedRequestIds).toHaveLength(1);
  });
});
