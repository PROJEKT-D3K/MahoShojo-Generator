'use client';

import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { SafeJsonValueSchema } from '@mahoshojo/contracts/json-value';
import {
  buildNarrativeDraftArchive, canAutomaticallyRetainNarrativeDraft, MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS,
  mergeNarrativeDrafts, parseNarrativeDraftArchive, type NarrativeDraft,
} from '@mahoshojo/domain/narrative-drafts';

export const NARRATIVE_DRAFTS_STORAGE_KEY = 'arena-narrative-drafts-v1';
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type ArchiveState = { drafts: NarrativeDraft[]; completedRequestIds: string[] };
type DraftState = ArchiveState & {
  candidate: NarrativeDraft | null;
  observedCompletedRequestId: string | null;
  status: 'idle' | 'available' | 'stored' | 'memory-only';
  loadDrafts: () => void;
  observeStorage: (value: string | null) => void;
  offerDraft: (draft: NarrativeDraft, automatic: boolean) => void;
  saveCandidate: () => void;
  completeRequest: (requestId: string) => void;
  clearCandidate: () => void;
};
const storage = (): StoragePort | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};
const parse = (raw: string | null): ArchiveState | null => {
  if (raw === null) return { drafts: [], completedRequestIds: [] };
  if (raw.length > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) return null;
  try {
    const value = JSON.parse(raw);
    if (!SafeJsonValueSchema.safeParse(value).success || !value || value.version !== 1
      || Object.keys(value).some(key => !['version', 'archive', 'completedRequestIds'].includes(key))
      || !Array.isArray(value.completedRequestIds) || value.completedRequestIds.length > 1
      || value.completedRequestIds.some((id: unknown) => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id))) return null;
    const archive = parseNarrativeDraftArchive(value.archive);
    return archive ? { drafts: archive.drafts, completedRequestIds: [...new Set<string>(value.completedRequestIds)] } : null;
  } catch { return null; }
};

// A storage event and pre-write reread merge observed states. localStorage has no atomic CAS.
const initializer = (getStorage: () => StoragePort | null) => (set: (state: Partial<DraftState>) => void, get: () => DraftState): DraftState => {
  const merge = (incoming: ArchiveState): ArchiveState | null => {
    const completedRequestIds = get().completedRequestIds.length ? get().completedRequestIds : incoming.completedRequestIds;
    const result = mergeNarrativeDrafts(get().drafts, incoming.drafts, [...completedRequestIds, ...incoming.completedRequestIds]);
    return result.ok ? { drafts: result.drafts, completedRequestIds } : null;
  };
  const write = () => {
    try {
      const backend = getStorage();
      if (!backend) throw new Error('storage-unavailable');
      const disk = parse(backend.getItem(NARRATIVE_DRAFTS_STORAGE_KEY));
      const combined = disk && merge(disk);
      if (!disk || !combined) throw new Error('archive-conflict');
      const raw = JSON.stringify({ version: 1, archive: buildNarrativeDraftArchive(combined.drafts), completedRequestIds: combined.completedRequestIds });
      if (raw.length > MAX_NARRATIVE_DRAFT_ARCHIVE_CHARS) throw new Error('archive-too-large');
      backend.setItem(NARRATIVE_DRAFTS_STORAGE_KEY, raw);
      const candidate = get().candidate;
      const alive = candidate && ![...combined.completedRequestIds, ...disk.completedRequestIds].includes(candidate.requestId) ? candidate : null;
      const stored = alive && combined.drafts.some(draft => draft.requestId === alive.requestId)
        && mergeNarrativeDrafts(combined.drafts, [alive]).ok;
      set({ ...combined, candidate: alive, status: alive ? stored ? 'stored' : 'available' : 'idle' });
    } catch { set({ status: 'memory-only' }); }
  };
  const observeStorage = (raw: string | null) => {
    const incoming = parse(raw);
    if (incoming) {
      const candidate = get().candidate;
      set({ observedCompletedRequestId: incoming.completedRequestIds[0] ?? null,
        drafts: get().drafts.filter(draft => !incoming.completedRequestIds.includes(draft.requestId)),
        candidate: candidate && incoming.completedRequestIds.includes(candidate.requestId) ? null : candidate });
    }
    const next = incoming && merge(incoming);
    if (!incoming || !next) { set({ status: 'memory-only' }); return; }
    const candidate = get().candidate;
    const alive = candidate && ![...next.completedRequestIds, ...incoming.completedRequestIds].includes(candidate.requestId) ? candidate : null;
    set({ ...next, candidate: alive,
      status: alive ? next.drafts.some(draft => draft.requestId === alive.requestId) ? get().status : 'available' : 'idle' });
  };
  return {
    drafts: [], completedRequestIds: [], observedCompletedRequestId: null, candidate: null, status: 'idle',
    loadDrafts: () => { try { const backend = getStorage(); if (backend) observeStorage(backend.getItem(NARRATIVE_DRAFTS_STORAGE_KEY)); } catch { set({ status: 'memory-only' }); } },
    observeStorage,
    clearCandidate: () => set({ candidate: null, status: 'idle' }),
    offerDraft: (draft, automatic) => {
      const valid = parseNarrativeDraftArchive(buildNarrativeDraftArchive([draft]));
      if (!valid) return;
      draft = valid.drafts[0]!;
      get().loadDrafts();
      if (get().completedRequestIds.includes(draft.requestId) || get().observedCompletedRequestId === draft.requestId) return;
      const result = mergeNarrativeDrafts(get().drafts, [draft], get().completedRequestIds);
      if (!result.ok) { if (result.reason === 'conflict') set({ candidate: draft, status: 'memory-only' }); return; }
      set({ candidate: draft, status: 'available' });
      if (automatic && canAutomaticallyRetainNarrativeDraft(draft)) get().saveCandidate();
    },
    saveCandidate: () => {
      get().loadDrafts();
      const candidate = get().candidate;
      if (!candidate || get().completedRequestIds.includes(candidate.requestId) || get().observedCompletedRequestId === candidate.requestId) return;
      const result = mergeNarrativeDrafts(get().drafts, [candidate], get().completedRequestIds);
      if (!result.ok) { set({ status: 'memory-only' }); return; }
      set({ drafts: result.drafts });
      write();
    },
    completeRequest: (requestId) => {
      // Only the latest completed scope is retained; stale callbacks are fenced by the live generation.
      const completedRequestIds = [requestId];
      set({ completedRequestIds, drafts: get().drafts.filter(draft => draft.requestId !== requestId),
        ...(get().candidate?.requestId === requestId ? { candidate: null } : {}) });
      write();
    },
  };
};
export const createNarrativeDraftsStore = (backend: StoragePort | null) => createStore<DraftState>()(initializer(() => backend));
export const useNarrativeDraftsStore = create<DraftState>()(initializer(storage));
