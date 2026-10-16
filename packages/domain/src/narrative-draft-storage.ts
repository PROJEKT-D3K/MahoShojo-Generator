import { sha256 } from '@noble/hashes/sha2.js';
import {
  buildNarrativeDraftArchive, canAutomaticallyRetainNarrativeDraft, MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS,
  NarrativeDraftSchema, parseNarrativeDraftArchive, projectNarrativeDraftMarkdown, type NarrativeDraft,
} from './narrative-drafts';

export type NarrativeDraftStoragePort = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};
export type NarrativeDraftScope = string | null;
export const NARRATIVE_DRAFT_STORAGE_PREFIX = 'arena-narrative-drafts';
export const NARRATIVE_DRAFT_DELETE_RESERVE_CHARS = 64 * 1024;
export type NarrativeDraftStorageFailure = 'scope-unavailable' | 'storage-unavailable' | 'invalid' | 'protected' | 'conflict' | 'deleted' | 'budget' | 'write-failed';
export type NarrativeDraftWriteResult = { ok: true } | { ok: false; reason: NarrativeDraftStorageFailure };
export type NarrativeDraftDeleteResult = {
  ok: boolean; deletedIds: string[]; failedIds: string[];
  failures: { id: string; reason: NarrativeDraftStorageFailure }[]; error?: string; warnings?: string[];
};
export type NarrativeDraftRetryResult = {
  ok: boolean; savedIds: string[]; failedIds: string[];
  failures: { id: string; reason: NarrativeDraftStorageFailure }[]; error?: string;
};
export type NarrativeDraftLoadResult = {
  ok: boolean; drafts: NarrativeDraft[]; conflictingDrafts: NarrativeDraft[]; deletedRequestIds: string[]; autoRetain: boolean;
  issues: { key: string; reason: 'protected' | 'conflict' }[];
  reason?: NarrativeDraftStorageFailure;
};
export type NarrativeDraftLegacyResult = {
  status: 'absent' | 'available' | 'protected' | 'unavailable'; drafts: NarrativeDraft[]; raw: string | null;
};

const validId = (id: string): boolean => /^[A-Za-z0-9._:-]{1,128}$/u.test(id);
const validScope = (scope: NarrativeDraftScope): scope is string => typeof scope === 'string' && scope.length > 0 && scope.length <= 512;
const digest = (raw: string): string => Array.from(sha256(new TextEncoder().encode(raw)), byte => byte.toString(16).padStart(2, '0')).join('');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validate = (value: unknown): NarrativeDraft | null => {
  const parsed = NarrativeDraftSchema.safeParse(value);
  return parsed.success && projectNarrativeDraftMarkdown(parsed.data.markdown) === parsed.data.markdown ? parsed.data : null;
};
const serialize = (draft: NarrativeDraft): string => JSON.stringify({ kind: 'arena-narrative-draft', version: 2, draft });
const same = (left: NarrativeDraft, right: NarrativeDraft): boolean => serialize(left) === serialize(right);
const emptyLoad = (reason: NarrativeDraftStorageFailure): NarrativeDraftLoadResult => ({ ok: false, drafts: [], conflictingDrafts: [], deletedRequestIds: [], autoRetain: false, issues: [], reason });

/** Append-only entries and permanent deletion barriers. No read/merge/write archive or multi-key transaction. */
export const createNarrativeDraftRepository = (
  storage: NarrativeDraftStoragePort | null, prefix = NARRATIVE_DRAFT_STORAGE_PREFIX,
) => {
  const root = `${prefix}:v2:`;
  const scopeRoot = (scope: string) => `${root}${encodeURIComponent(scope)}:`;
  const tombstoneKey = (scope: string, id: string) => `${scopeRoot(scope)}deleted:${id}`;
  const entryKey = (scope: string, draft: NarrativeDraft, raw: string) => `${scopeRoot(scope)}entry:${draft.requestId}:${digest(raw)}`;
  const keys = (): string[] => {
    if (!storage || typeof storage.key !== 'function' || !Number.isInteger(storage.length)) throw new Error('storage-unavailable');
    const result = new Set<string>();
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(root)) result.add(key);
    }
    return [...result];
  };
  const usedCharacters = (): number => keys().reduce((total, key) => {
    const raw = storage!.getItem(key);
    return total + (raw === null ? 0 : key.length + raw.length);
  }, 0);
  const verifiedEntries = (scope: string, id: string): { key: string; raw: string }[] => {
    const result: { key: string; raw: string }[] = [];
    for (const key of keys().filter(key => key.startsWith(`${scopeRoot(scope)}entry:${id}:`))) {
      const raw = storage!.getItem(key);
      if (raw === null) continue;
      let draft: NarrativeDraft | null = null;
      try {
        const value: unknown = JSON.parse(raw);
        if (record(value) && value.kind === 'arena-narrative-draft' && value.version === 2 && Object.keys(value).length === 3) draft = validate(value.draft);
      } catch { /* Never remove unknown originals. */ }
      if (draft?.requestId === id && entryKey(scope, draft, raw) === key) result.push({ key, raw });
    }
    return result;
  };
  const cleanDeletedEntries = (scope: string, id: string): boolean => {
    try {
      if (storage!.getItem(tombstoneKey(scope, id)) !== '1') return false;
      for (const { key, raw } of verifiedEntries(scope, id)) {
        if (storage!.getItem(key) === raw) storage!.removeItem(key);
      }
      return true;
    } catch { return false; }
  };
  const load = (scope: NarrativeDraftScope): NarrativeDraftLoadResult => {
    if (!validScope(scope)) return emptyLoad('scope-unavailable');
    try {
      let autoRetain = false;
      const currentRoot = scopeRoot(scope), issues: NarrativeDraftLoadResult['issues'] = [];
      const byId = new Map<string, NarrativeDraft[]>(), entryKeysById = new Map<string, string>(), deleted = new Set<string>();
      for (const key of keys().filter(key => key.startsWith(currentRoot))) {
        const raw = storage!.getItem(key);
        if (raw === null) continue;
        const part = key.slice(currentRoot.length);
        if (part === 'preference') {
          if (raw === '0' || raw === '1') autoRetain = raw === '1';
          else issues.push({ key, reason: 'protected' });
          continue;
        }
        if (part.startsWith('deleted:') && validId(part.slice(8))) {
          deleted.add(part.slice(8));
          if (raw !== '1') issues.push({ key, reason: 'protected' });
          continue;
        }
        let draft: NarrativeDraft | null = null;
        try {
          if (raw.length <= MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) {
            const value: unknown = JSON.parse(raw);
            if (record(value) && value.kind === 'arena-narrative-draft' && value.version === 2
              && Object.keys(value).length === 3) draft = validate(value.draft);
          }
        } catch { /* Unknown bytes remain untouched. */ }
        if (!draft || entryKey(scope, draft, raw) !== key) { issues.push({ key, reason: 'protected' }); continue; }
        const versions = byId.get(draft.requestId) ?? [];
        if (!versions.some(existing => same(existing, draft))) versions.push(draft);
        byId.set(draft.requestId, versions);
        entryKeysById.set(draft.requestId, key);
      }
      // A deletion may have arrived while the entry keys were being enumerated.
      for (const id of byId.keys()) if (storage!.getItem(tombstoneKey(scope, id)) !== null) deleted.add(id);
      const live = [...byId.entries()].filter(([id]) => !deleted.has(id));
      const drafts = live.filter(([, versions]) => versions.length === 1).map(([, versions]) => versions[0]!);
      const conflicts = live.filter(([, versions]) => versions.length > 1);
      for (const [id] of conflicts) issues.push({ key: entryKeysById.get(id)!, reason: 'conflict' });
      const conflictingDrafts = conflicts.flatMap(([, versions]) => versions);
      return { ok: issues.length === 0, drafts, conflictingDrafts, deletedRequestIds: [...deleted], autoRetain, issues,
        ...(issues.length ? { reason: 'protected' as const } : {}) };
    } catch { return emptyLoad('storage-unavailable'); }
  };
  const save = (scope: NarrativeDraftScope, input: NarrativeDraft): NarrativeDraftWriteResult => {
    if (!validScope(scope)) return { ok: false, reason: 'scope-unavailable' };
    const draft = validate(input);
    if (!draft) return { ok: false, reason: 'invalid' };
    try {
      if (!storage) return { ok: false, reason: 'storage-unavailable' };
      if (storage.getItem(tombstoneKey(scope, draft.requestId)) !== null) return { ok: false, reason: 'deleted' };
      const current = load(scope);
      if (!current.ok) return { ok: false, reason: current.reason ?? 'protected' };
      const existing = current.drafts.find(item => item.requestId === draft.requestId);
      if (existing) return same(existing, draft) ? { ok: true } : { ok: false, reason: 'conflict' };
      const raw = serialize(draft), key = entryKey(scope, draft, raw);
      const previous = storage.getItem(key);
      if (previous !== null && previous !== raw) return { ok: false, reason: 'protected' };
      // Admission budget covers every v2 scope, keys, entries and tombstones. localStorage has
      // no CAS: concurrent admissions can exceed it. Afterwards new writes fail; no data is evicted.
      if (usedCharacters() + (previous === null ? key.length + raw.length : 0)
        > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS - NARRATIVE_DRAFT_DELETE_RESERVE_CHARS) return { ok: false, reason: 'budget' };
      if (storage.getItem(tombstoneKey(scope, draft.requestId)) !== null) return { ok: false, reason: 'deleted' };
      storage.setItem(key, raw);
      if (storage.getItem(tombstoneKey(scope, draft.requestId)) !== null) {
        cleanDeletedEntries(scope, draft.requestId);
        return { ok: false, reason: 'deleted' };
      }
      if (storage.getItem(key) !== raw) return { ok: false, reason: 'write-failed' };
      const after = load(scope);
      if (!after.ok) return { ok: false, reason: after.reason ?? 'protected' };
      if (usedCharacters() > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS - NARRATIVE_DRAFT_DELETE_RESERVE_CHARS) return { ok: false, reason: 'budget' };
      return { ok: true };
    } catch { return { ok: false, reason: 'write-failed' }; }
  };
  const remove = (scope: NarrativeDraftScope, ids: readonly string[]): NarrativeDraftDeleteResult => {
    const deletedIds: string[] = [], failures: NarrativeDraftDeleteResult['failures'] = [], warnings: string[] = [];
    for (const id of new Set(ids)) {
      let reason: NarrativeDraftStorageFailure | undefined;
      if (!validScope(scope)) reason = 'scope-unavailable';
      else if (!validId(id)) reason = 'invalid';
      else try {
        if (!storage) reason = 'storage-unavailable';
        else {
          const key = tombstoneKey(scope, id), existing = storage.getItem(key);
          if (existing === '1') {
            deletedIds.push(id);
            if (!cleanDeletedEntries(scope, id)) warnings.push(id);
            continue;
          }
          if (existing !== null) reason = 'protected';
          else if (usedCharacters() + key.length + 1 > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS
            && verifiedEntries(scope, id).reduce((sum, item) => sum + item.key.length + item.raw.length, 0) < key.length + 1) reason = 'budget';
          else {
            // Explicit deletion may temporarily add one barrier above admission budget when
            // removing its verified body reduces net usage. Never remove before barrier readback.
            storage.setItem(key, '1');
            if (storage.getItem(key) !== '1') reason = 'write-failed';
            else { deletedIds.push(id); if (!cleanDeletedEntries(scope, id)) warnings.push(id); }
          }
        }
      } catch { reason = 'write-failed'; }
      if (reason) failures.push({ id, reason });
    }
    return { ok: failures.length === 0, deletedIds, failedIds: failures.map(item => item.id), failures,
      ...(warnings.length ? { warnings } : {}),
      ...(failures.length ? { error: '部分草稿的删除屏障未能保存，原内容仍保留，请重试或先导出。' } : {}) };
  };
  const setAutoRetain = (scope: NarrativeDraftScope, value: boolean): NarrativeDraftWriteResult => {
    if (!validScope(scope)) return { ok: false, reason: 'scope-unavailable' };
    try {
      if (!storage) return { ok: false, reason: 'storage-unavailable' };
      const key = `${scopeRoot(scope)}preference`, previous = storage.getItem(key), raw = value ? '1' : '0';
      if (previous !== null && previous !== '0' && previous !== '1') return { ok: false, reason: 'protected' };
      // Updating a known preference does not grow storage; users can always disable retention.
      if (previous === null && usedCharacters() + key.length + 1 > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS - NARRATIVE_DRAFT_DELETE_RESERVE_CHARS) return { ok: false, reason: 'budget' };
      storage.setItem(key, raw);
      return storage.getItem(key) === raw ? { ok: true } : { ok: false, reason: 'write-failed' };
    } catch { return { ok: false, reason: 'write-failed' }; }
  };
  const readLegacy = (key = `${prefix}-v1`): NarrativeDraftLegacyResult => {
    let raw: string | null = null;
    try {
      if (!storage) return { status: 'unavailable', drafts: [], raw };
      raw = storage.getItem(key);
      if (raw === null) return { status: 'absent', drafts: [], raw };
      if (raw.length > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) return { status: 'protected', drafts: [], raw };
      const value: unknown = JSON.parse(raw);
      const project = (drafts: NarrativeDraft[]): NarrativeDraftLegacyResult => {
        const barriers = load('device-legacy');
        if (barriers.reason === 'storage-unavailable') return { status: 'unavailable', drafts: [], raw };
        return { status: 'available', drafts: drafts.filter(draft => !barriers.deletedRequestIds.includes(draft.requestId)), raw };
      };
      const direct = parseNarrativeDraftArchive(value);
      if (direct) return project(direct.drafts);
      if (record(value) && value.version === 1 && record(value.draft) && Array.isArray(value.draft.narrativeDrafts)) {
        const archive = parseNarrativeDraftArchive(buildNarrativeDraftArchive(value.draft.narrativeDrafts));
        if (archive) {
          const completed = record(value.output) ? value.output.completedRequestId : undefined;
          if (completed !== undefined && (typeof completed !== 'string' || !validId(completed))) return { status: 'protected', drafts: [], raw };
          return project(archive.drafts.filter(draft => draft.requestId !== completed));
        }
      }
      if (record(value) && value.version === 1 && Object.keys(value).every(name => ['version', 'archive', 'completedRequestIds'].includes(name))
        && Array.isArray(value.completedRequestIds) && value.completedRequestIds.every(id => typeof id === 'string' && validId(id))) {
        const archive = parseNarrativeDraftArchive(value.archive);
        const completed = value.completedRequestIds;
        if (archive) return project(archive.drafts.filter(draft => !completed.includes(draft.requestId)));
      }
      return { status: 'protected', drafts: [], raw };
    } catch { return { status: raw === null ? 'unavailable' : 'protected', drafts: [], raw }; }
  };
  return { load, save, delete: remove, readLegacy, setAutoRetain, isStorageKey: (key: string | null) => key === null || key.startsWith(root) };
};
export type NarrativeDraftRepository = ReturnType<typeof createNarrativeDraftRepository>;

export type NarrativeDraftControllerState = {
  scope: NarrativeDraftScope; drafts: NarrativeDraft[]; conflictingDrafts: NarrativeDraft[]; candidate: NarrativeDraft | null;
  status: 'idle' | 'available' | 'stored' | 'memory-only'; deletedRequestIds: string[];
  unsavedRequestIds: string[]; unsavedDrafts: NarrativeDraft[]; hasUnsavedAcrossScopes: boolean;
  autoRetain: boolean; error: string | null; legacy: NarrativeDraftLegacyResult | null;
};
const failureMessage = (reason: NarrativeDraftStorageFailure): string => reason === 'budget'
  ? '未完成草稿存储已达到预算，原件没有被淘汰；请导出当前内容。'
  : reason === 'conflict' || reason === 'protected'
    ? '已有草稿包含冲突或不支持的数据，原件未被覆盖；当前内容仍可导出。'
    : '未完成草稿未能保存到设备，当前内容仍在内存中，请导出或重试。';

/** Host-independent candidate lifecycle; storage events only trigger a fresh read. */
export const createNarrativeDraftController = (repository: NarrativeDraftRepository, initialScope: NarrativeDraftScope = null) => {
  type Memory = { drafts: NarrativeDraft[]; knownDrafts: NarrativeDraft[]; candidate: NarrativeDraft | null; retired: Set<string>; deleted: Set<string> };
  const memories = new Map<string, Memory>(), listeners = new Set<(state: NarrativeDraftControllerState) => void>();
  let legacyKey: string | undefined;
  let state: NarrativeDraftControllerState = { hasUnsavedAcrossScopes: false, autoRetain: false, scope: initialScope, drafts: [], conflictingDrafts: [], unsavedRequestIds: [], unsavedDrafts: [], candidate: null, status: 'idle', deletedRequestIds: [], error: null, legacy: null };
  const memory = (): Memory | null => {
    if (!validScope(state.scope)) return null;
    let found = memories.get(state.scope);
    if (!found) { found = { drafts: [], knownDrafts: [], candidate: null, retired: new Set(), deleted: new Set() }; memories.set(state.scope, found); }
    return found;
  };
  const publish = (patch: Partial<NarrativeDraftControllerState>) => {
    // The close guard sees only a boolean, never another account's IDs or original text.
    const hasUnsavedAcrossScopes = [...memories.values()].some(current => current.drafts.length > 0
      || current.candidate !== null && !current.knownDrafts.some(draft => same(draft, current.candidate!)));
    state = { ...state, ...patch, hasUnsavedAcrossScopes };
    for (const listener of listeners) listener(state);
  };
  const loadDrafts = () => {
    const current = memory();
    if (!current) return;
    const disk = repository.load(state.scope);
    for (const id of disk.deletedRequestIds) current.deleted.add(id);
    const deleted = current.deleted;
    const persistentDrafts = [...disk.drafts, ...disk.conflictingDrafts];
    const confirmedBodies = new Set(persistentDrafts.map(serialize));
    // Preserve every unconfirmed original, including same-ID conflicts and last known
    // durable bodies while storage cannot be read. Candidate dismissal cannot discard these.
    current.drafts = [...new Map([...current.drafts, ...current.knownDrafts]
      .map(draft => [serialize(draft), draft])).entries()]
      .filter(([body, draft]) => !deleted.has(draft.requestId) && !confirmedBodies.has(body)).map(([, draft]) => draft);
    current.knownDrafts = persistentDrafts;
    if (current.candidate && deleted.has(current.candidate.requestId)) current.candidate = null;
    const drafts = new Map(disk.drafts.filter(draft => !deleted.has(draft.requestId)).map(draft => [draft.requestId, draft]));
    const conflictingIds = new Set(disk.conflictingDrafts.map(draft => draft.requestId));
    const pendingCounts = new Map<string, number>();
    for (const draft of current.drafts) pendingCounts.set(draft.requestId, (pendingCounts.get(draft.requestId) ?? 0) + 1);
    for (const draft of current.drafts) {
      if (!drafts.has(draft.requestId) && !conflictingIds.has(draft.requestId) && pendingCounts.get(draft.requestId) === 1) drafts.set(draft.requestId, draft);
    }
    const candidate = current.candidate;
    const stored = candidate && persistentDrafts.some(draft => same(draft, candidate));
    publish({ drafts: [...drafts.values()], conflictingDrafts: disk.conflictingDrafts, candidate, deletedRequestIds: [...deleted], autoRetain: disk.autoRetain,
      unsavedDrafts: [...current.drafts], unsavedRequestIds: [...new Set(current.drafts.map(draft => draft.requestId))],
      status: candidate ? stored ? 'stored' : state.status === 'memory-only' || current.drafts.some(draft => same(draft, candidate)) ? 'memory-only' : 'available' : 'idle',
      error: disk.ok ? null : failureMessage(disk.reason ?? 'protected'),
      ...(state.legacy ? { legacy: repository.readLegacy(legacyKey) } : {}) });
  };
  const saveCandidate = (): NarrativeDraftWriteResult => {
    const current = memory(), candidate = current?.candidate;
    if (!candidate || !current) return { ok: false, reason: 'scope-unavailable' };
    if (current.retired.has(candidate.requestId)) return { ok: false, reason: 'deleted' };
    const result = repository.save(state.scope, candidate);
    if (result.ok) current.drafts = current.drafts.filter(draft => !same(draft, candidate));
    else if (result.reason === 'deleted') current.deleted.add(candidate.requestId);
    else if (!current.drafts.some(draft => same(draft, candidate))) current.drafts.push(candidate);
    loadDrafts();
    if (!result.ok && result.reason !== 'deleted') publish({
      status: state.unsavedDrafts.some(draft => same(draft, candidate)) ? 'memory-only' : state.status,
      error: failureMessage(result.reason),
    });
    return result;
  };
  const retryUnsavedDrafts = (expectedScope = state.scope): NarrativeDraftRetryResult => {
    if (expectedScope !== state.scope || !validScope(state.scope)) return {
      ok: false, savedIds: [], failedIds: [...state.unsavedRequestIds],
      failures: state.unsavedRequestIds.map(id => ({ id, reason: 'scope-unavailable' })),
      error: '账号已切换，请回到原账号重试保存。',
    };
    loadDrafts();
    const current = memory()!, saved = new Set<string>();
    const failures: NarrativeDraftRetryResult['failures'] = [];
    for (const draft of [...current.drafts]) {
      const result: NarrativeDraftWriteResult = current.retired.has(draft.requestId)
        ? { ok: false, reason: 'deleted' } : repository.save(state.scope, draft);
      if (result.ok) { saved.add(draft.requestId); current.drafts = current.drafts.filter(item => !same(item, draft)); }
      else {
        if (result.reason === 'deleted' && !current.retired.has(draft.requestId)) current.deleted.add(draft.requestId);
        if (!failures.some(item => item.id === draft.requestId && item.reason === result.reason)) failures.push({ id: draft.requestId, reason: result.reason });
      }
    }
    loadDrafts();
    const failedIds = [...new Set(failures.map(item => item.id))];
    const error = failures.length ? '部分内存草稿仍未能保存，完整原件继续保留，请导出或重试。' : undefined;
    if (error) publish({ error });
    return { ok: !failures.length, savedIds: [...saved].filter(id => !failedIds.includes(id)), failedIds, failures, ...(error ? { error } : {}) };
  };
  const deleteDrafts = (ids: readonly string[], expectedScope = state.scope): NarrativeDraftDeleteResult => {
    if (expectedScope !== state.scope) return { ok: false, deletedIds: [], failedIds: [...ids], failures: ids.map(id => ({ id, reason: 'scope-unavailable' })), error: '账号已切换，请重新选择要删除的草稿。' };
    const result = repository.delete(state.scope, ids), current = memory();
    if (current) {
      const deleted = new Set(result.deletedIds);
      for (const id of deleted) current.deleted.add(id);
      current.drafts = current.drafts.filter(draft => !deleted.has(draft.requestId));
      if (current.candidate && deleted.has(current.candidate.requestId)) current.candidate = null;
    }
    loadDrafts();
    if (!result.ok) publish({ error: result.error ?? null });
    else if (result.warnings?.length) publish({ error: '草稿已删除，但设备上的正文空间回收失败；可重试清理。' });
    return result;
  };
  const loadLegacyDrafts = (key = legacyKey) => { legacyKey = key; const legacy = repository.readLegacy(key); publish({ legacy }); return legacy; };
  return {
    getState: () => state,
    subscribe: (listener: (state: NarrativeDraftControllerState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setScope: (scope: NarrativeDraftScope) => {
      if (scope === state.scope) { loadDrafts(); return; }
      publish({ scope, drafts: [], conflictingDrafts: [], unsavedRequestIds: [], unsavedDrafts: [], candidate: null, status: 'idle', deletedRequestIds: [], autoRetain: false, error: null, legacy: null });
      loadDrafts();
    },
    loadDrafts,
    offerDraft: (input: NarrativeDraft, automatic: boolean, expectedScope = state.scope) => {
      if (expectedScope !== state.scope) return;
      const draft = validate(input), current = memory();
      if (!draft || !current || current.retired.has(draft.requestId)) return;
      loadDrafts();
      if (state.deletedRequestIds.includes(draft.requestId)) return;
      current.candidate = draft;
      publish({ candidate: draft, status: 'available' });
      if (automatic && canAutomaticallyRetainNarrativeDraft(draft)) saveCandidate();
    },
    saveCandidate,
    retryUnsavedDrafts,
    deleteDrafts,
    completeRequest: (id: string, expectedScope = state.scope) => {
      if (expectedScope === state.scope) memory()?.retired.add(id);
      return deleteDrafts([id], expectedScope);
    },
    clearCandidate: () => { const current = memory(); if (current) current.candidate = null; publish({ candidate: null, status: 'idle' }); },
    loadLegacyDrafts,
    deleteLegacyDrafts: (ids: readonly string[]) => {
      const result = repository.delete('device-legacy', ids);
      loadLegacyDrafts();
      if (!result.ok) publish({ error: result.error ?? null });
      return result;
    },
    copyLegacyDrafts: (ids: readonly string[], expectedScope = state.scope): Omit<NarrativeDraftDeleteResult, 'deletedIds'> & { copiedIds: string[] } => {
      const selected = new Set(ids), copiedIds: string[] = [], failures: NarrativeDraftDeleteResult['failures'] = [];
      if (expectedScope !== state.scope || !validScope(state.scope)) return { ok: false, copiedIds: [], failedIds: [...ids], failures: ids.map(id => ({ id, reason: 'scope-unavailable' })) };
      const legacy = loadLegacyDrafts();
      for (const id of selected) {
        const draft = legacy.drafts.find(draft => draft.requestId === id);
        const result = draft ? repository.save(state.scope, draft) : { ok: false as const, reason: 'invalid' as const };
        if (result.ok) copiedIds.push(id); else failures.push({ id, reason: result.reason });
      }
      loadDrafts();
      return { ok: !failures.length, copiedIds, failedIds: failures.map(item => item.id), failures, ...(failures.length ? { error: '部分旧草稿未能复制，旧设备原件仍保留。' } : {}) };
    },
    setAutoRetain: (value: boolean): NarrativeDraftWriteResult => {
      const result = repository.setAutoRetain(state.scope, value);
      if (result.ok) publish({ autoRetain: value, error: null });
      else publish({ error: failureMessage(result.reason) });
      return result;
    },
  };
};
