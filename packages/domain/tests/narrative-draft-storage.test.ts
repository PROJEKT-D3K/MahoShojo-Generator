import { describe, expect, it } from 'vitest';
import { buildNarrativeDraftArchive, MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS, parseNarrativeDraftArchive, type NarrativeDraft } from '../src/narrative-drafts';
import {
  createNarrativeDraftController, createNarrativeDraftRepository, NARRATIVE_DRAFT_DELETE_RESERVE_CHARS,
  type NarrativeDraftStoragePort,
} from '../src/narrative-draft-storage';

const draft = (requestId = 'one', markdown = '# 未完成\n正文'): NarrativeDraft => ({ requestId, markdown, title: '未完成', createdAt: '2026-10-14T00:00:00Z', source: 'hosted', completion: { kind: 'server-failed', code: 'AI_STREAM_INCOMPLETE' } });
class Disk implements NarrativeDraftStoragePort {
  map = new Map<string, string>();
  beforeSet: ((key: string, value: string) => void) | null = null;
  afterSet: ((key: string, value: string) => void) | null = null;
  quota = Infinity;
  failRemove = false;
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) {
    this.beforeSet?.(key, value);
    const next = new Map(this.map); next.set(key, value);
    if ([...next].reduce((sum, [key, value]) => sum + key.length + value.length, 0) > this.quota) throw new Error('QuotaExceededError');
    this.map.set(key, value); this.afterSet?.(key, value);
  }
  removeItem(key: string) { if (this.failRemove) throw new Error('remove-failed'); this.map.delete(key); }
}
const scope = 'account:one';
const entryKeys = (disk: Disk) => [...disk.map.keys()].filter(key => key.includes(':entry:'));

describe('scoped append-only narrative draft repository', () => {
  it('keeps anonymous and account archives separate across reopening', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk);
    expect(a.save(null, draft())).toEqual({ ok: false, reason: 'scope-unavailable' });
    a.save('anonymous', draft('anonymous')); a.save(scope, draft()); a.save('account:two', draft('two'));
    const reopened = createNarrativeDraftRepository(disk);
    expect(reopened.load(scope).drafts).toEqual([draft()]);
    expect(reopened.load('anonymous').drafts).toEqual([draft('anonymous')]);
    expect(reopened.load('account:two').drafts).toEqual([draft('two')]);
  });
  it('interleaves two saves without a whole-array lost update', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    disk.beforeSet = key => { if (!key.includes(':entry:')) return; disk.beforeSet = null; expect(b.save(scope, draft('two')).ok).toBe(true); };
    expect(a.save(scope, draft()).ok).toBe(true);
    expect(a.load(scope).drafts.map(draft => draft.requestId).sort()).toEqual(['one', 'two']);
  });
  it('does not overwrite concurrent conflicting bodies with the same request ID', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    disk.beforeSet = () => { disk.beforeSet = null; b.save(scope, draft('one', '另一原文')); };
    expect(a.save(scope, draft()).ok).toBe(false);
    expect(entryKeys(disk)).toHaveLength(2);
    expect([...disk.map.values()].join('\n')).toContain('另一原文');
    expect(a.load(scope)).toMatchObject({ ok: false, drafts: [] });
    expect(a.delete(scope, ['one']).ok).toBe(true);
    expect(entryKeys(disk)).toEqual([]);
  });
  it('reopens every verified conflicting version for separate export and confirmed deletion', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    const first = draft('one', '第一份完整原件'), second = draft('one', '第二份完整原件');
    disk.beforeSet = () => { disk.beforeSet = null; b.save(scope, second); };
    expect(a.save(scope, first).ok).toBe(false);
    const reopened = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    reopened.loadDrafts();
    expect(reopened.getState()).toMatchObject({ drafts: [], conflictingDrafts: [second, first], unsavedDrafts: [], unsavedRequestIds: [], hasUnsavedAcrossScopes: false });
    const exports = reopened.getState().conflictingDrafts.map(version => JSON.stringify(buildNarrativeDraftArchive([version])));
    expect(exports.map(raw => parseNarrativeDraftArchive(JSON.parse(raw))?.drafts[0]?.markdown)).toEqual([second.markdown, first.markdown]);
    reopened.setScope('account:two');
    expect(reopened.getState()).toMatchObject({ drafts: [], conflictingDrafts: [], unsavedDrafts: [], hasUnsavedAcrossScopes: false });
    reopened.offerDraft(draft('one', '另一账号原件'), true);
    expect(reopened.getState()).toMatchObject({ conflictingDrafts: [], status: 'stored' });
    reopened.setScope(scope);
    expect(reopened.deleteDrafts(['one']).ok).toBe(true);
    const afterDelete = createNarrativeDraftRepository(disk);
    expect(afterDelete.load(scope)).toMatchObject({ ok: true, drafts: [], conflictingDrafts: [] });
    expect(afterDelete.load('account:two').drafts).toEqual([draft('one', '另一账号原件')]);
    expect(afterDelete.save(scope, draft('new')).ok).toBe(true);
  });
  it('does not turn corrupt or unknown-version storage into exportable conflict originals', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    const first = draft('one', 'first'), second = draft('one', 'second');
    disk.beforeSet = () => { disk.beforeSet = null; b.save(scope, second); }; a.save(scope, first);
    const unknownKey = 'arena-narrative-drafts:v2:account%3Aone:entry:one:future';
    const raw = JSON.stringify({ kind: 'arena-narrative-draft', version: 99, draft: draft('one', 'unsupported') });
    disk.map.set(unknownKey, raw);
    expect(a.load(scope)).toMatchObject({ ok: false, drafts: [], conflictingDrafts: [second, first] });
    a.delete(scope, ['one']);
    expect(a.load(scope)).toMatchObject({ ok: false, drafts: [], conflictingDrafts: [] });
    expect(disk.map.get(unknownKey)).toBe(raw);
  });
  it('rejects a same-ID conflict without changing the original bytes', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    repository.save(scope, draft()); const original = [...disk.map];
    expect(repository.save(scope, draft('one', '冲突文本'))).toEqual({ ok: false, reason: 'conflict' });
    expect([...disk.map]).toEqual(original);
  });
  it('deletion wins when a stale tab writes after the barrier was stored', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    disk.beforeSet = key => { if (!key.includes(':entry:')) return; disk.beforeSet = null; b.delete(scope, ['one']); };
    expect(a.save(scope, draft())).toEqual({ ok: false, reason: 'deleted' });
    expect(entryKeys(disk)).toEqual([]);
    expect(createNarrativeDraftRepository(disk).load(scope).drafts).toEqual([]);
    expect(b.save(scope, draft())).toEqual({ ok: false, reason: 'deleted' });
  });
  it('deletion wins after an entry write and before the writer checks its result', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    disk.afterSet = key => { if (!key.includes(':entry:')) return; disk.afterSet = null; b.delete(scope, ['one']); };
    expect(a.save(scope, draft()).ok).toBe(false);
    expect(a.load(scope)).toMatchObject({ drafts: [], deletedRequestIds: ['one'] });
    expect(entryKeys(disk)).toEqual([]);
  });
  it('keeps every completed barrier when later requests complete', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    for (let i = 0; i < 30; i++) repository.delete(scope, [`done-${i}`]);
    expect(repository.save(scope, draft('done-0'))).toEqual({ ok: false, reason: 'deleted' });
    expect(repository.load(scope).deletedRequestIds).toHaveLength(30);
  });
  it('deletes only the confirmed snapshot while a new draft arrives', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    repository.save(scope, draft()); repository.save(scope, draft('two'));
    const snapshot = repository.load(scope).drafts.map(draft => draft.requestId);
    disk.beforeSet = key => { if (!key.includes(':deleted:')) return; disk.beforeSet = null; repository.save(scope, draft('later')); };
    expect(repository.delete(scope, snapshot).ok).toBe(true);
    expect(repository.load(scope).drafts).toEqual([draft('later')]);
  });
  it('reports partial failure and retries only the missing durable barriers', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    repository.save(scope, draft()); repository.save(scope, draft('two'));
    disk.beforeSet = key => { if (key.endsWith(':deleted:two')) throw new Error('quota'); };
    const partial = repository.delete(scope, ['one', 'two']);
    expect(partial).toMatchObject({ ok: false, deletedIds: ['one'], failedIds: ['two'] });
    expect(repository.load(scope).drafts).toEqual([draft('two')]);
    disk.beforeSet = null;
    expect(repository.delete(scope, partial.failedIds).ok).toBe(true);
    expect(repository.load(scope).drafts).toEqual([]);
  });
  it('does not remove a body when quota blocks the deletion barrier', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    repository.save(scope, draft()); disk.quota = 0; const original = [...disk.map];
    expect(repository.delete(scope, ['one'])).toMatchObject({ ok: false, failedIds: ['one'] });
    expect([...disk.map]).toEqual(original);
    expect(repository.load(scope).drafts).toEqual([draft()]);
  });
  it('reports cleanup failure without undoing a durable logical deletion and retries cleanup', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    repository.save(scope, draft()); disk.failRemove = true;
    expect(repository.delete(scope, ['one'])).toMatchObject({ ok: true, warnings: ['one'] });
    expect(repository.load(scope).drafts).toEqual([]); expect(entryKeys(disk)).toHaveLength(1);
    disk.failRemove = false; repository.delete(scope, ['one']); expect(entryKeys(disk)).toEqual([]);
  });
  it('frees deleted bodies and can save again without dropping permanent barriers', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk), big = draft('large', '文'.repeat(2_500_000));
    expect(repository.save(scope, big).ok).toBe(true);
    expect(repository.save(scope, draft('next', big.markdown))).toEqual({ ok: false, reason: 'budget' });
    expect(repository.delete(scope, ['large']).ok).toBe(true);
    expect(repository.save(scope, draft('next', big.markdown)).ok).toBe(true);
    expect(repository.load(scope).deletedRequestIds).toContain('large');
  });
  it('counts every scope and tombstone in admission without evicting originals', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    const key = 'arena-narrative-drafts:v2:account%3Aother:unknown';
    disk.map.set(key, 'x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS - NARRATIVE_DRAFT_DELETE_RESERVE_CHARS - key.length));
    expect(repository.save(scope, draft())).toEqual({ ok: false, reason: 'budget' });
    expect(repository.delete(scope, ['one']).ok).toBe(true);
    expect(disk.map.get(key)?.length).toBe(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS - NARRATIVE_DRAFT_DELETE_RESERVE_CHARS - key.length);
  });
  it('preserves concurrent budget overflow and refuses all later admissions', () => {
    const disk = new Disk(), a = createNarrativeDraftRepository(disk), b = createNarrativeDraftRepository(disk);
    disk.beforeSet = () => { disk.beforeSet = null; b.save('account:two', draft('two', 'x'.repeat(2_200_000))); };
    expect(a.save(scope, draft('one', 'x'.repeat(2_200_000)))).toEqual({ ok: false, reason: 'budget' });
    expect(entryKeys(disk)).toHaveLength(2);
    expect(a.save(scope, draft('three'))).toEqual({ ok: false, reason: 'budget' });
    expect(a.delete(scope, ['absent']).ok).toBe(false);
    expect(entryKeys(disk)).toHaveLength(2);
    expect(a.delete(scope, ['one']).ok).toBe(true);
    expect(entryKeys(disk)).toHaveLength(1);
    expect(a.save(scope, draft('three')).ok).toBe(true);
  });
  it('preserves corrupt and unknown-version values and never overwrites them', () => {
    for (const raw of ['{broken', JSON.stringify({ version: 99, content: 'future' })]) {
      const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
      const key = 'arena-narrative-drafts:v2:account%3Aone:entry:unknown'; disk.map.set(key, raw);
      expect(repository.load(scope).ok).toBe(false);
      expect(repository.save(scope, draft()).ok).toBe(false);
      repository.delete(scope, ['unknown']); expect(disk.map.get(key)).toBe(raw);
    }
  });
  it('keeps v1 originals separate until explicitly read, copied or hidden', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    const key = 'arena-narrative-drafts-v1', raw = JSON.stringify({ version: 1, archive: buildNarrativeDraftArchive([draft()]), completedRequestIds: [] });
    disk.map.set(key, raw);
    expect(repository.load(scope).drafts).toEqual([]);
    expect(repository.load('account:two').drafts).toEqual([]);
    expect(repository.readLegacy().drafts).toEqual([draft()]);
    repository.delete('device-legacy', ['one']);
    expect(repository.readLegacy().drafts).toEqual([]);
    expect(disk.map.get(key)).toBe(raw);
  });
  it('reads Desktop legacy envelopes only through the explicit legacy API', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    const raw = JSON.stringify({ version: 1, draft: { narrativeDrafts: [draft()], other: 'preserved' }, output: { rawText: 'old' } });
    disk.map.set('desktop-draft', raw);
    expect(repository.readLegacy('desktop-draft')).toMatchObject({ status: 'available', drafts: [draft()], raw });
    repository.delete('device-legacy', ['one']); expect(disk.map.get('desktop-draft')).toBe(raw);
  });
  it('allows disabling an existing preference at full budget while preserving unknown preferences', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    expect(repository.setAutoRetain(scope, true).ok).toBe(true);
    const preferenceKey = [...disk.map.keys()][0]!;
    const fillerKey = 'arena-narrative-drafts:v2:account%3Aother:unknown';
    disk.map.set(fillerKey, 'x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS));
    expect(repository.setAutoRetain(scope, false)).toEqual({ ok: true });
    expect(repository.load(scope).autoRetain).toBe(false);
    expect(repository.save(scope, draft())).toEqual({ ok: false, reason: 'budget' });
    expect(repository.setAutoRetain('anonymous', false)).toEqual({ ok: false, reason: 'budget' });
    disk.map.set(preferenceKey, 'future');
    expect(repository.setAutoRetain(scope, false)).toEqual({ ok: false, reason: 'protected' });
    expect(disk.map.get(preferenceKey)).toBe('future');
    expect(disk.map.get(fillerKey)?.length).toBe(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS);
  });
  it('stores an opt-in local preference per account without altering narrative drafts', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk);
    expect(repository.load(scope).autoRetain).toBe(false);
    expect(repository.setAutoRetain(scope, true).ok).toBe(true);
    expect(repository.load(scope)).toMatchObject({ autoRetain: true, drafts: [] });
    expect(repository.load('anonymous').autoRetain).toBe(false);
    const key = [...disk.map.keys()][0]!; disk.map.set(key, 'future');
    expect(repository.setAutoRetain(scope, false)).toEqual({ ok: false, reason: 'protected' });
    expect(disk.map.get(key)).toBe('future');
  });
});

describe('shared narrative draft candidate lifecycle', () => {
  it('retains exportable memory when save fails and keeps it isolated across account switches', () => {
    const disk = new Disk(); disk.quota = 0;
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true);
    expect(controller.getState()).toMatchObject({ candidate: draft(), drafts: [draft()], status: 'memory-only' });
    controller.setScope('account:two'); expect(controller.getState().candidate).toBeNull();
    controller.offerDraft(draft('late'), true, scope); expect(controller.getState().drafts).toEqual([]);
    controller.setScope(scope); expect(controller.getState().candidate).toEqual(draft());
  });
  it('does not forget observed barriers when storage becomes unavailable or scope changes', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true); controller.deleteDrafts(['one']);
    disk.getItem = () => { throw new Error('unavailable'); };
    controller.loadDrafts(); controller.offerDraft(draft(), false);
    expect(controller.getState()).toMatchObject({ drafts: [], candidate: null, deletedRequestIds: ['one'] });
    controller.setScope('account:two'); controller.setScope(scope); controller.offerDraft(draft(), false);
    expect(controller.getState()).toMatchObject({ drafts: [], candidate: null, deletedRequestIds: ['one'] });
  });
  it('keeps failed originals marked after dismissal and a later success, then retries without generation', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    const fillerKey = 'arena-narrative-drafts:v2:other:unknown';
    disk.map.set(fillerKey, 'x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS));
    controller.offerDraft(draft('a'), true);
    expect(controller.getState()).toMatchObject({ status: 'memory-only', unsavedRequestIds: ['a'], unsavedDrafts: [draft('a')] });
    controller.clearCandidate();
    expect(controller.getState()).toMatchObject({ status: 'idle', candidate: null, unsavedRequestIds: ['a'], drafts: [draft('a')] });
    disk.map.delete(fillerKey);
    controller.offerDraft(draft('b'), true);
    expect(controller.getState()).toMatchObject({ status: 'stored', candidate: draft('b'), unsavedRequestIds: ['a'] });
    expect(controller.getState().drafts).toEqual([draft('b'), draft('a')]);
    expect(controller.retryUnsavedDrafts()).toEqual({ ok: true, savedIds: ['a'], failedIds: [], failures: [] });
    expect(controller.getState()).toMatchObject({ status: 'stored', unsavedRequestIds: [], unsavedDrafts: [] });
    expect(createNarrativeDraftRepository(disk).load(scope).drafts.map(draft => draft.requestId).sort()).toEqual(['a', 'b']);
  });
  it('isolates pending originals and prevents a retry from crossing account scope', () => {
    const disk = new Disk(); disk.quota = 0;
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true); controller.clearCandidate();
    controller.setScope('account:two');
    expect(controller.getState()).toMatchObject({ unsavedRequestIds: [], unsavedDrafts: [], drafts: [] });
    disk.quota = Infinity;
    expect(controller.retryUnsavedDrafts(scope).ok).toBe(false);
    expect(disk.map.size).toBe(0);
    controller.setScope(scope);
    expect(controller.getState().unsavedRequestIds).toEqual(['one']);
    expect(controller.retryUnsavedDrafts().ok).toBe(true);
    expect(controller.getState().unsavedRequestIds).toEqual([]);
  });
  it('retains same-ID conflict originals separately from the durable body after dismissal and retry', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true);
    const conflict = draft('one', '不同的完整原文');
    controller.offerDraft(conflict, true); controller.clearCandidate();
    expect(controller.getState()).toMatchObject({ drafts: [draft()], unsavedRequestIds: ['one'], unsavedDrafts: [conflict] });
    expect(controller.retryUnsavedDrafts()).toMatchObject({ ok: false, savedIds: [], failedIds: ['one'], failures: [{ id: 'one', reason: 'conflict' }] });
    expect(controller.getState().unsavedDrafts).toEqual([conflict]);
    expect(createNarrativeDraftRepository(disk).load(scope).drafts).toEqual([draft()]);
  });
  it('keeps multiple same-ID memory originals and does not mark the ID saved if one still conflicts', () => {
    const disk = new Disk(); disk.quota = 0;
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    const first = draft('one', '第一份原文'), second = draft('one', '第二份原文');
    controller.offerDraft(first, true); controller.offerDraft(second, true); controller.clearCandidate();
    expect(controller.getState().unsavedDrafts).toEqual([first, second]);
    disk.quota = Infinity;
    expect(controller.retryUnsavedDrafts()).toMatchObject({ ok: false, savedIds: [], failedIds: ['one'] });
    expect(controller.getState()).toMatchObject({ drafts: [first], unsavedRequestIds: ['one'], unsavedDrafts: [second] });
  });
  it('marks previously stored originals unconfirmed on read failure and resolves them by readback', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true); controller.clearCandidate();
    const read = disk.getItem.bind(disk); disk.getItem = () => { throw new Error('unavailable'); };
    controller.loadDrafts();
    expect(controller.getState()).toMatchObject({ status: 'idle', drafts: [draft()], unsavedRequestIds: ['one'], unsavedDrafts: [draft()] });
    controller.setScope('account:two'); expect(controller.getState().unsavedRequestIds).toEqual([]);
    controller.setScope(scope); expect(controller.getState().unsavedRequestIds).toEqual(['one']);
    disk.getItem = read;
    const original = [...disk.map];
    expect(controller.retryUnsavedDrafts()).toEqual({ ok: true, savedIds: [], failedIds: [], failures: [] });
    expect(controller.getState().unsavedRequestIds).toEqual([]);
    expect([...disk.map]).toEqual(original);
  });
  it('keeps a private aggregate guard across account changes until pending originals are saved', () => {
    const disk = new Disk(); disk.quota = 0;
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft('a'), true); controller.clearCandidate();
    controller.setScope('account:two');
    expect(controller.getState()).toMatchObject({ drafts: [], candidate: null, unsavedDrafts: [], unsavedRequestIds: [], hasUnsavedAcrossScopes: true });
    disk.quota = Infinity; controller.offerDraft(draft('b'), true);
    expect(controller.getState()).toMatchObject({ drafts: [draft('b')], unsavedDrafts: [], unsavedRequestIds: [], status: 'stored', hasUnsavedAcrossScopes: true });
    controller.setScope(scope); expect(controller.retryUnsavedDrafts().ok).toBe(true);
    expect(controller.getState()).toMatchObject({ hasUnsavedAcrossScopes: false });
    controller.setScope('account:two'); expect(controller.getState()).toMatchObject({ hasUnsavedAcrossScopes: false });
  });
  it('does not flag a durable candidate from a different account as unsaved', () => {
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(new Disk()), scope);
    controller.offerDraft(draft(), true); controller.setScope('account:two');
    expect(controller.getState()).toMatchObject({ drafts: [], candidate: null, hasUnsavedAcrossScopes: false });
  });
  it('also protects available candidates across scopes and clears the aggregate after explicit dismissal or deletion', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), false); controller.setScope('account:two');
    expect(controller.getState()).toMatchObject({ unsavedRequestIds: [], hasUnsavedAcrossScopes: true });
    controller.setScope(scope); controller.clearCandidate();
    expect(controller.getState()).toMatchObject({ hasUnsavedAcrossScopes: false });
    disk.quota = 0; controller.offerDraft(draft(), true); controller.clearCandidate();
    expect(controller.getState()).toMatchObject({ hasUnsavedAcrossScopes: true });
    disk.quota = Infinity; expect(controller.deleteDrafts(['one']).ok).toBe(true);
    expect(controller.getState()).toMatchObject({ hasUnsavedAcrossScopes: false });
  });
  it('does not classify durable conflict versions as unsaved while retaining a different memory original', () => {
    const disk = new Disk(), repository = createNarrativeDraftRepository(disk), controller = createNarrativeDraftController(repository, scope);
    const first = draft('one', 'first'), second = draft('one', 'second'), memoryOnly = draft('one', 'third');
    disk.beforeSet = () => { disk.beforeSet = null; repository.save(scope, second); };
    controller.offerDraft(first, true);
    expect(controller.getState()).toMatchObject({ status: 'stored', drafts: [], conflictingDrafts: [second, first], unsavedDrafts: [], hasUnsavedAcrossScopes: false });
    controller.offerDraft(memoryOnly, true);
    expect(controller.getState()).toMatchObject({ status: 'memory-only', drafts: [], conflictingDrafts: [second, first], unsavedDrafts: [memoryOnly], unsavedRequestIds: ['one'], hasUnsavedAcrossScopes: true });
    controller.clearCandidate(); controller.loadDrafts();
    expect(controller.getState().unsavedDrafts).toEqual([memoryOnly]);
  });
  it('keeps an oversized candidate in memory without degrading its full exportable body', () => {
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(new Disk()), scope);
    const oversized = draft('big', 'x'.repeat(MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS));
    controller.offerDraft(oversized, true);
    expect(controller.getState().status).toBe('memory-only');
    expect(controller.getState().candidate?.markdown).toBe(oversized.markdown);
  });
  it('leaves both UI and candidate intact when user deletion cannot persist', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    controller.offerDraft(draft(), true); disk.quota = 0;
    expect(controller.deleteDrafts(['one']).ok).toBe(false);
    expect(controller.getState()).toMatchObject({ drafts: [draft()], candidate: draft() });
    disk.quota = Infinity; expect(controller.deleteDrafts(['one']).ok).toBe(true);
    expect(controller.getState()).toMatchObject({ drafts: [], candidate: null });
  });
  it('rejects an old-account delete confirmation and clears visible legacy state on switching', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    disk.map.set('arena-narrative-drafts-v1', JSON.stringify(buildNarrativeDraftArchive([draft('legacy')])));
    controller.loadLegacyDrafts(); controller.setScope('account:two'); controller.offerDraft(draft(), true);
    expect(controller.getState().legacy).toBeNull();
    expect(controller.deleteDrafts(['one'], scope).ok).toBe(false);
    expect(controller.getState().drafts).toEqual([draft()]);
  });
  it('copies legacy entries only after an explicit action and leaves originals intact', () => {
    const disk = new Disk(), controller = createNarrativeDraftController(createNarrativeDraftRepository(disk), scope);
    const raw = JSON.stringify(buildNarrativeDraftArchive([draft()])); disk.map.set('arena-narrative-drafts-v1', raw);
    controller.loadLegacyDrafts(); expect(controller.getState().drafts).toEqual([]);
    expect(controller.copyLegacyDrafts(['one'])).toMatchObject({ ok: true, copiedIds: ['one'] });
    expect(controller.getState().drafts).toEqual([draft()]);
    controller.deleteLegacyDrafts(['one']); expect(controller.getState().legacy?.drafts).toEqual([]);
    expect(disk.map.get('arena-narrative-drafts-v1')).toBe(raw);
    expect(controller.getState().drafts).toEqual([draft()]);
  });
});
