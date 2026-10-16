import { describe, expect, it, vi } from 'vitest';
import { bindNarrativeDraftsUnloadProtection, createNarrativeDraftsStore, isNarrativeDraftsStorageKey, NARRATIVE_DRAFTS_STORAGE_KEY } from '@/components/arena/stores/useNarrativeDraftsStore';
import { buildNarrativeDraftArchive, createNarrativeDraftCandidate } from '@mahoshojo/domain/narrative-drafts';

const draft = (requestId = 'request-one') => createNarrativeDraftCandidate({ requestId, createdAt: '2026-10-14T00:00:00Z', source: 'hosted', acceptedText: '# 未完成\n正文', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' }, reportFormat: 'markdown', generationMode: 'stream', current: true, cancelled: false, completed: false })!;
const backend = () => {
  const map = new Map<string, string>();
  return { map, get length() { return map.size; }, key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
};
const scope = 'account:one';
describe('scoped unfinished draft Web adapter', () => {
  it('does not save before account identity is ready', () => {
    const disk = backend(), store = createNarrativeDraftsStore(disk);
    store.getState().offerDraft(draft(), true);
    expect(disk.map.size).toBe(0); expect(store.getState().candidate).toBeNull();
    store.getState().setScope('anonymous'); store.getState().offerDraft(draft(), true);
    expect(store.getState().status).toBe('stored');
  });
  it('persists independent entries and reopens only the selected account', () => {
    const disk = backend(), first = createNarrativeDraftsStore(disk, scope);
    first.getState().offerDraft(draft(), true);
    expect(first.getState().status).toBe('stored');
    expect([...disk.map.keys()].every(key => key.includes(':v2:account%3Aone:entry:'))).toBe(true);
    expect([...disk.map.values()].join('')).not.toContain('"entries"');
    const reopened = createNarrativeDraftsStore(disk, scope); reopened.getState().loadDrafts();
    expect(reopened.getState().drafts).toEqual([draft()]);
    reopened.getState().setScope('account:two'); expect(reopened.getState().drafts).toEqual([]);
    reopened.getState().setScope(scope); expect(reopened.getState().drafts).toEqual([draft()]);
  });
  it('requires explicit saving when disabled or terminal is unconfirmed', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope);
    state.getState().offerDraft(draft(), false);
    expect(state.getState().status).toBe('available'); expect(disk.map.size).toBe(0);
    state.getState().saveCandidate(); expect(state.getState().status).toBe('stored');
    const unknown = { ...draft('request-two'), completion: { kind: 'unconfirmed' } as const };
    state.getState().offerDraft(unknown, true); expect(state.getState().status).toBe('available');
    expect(state.getState().drafts).toEqual([draft()]);
  });
  it('keeps old bytes and exportable memory on quota failure or damaged v2 storage', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope);
    state.getState().offerDraft(draft(), true); const old = [...disk.map];
    disk.setItem = () => { throw new Error('quota'); };
    state.getState().offerDraft(draft('request-two'), true);
    expect(state.getState().status).toBe('memory-only'); expect(state.getState().drafts).toHaveLength(2);
    expect([...disk.map]).toEqual(old);
    const broken = backend(), key = 'arena-narrative-drafts:v2:account%3Aone:unknown'; broken.map.set(key, '{broken');
    const damaged = createNarrativeDraftsStore(broken, scope); damaged.getState().offerDraft(draft(), true);
    expect(damaged.getState().status).toBe('memory-only'); expect(damaged.getState().candidate).toEqual(draft());
    expect(broken.getItem(key)).toBe('{broken');
  });
  it('rereads storage instead of merging stale events or saving observed lists', () => {
    const disk = backend(), a = createNarrativeDraftsStore(disk, scope), b = createNarrativeDraftsStore(disk, scope);
    a.getState().offerDraft(draft(), true); const stale = [...disk.map.values()][0]!;
    b.getState().offerDraft(draft('request-two'), true);
    a.getState().observeStorage(stale); expect(a.getState().drafts).toHaveLength(2);
    b.getState().deleteDrafts(['request-one']); const afterDelete = [...disk.map];
    a.getState().observeStorage(stale);
    expect(a.getState().drafts).toEqual([draft('request-two')]); expect(a.getState().candidate).toBeNull();
    expect([...disk.map]).toEqual(afterDelete);
    a.getState().offerDraft(draft(), true); expect(a.getState().candidate).toBeNull();
  });
  it('rejects conflicting same-ID text without replacing the original', () => {
    const state = createNarrativeDraftsStore(backend(), scope);
    state.getState().offerDraft(draft(), true);
    state.getState().offerDraft({ ...draft(), markdown: '另一个正文' }, true);
    expect(state.getState().drafts).toEqual([draft()]);
    expect(state.getState().candidate?.markdown).toBe('另一个正文');
    expect(state.getState().status).toBe('memory-only');
  });
  it('does not mark an unsaved candidate stored after another request completes', () => {
    const state = createNarrativeDraftsStore(backend(), scope);
    state.getState().offerDraft(draft(), false); state.getState().completeRequest('request-other');
    expect(state.getState().status).toBe('available'); expect(state.getState().drafts).toEqual([]);
  });
  it('retains deletion barriers through many completions and reopening', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope);
    state.getState().offerDraft(draft(), true); state.getState().completeRequest('request-one');
    for (let i = 0; i < 20; i++) state.getState().completeRequest(`request-${i}`);
    const reopened = createNarrativeDraftsStore(disk, scope); reopened.getState().offerDraft(draft(), true);
    expect(reopened.getState().drafts).toEqual([]); expect(reopened.getState().candidate).toBeNull();
    expect(reopened.getState().deletedRequestIds).toHaveLength(21);
  });
  it('rejects late callbacks and confirmations from a different account', () => {
    const state = createNarrativeDraftsStore(backend(), scope);
    state.getState().offerDraft(draft(), true); state.getState().setScope('account:two');
    state.getState().offerDraft(draft('two'), true);
    state.getState().offerDraft(draft('late'), true, scope);
    expect(state.getState().deleteDrafts(['two'], scope).ok).toBe(false);
    state.getState().completeRequest('two', scope);
    expect(state.getState().drafts).toEqual([draft('two')]);
    state.getState().setScope(scope); expect(state.getState().drafts).toEqual([draft()]);
  });
  it('keeps failed deletions visible and removes only confirmed IDs', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope);
    state.getState().offerDraft(draft(), true); const snapshot = state.getState().drafts.map(draft => draft.requestId);
    state.getState().offerDraft(draft('later'), true);
    const write = disk.setItem; disk.setItem = () => { throw new Error('quota'); };
    expect(state.getState().deleteDrafts(snapshot)).toMatchObject({ ok: false, failedIds: snapshot });
    expect(state.getState().drafts).toHaveLength(2);
    disk.setItem = write; expect(state.getState().deleteDrafts(snapshot).ok).toBe(true);
    expect(state.getState().drafts).toEqual([draft('later')]);
  });
  it('shows legacy only on request and preserves v1 bytes when hiding a legacy draft', () => {
    const disk = backend(), raw = JSON.stringify({ version: 1, archive: buildNarrativeDraftArchive([draft()]), completedRequestIds: [] });
    disk.map.set(NARRATIVE_DRAFTS_STORAGE_KEY, raw);
    const state = createNarrativeDraftsStore(disk, scope); state.getState().loadDrafts();
    expect(state.getState().drafts).toEqual([]); expect(state.getState().legacy).toBeNull();
    expect(state.getState().loadLegacyDrafts().drafts).toEqual([draft()]);
    state.getState().deleteLegacyDrafts(['request-one']);
    expect(state.getState().legacy?.drafts).toEqual([]); expect(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBe(raw);
  });
  it('refreshes an already opened legacy list on a storage event without trusting its old payload', () => {
    const disk = backend(), raw = JSON.stringify(buildNarrativeDraftArchive([draft()]));
    disk.map.set(NARRATIVE_DRAFTS_STORAGE_KEY, raw);
    const a = createNarrativeDraftsStore(disk, scope), b = createNarrativeDraftsStore(disk, scope);
    a.getState().loadLegacyDrafts(); b.getState().deleteLegacyDrafts(['request-one']);
    a.getState().observeStorage(raw);
    expect(a.getState().legacy?.drafts).toEqual([]);
    expect(disk.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)).toBe(raw);
  });
  it('exposes pending originals and batch save independently from the current candidate status', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope), write = disk.setItem;
    disk.setItem = () => { throw new Error('quota'); };
    state.getState().offerDraft(draft('a'), true); state.getState().clearCandidate();
    expect(state.getState()).toMatchObject({ status: 'idle', unsavedRequestIds: ['a'], unsavedDrafts: [draft('a')] });
    disk.setItem = write; state.getState().offerDraft(draft('b'), true);
    expect(state.getState()).toMatchObject({ status: 'stored', unsavedRequestIds: ['a'] });
    expect(state.getState().retryUnsavedDrafts()).toMatchObject({ ok: true, savedIds: ['a'] });
    expect(state.getState()).toMatchObject({ status: 'stored', unsavedRequestIds: [], unsavedDrafts: [] });
  });
  it('exposes only a cross-scope protection boolean while hiding the previous account drafts', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope), write = disk.setItem;
    disk.setItem = () => { throw new Error('quota'); };
    state.getState().offerDraft(draft(), true); state.getState().clearCandidate(); state.getState().setScope('account:two');
    expect(state.getState()).toMatchObject({ hasUnsavedAcrossScopes: true, unsavedRequestIds: [], unsavedDrafts: [], drafts: [], candidate: null });
    disk.setItem = write; state.getState().setScope(scope); state.getState().retryUnsavedDrafts();
    expect(state.getState()).toMatchObject({ hasUnsavedAcrossScopes: false });
  });
  it('exposes all durable conflicting originals after reopening without treating them as memory-only', () => {
    const disk = backend(), a = createNarrativeDraftsStore(disk, scope), b = createNarrativeDraftsStore(disk, scope);
    const write = disk.setItem, second = { ...draft(), markdown: '第二份完整原件' };
    disk.setItem = (key, value) => { disk.setItem = write; b.getState().offerDraft(second, true); write(key, value); };
    a.getState().offerDraft(draft(), true);
    const reopened = createNarrativeDraftsStore(disk, scope); reopened.getState().loadDrafts();
    expect(reopened.getState()).toMatchObject({ drafts: [], conflictingDrafts: [second, draft()], unsavedDrafts: [], hasUnsavedAcrossScopes: false });
    expect(reopened.getState().conflictingDrafts.map(version => buildNarrativeDraftArchive([version]).drafts[0]?.markdown)).toEqual([second.markdown, draft().markdown]);
    expect(reopened.getState().deleteDrafts(['request-one']).ok).toBe(true);
    expect(reopened.getState()).toMatchObject({ drafts: [], conflictingDrafts: [], hasUnsavedAcrossScopes: false });
    reopened.getState().offerDraft(draft('next'), true);
    expect(reopened.getState()).toMatchObject({ status: 'stored', drafts: [draft('next')] });
  });
  it('stores opt-in automatic retention outside battle settings and per account', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope);
    expect(state.getState().autoRetain).toBe(false);
    expect(state.getState().setAutoRetain(true).ok).toBe(true);
    state.getState().setScope('anonymous'); expect(state.getState().autoRetain).toBe(false);
    state.getState().setScope(scope); expect(state.getState().autoRetain).toBe(true);
    expect(isNarrativeDraftsStorageKey([...disk.map.keys()][0]!)).toBe(true);
    expect(isNarrativeDraftsStorageKey(NARRATIVE_DRAFTS_STORAGE_KEY)).toBe(false);
  });
});


describe('singleton-owned narrative draft unload protection', () => {
  it('survives UI observer cleanup and account changes, then unbinds after durable retry', () => {
    const disk = backend(), state = createNarrativeDraftsStore(disk, scope), target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener'), remove = vi.spyOn(target, 'removeEventListener');
    const dispose = bindNarrativeDraftsUnloadProtection(state, target);
    const unmountUiObserver = state.subscribe(() => {});
    expect(add).not.toHaveBeenCalled();
    const write = disk.setItem; disk.setItem = () => { throw new Error('quota'); };
    state.getState().offerDraft(draft(), true); state.getState().clearCandidate();
    unmountUiObserver(); state.getState().setScope('account:two');
    const pending = new Event('beforeunload', { cancelable: true });
    expect(target.dispatchEvent(pending)).toBe(false); expect(pending.defaultPrevented).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(state.getState().drafts).toEqual([]);
    disk.setItem = write; state.getState().setScope(scope); state.getState().retryUnsavedDrafts();
    expect(remove).toHaveBeenCalledTimes(1);
    const saved = new Event('beforeunload', { cancelable: true });
    expect(target.dispatchEvent(saved)).toBe(true); expect(saved.defaultPrevented).toBe(false);
    dispose();
  });
  it('binds an already dirty store and removes the guard after confirmed deletion', () => {
    const state = createNarrativeDraftsStore(backend(), scope), target = new EventTarget();
    state.getState().offerDraft(draft(), false);
    const add = vi.spyOn(target, 'addEventListener'), remove = vi.spyOn(target, 'removeEventListener');
    const dispose = bindNarrativeDraftsUnloadProtection(state, target);
    expect(add).toHaveBeenCalledTimes(1);
    expect(target.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    expect(state.getState().deleteDrafts(['request-one']).ok).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(target.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
    dispose();
  });
  it('supports disposing the store-lifetime binding without leaving a live subscription', () => {
    const state = createNarrativeDraftsStore(backend(), scope), target = new EventTarget();
    const dispose = bindNarrativeDraftsUnloadProtection(state, target);
    state.getState().offerDraft(draft(), false); dispose();
    expect(target.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
    state.getState().clearCandidate(); state.getState().offerDraft(draft('another'), false);
    expect(target.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });
});
