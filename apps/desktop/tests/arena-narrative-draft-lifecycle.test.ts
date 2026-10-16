import { describe, expect, it } from 'vitest';
import type { CardRepository } from '@mahoshojo/local-library/repository';
import type { NarrativeDraft } from '@mahoshojo/domain/narrative-drafts';
import { createNarrativeDraftRepository } from '@mahoshojo/domain/narrative-draft-storage';
import { ARENA_DRAFT_KEY, DesktopArenaSession, createInitialArenaDraft } from '../src/features/arena/session';
import type { executeArenaDirect } from '../src/features/arena/direct';

const savedDraft = (id = 'legacy-one'): NarrativeDraft => ({ requestId: id, title: '旧故事', createdAt: '2026-10-14T00:00:00Z', source: 'direct-local', markdown: '月光洒在街角，她终于等到了归来的人。', completion: { kind: 'trusted-length' } });
const memory = () => {
  const entries = new Map<string, string>();
  return { entries, get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
};
const input = () => ({ ...createInitialArenaDraft(), battleMode: 'daily' as const, generationMode: 'stream' as const,
  combatants: [{ type: 'general-character', data: { name: '甲' }, filename: 'a.json', isValid: false, isPreset: false }] });
const fixture = (storage = memory(), wait?: Promise<void>) => {
  const execute: typeof executeArenaDirect = async (_options, _input, intent, context) => {
    await wait;
    return { requestId: intent.requestId, scopeKey: context.scopeKey, mode: intent.mode, terminal: null,
      status: 'failed', code: 'AI_STREAM_INCOMPLETE', message: '未完成', rawText: savedDraft().markdown,
      markdown: savedDraft().markdown, reasoning: '', draftCompletion: { kind: 'trusted-length' } };
  };
  const session = new DesktopArenaSession({ storage, repository: {} as CardRepository, execute, requestId: () => 'current-one' });
  session.setScope('execution-A'); session.setNarrativeDraftScope('account:A');
  return { storage, session };
};
const generate = (session: DesktopArenaSession) => session.generate({ profileId: 'fixture', invoke: async () => undefined }, input(), { mode: 'direct-local', generationMode: 'stream', modelId: 'fixture' });

describe('Desktop scoped narrative archive host', () => {
  it('does not automatically assign old embedded drafts and preserves exact old bytes before page saves', () => {
    const storage = memory();
    const raw = JSON.stringify({ version: 1, draft: { ...input(), narrativeDrafts: [savedDraft()] } });
    storage.setItem(ARENA_DRAFT_KEY, raw);
    const { session } = fixture(storage);
    session.restoreDraft();
    expect(session.getSnapshot().draft.narrativeDrafts).toBeUndefined();
    expect(session.narrativeDrafts.getState().legacy).toBeNull();
    expect(session.loadLegacyNarrativeDrafts().drafts).toEqual([savedDraft()]);
    session.updateDraft({ ...session.getSnapshot().draft, selectedLanguage: 'en' });
    expect(storage.getItem(`${ARENA_DRAFT_KEY}.narrative-legacy.v1`)).toBe(raw);
    expect(JSON.parse(storage.getItem(ARENA_DRAFT_KEY)!).draft.narrativeDrafts).toBeUndefined();
    expect(session.narrativeDrafts.copyLegacyDrafts(['legacy-one'], 'account:A').ok).toBe(true);
    expect(session.narrativeDrafts.getState().drafts).toEqual([savedDraft()]);
    session.setNarrativeDraftScope('account:B');
    expect(session.getSnapshot().draft.narrativeDrafts).toBeUndefined();
    expect(session.narrativeDrafts.getState().legacy).toBeNull();
    session.loadLegacyNarrativeDrafts();
    expect(session.narrativeDrafts.deleteLegacyDrafts(['legacy-one']).ok).toBe(true);
    expect(storage.getItem(`${ARENA_DRAFT_KEY}.narrative-legacy.v1`)).toBe(raw);
    session.setNarrativeDraftScope('account:A');
    expect(session.narrativeDrafts.getState().drafts).toEqual([savedDraft()]);
    session.dispose();
    const reopened = fixture(storage); reopened.session.restoreDraft();
    expect(reopened.session.loadLegacyNarrativeDrafts().drafts).toEqual([]);
    expect(reopened.session.narrativeDrafts.getState().drafts).toEqual([savedDraft()]);
    reopened.session.dispose();
  });
  it('protects legacy raw bytes even when the rest of the old page envelope is invalid', () => {
    const storage = memory(), raw = JSON.stringify({ version: 1, draft: { ...input(), narrativeDrafts: [savedDraft()] }, output: { phase: 'future' } });
    storage.setItem(ARENA_DRAFT_KEY, raw);
    const { session } = fixture(storage);
    expect(session.getSnapshot().draftSaved).toBe(false);
    expect(session.loadLegacyNarrativeDrafts().drafts).toEqual([savedDraft()]);
    session.discardDraft();
    expect(storage.getItem(`${ARENA_DRAFT_KEY}.narrative-legacy.v1`)).toBe(raw);
    expect(session.loadLegacyNarrativeDrafts().drafts).toEqual([savedDraft()]);
    expect(session.narrativeDrafts.getState().drafts).toEqual([]);
    session.dispose();
  });
  it.each(['quota', 'unknown-backup'])('does not overwrite old bytes when legacy protection fails: %s', reason => {
    const storage = memory(), raw = JSON.stringify({ version: 1, draft: { ...input(), narrativeDrafts: [savedDraft()] } });
    storage.setItem(ARENA_DRAFT_KEY, raw);
    if (reason === 'unknown-backup') storage.setItem(`${ARENA_DRAFT_KEY}.narrative-legacy.v1`, '{future-data');
    const { session } = fixture(storage); session.restoreDraft();
    if (reason === 'quota') storage.setItem = () => { throw new Error('quota'); };
    session.updateDraft({ ...session.getSnapshot().draft, selectedLanguage: 'en' });
    expect(storage.getItem(ARENA_DRAFT_KEY)).toBe(raw);
    expect(session.getSnapshot().draftSaved).toBe(false);
    session.discardDraft(); expect(storage.getItem(ARENA_DRAFT_KEY)).toBe(raw);
    session.dispose();
  });
  it('freezes the independent preference at dispatch and never writes late content into a changed account', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const { session } = fixture(memory(), wait);
    session.narrativeDrafts.setAutoRetain(true);
    const running = generate(session);
    session.narrativeDrafts.setAutoRetain(false);
    release(); await running;
    expect(session.getSnapshot().narrativeDraftStatus).toBe('stored');
    session.dispose();
    let releaseOther!: () => void;
    const other = fixture(memory(), new Promise<void>(resolve => { releaseOther = resolve; }));
    other.session.narrativeDrafts.setAutoRetain(true);
    const late = generate(other.session);
    other.session.setNarrativeDraftScope('account:B'); other.session.setScope('execution-B');
    other.session.setNarrativeDraftScope('account:A'); other.session.setScope('execution-A');
    releaseOther(); await late;
    expect(other.session.narrativeDrafts.getState().drafts).toEqual([]);
    expect(other.session.narrativeDrafts.getState().candidate).toBeNull();
    other.session.dispose();
  });
  it('keeps over-budget memory content independent from input editing and importing', async () => {
    const { session } = fixture();
    const oversize = { ...savedDraft('oversize'), markdown: '字'.repeat(4 * 1024 * 1024) };
    session.narrativeDrafts.offerDraft(oversize, true);
    expect(session.narrativeDrafts.getState().status).toBe('memory-only');
    expect(() => session.updateDraft({ ...session.getSnapshot().draft, storyLength: 'short' })).not.toThrow();
    await session.importInput(async () => current => ({ ...current, selectedLanguage: 'en' }));
    expect(session.getSnapshot().draft.selectedLanguage).toBe('en');
    expect(session.narrativeDrafts.getState().drafts[0].markdown).toBe(oversize.markdown);
    session.dispose();
  });
  it('keeps the leave guard for earlier memory-only drafts after a later page result was saved', async () => {
    const { session, storage } = fixture();
    const originalSet = storage.setItem;
    storage.setItem = (key, value) => { if (key.includes(':entry:')) throw new Error('quota'); originalSet(key, value); };
    session.narrativeDrafts.offerDraft(savedDraft('earlier'), true);
    expect(session.hasUnsavedDraft()).toBe(true);
    storage.setItem = originalSet;
    session.narrativeDrafts.setAutoRetain(true);
    await generate(session);
    expect(session.getSnapshot().draftSaved).toBe(true);
    expect(session.narrativeDrafts.getState().unsavedRequestIds).toEqual(['earlier']);
    expect(session.hasUnsavedDraft()).toBe(true);
    expect(session.narrativeDrafts.retryUnsavedDrafts().ok).toBe(true);
    expect(session.hasUnsavedDraft()).toBe(false);
    session.dispose();
  });
  it('keeps a non-content closing guard for unsaved originals from another account', () => {
    const { session, storage } = fixture();
    const realSet = storage.setItem;
    storage.setItem = (key, value) => { if (key.includes(':entry:')) throw new Error('quota'); realSet(key, value); };
    session.narrativeDrafts.offerDraft(savedDraft('other-account'), true);
    session.narrativeDrafts.clearCandidate();
    storage.setItem = realSet;
    session.setNarrativeDraftScope('account:B');
    session.updateDraft(input());
    expect(session.getSnapshot().draftSaved).toBe(true);
    expect(session.narrativeDrafts.getState().drafts).toEqual([]);
    expect(session.narrativeDrafts.getState().unsavedDrafts).toEqual([]);
    expect(session.hasUnsavedDraft()).toBe(true);
    session.setNarrativeDraftScope('account:A');
    expect(session.narrativeDrafts.retryUnsavedDrafts().ok).toBe(true);
    expect(session.hasUnsavedDraft()).toBe(false);
    session.dispose();
  });
  it('reopens all persisted conflict originals independently from page input and unsaved flags', () => {
    const firstStore = memory(), secondStore = memory();
    const prefix = 'mahoshojo.desktop.arena.battle.narrative-drafts';
    const first = savedDraft('persisted-conflict'), second = { ...first, markdown: '并发写入的另一份完整正文。' };
    expect(createNarrativeDraftRepository(firstStore, prefix).save('account:A', first).ok).toBe(true);
    expect(createNarrativeDraftRepository(secondStore, prefix).save('account:A', second).ok).toBe(true);
    for (const [key, value] of secondStore.entries) firstStore.setItem(key, value);
    const { session } = fixture(firstStore);
    expect(session.narrativeDrafts.getState().conflictingDrafts).toEqual([first, second]);
    expect(session.getSnapshot().draft.narrativeDrafts).toBeUndefined();
    expect(session.narrativeDrafts.getState().unsavedRequestIds).toEqual([]);
    expect(session.hasUnsavedDraft()).toBe(false);
    expect(session.narrativeDrafts.deleteDrafts(['persisted-conflict']).ok).toBe(true);
    expect(session.narrativeDrafts.getState().conflictingDrafts).toEqual([]);
    session.dispose();
    const reopened = fixture(firstStore);
    expect(reopened.session.narrativeDrafts.getState().conflictingDrafts).toEqual([]);
    reopened.session.dispose();
  });
  it('keeps formal history and the page work copy when deleting the independent archive', async () => {
    const { session, storage } = fixture(); session.updateDraft(input());
    await generate(session); expect(session.getSnapshot().narrativeDraftStatus).toBe('available');
    expect(session.saveNarrativeDraft()).toBe(true);
    const before = storage.getItem(ARENA_DRAFT_KEY);
    expect(session.narrativeDrafts.deleteDrafts(['current-one']).ok).toBe(true);
    expect(storage.getItem(ARENA_DRAFT_KEY)).toBe(before);
    expect(session.getSnapshot().rawText).toBe(savedDraft().markdown);
    expect(session.getSnapshot().draft.narrativeHistoryEntries).toEqual([]);
    session.dispose();
  });
});
