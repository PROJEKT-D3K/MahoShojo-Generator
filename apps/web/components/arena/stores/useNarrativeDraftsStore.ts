'use client';

import { create } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createNarrativeDraftController, createNarrativeDraftRepository, NARRATIVE_DRAFT_STORAGE_PREFIX,
  type NarrativeDraftControllerState, type NarrativeDraftScope, type NarrativeDraftStoragePort,
} from '@mahoshojo/domain/narrative-draft-storage';

/** Legacy archive is read only through the explicit device-draft action. */
export const NARRATIVE_DRAFTS_STORAGE_KEY = `${NARRATIVE_DRAFT_STORAGE_PREFIX}-v1`;
export const isNarrativeDraftsStorageKey = (key: string | null): boolean => key === null || key.startsWith(`${NARRATIVE_DRAFT_STORAGE_PREFIX}:v2:`);
type Controller = ReturnType<typeof createNarrativeDraftController>;
type Actions = Omit<Controller, 'getState' | 'subscribe'> & { observeStorage: (value?: string | null) => void };
export type NarrativeDraftsState = NarrativeDraftControllerState & Actions;
const storage = (): NarrativeDraftStoragePort | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
};
const initializer = (getStorage: () => NarrativeDraftStoragePort | null, initialScope: NarrativeDraftScope) =>
  (set: (state: Partial<NarrativeDraftsState>) => void): NarrativeDraftsState => {
    // Resolve lazily: the module can be initialized during SSR before localStorage exists.
    const backend: NarrativeDraftStoragePort = {
      getItem: key => { const current = getStorage(); if (!current) throw new Error('storage-unavailable'); return current.getItem(key); },
      setItem: (key, value) => { const current = getStorage(); if (!current) throw new Error('storage-unavailable'); current.setItem(key, value); },
      removeItem: key => { const current = getStorage(); if (!current) throw new Error('storage-unavailable'); current.removeItem(key); },
      key: index => { const current = getStorage(); if (!current) throw new Error('storage-unavailable'); return current.key(index); },
      get length() { const current = getStorage(); if (!current) throw new Error('storage-unavailable'); return current.length; },
    };
    const controller = createNarrativeDraftController(createNarrativeDraftRepository(backend), initialScope);
    controller.subscribe(set);
    return { ...controller.getState(), setScope: controller.setScope, loadDrafts: controller.loadDrafts,
      offerDraft: controller.offerDraft, saveCandidate: controller.saveCandidate, deleteDrafts: controller.deleteDrafts,
      retryUnsavedDrafts: controller.retryUnsavedDrafts,
      completeRequest: controller.completeRequest, clearCandidate: controller.clearCandidate,
      loadLegacyDrafts: controller.loadLegacyDrafts, deleteLegacyDrafts: controller.deleteLegacyDrafts,
      copyLegacyDrafts: controller.copyLegacyDrafts, setAutoRetain: controller.setAutoRetain,
      observeStorage: () => controller.loadDrafts() };
  };
export const createNarrativeDraftsStore = (backend: NarrativeDraftStoragePort | null, initialScope: NarrativeDraftScope = null) =>
  createStore<NarrativeDraftsState>()(initializer(() => backend, initialScope));
export const useNarrativeDraftsStore = create<NarrativeDraftsState>()(initializer(storage, null));


/** Owned by the store lifetime, so leaving Arena cannot discard the close guard. */
export const bindNarrativeDraftsUnloadProtection = (
  store: Pick<StoreApi<NarrativeDraftsState>, 'getState' | 'subscribe'>,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
): (() => void) => {
  let bound = false;
  const preventUnload = (event: Event) => {
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  };
  const sync = () => {
    const needed = store.getState().hasUnsavedAcrossScopes;
    if (needed === bound) return;
    if (needed) target.addEventListener('beforeunload', preventUnload);
    else target.removeEventListener('beforeunload', preventUnload);
    bound = needed;
  };
  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    if (bound) { target.removeEventListener('beforeunload', preventUnload); bound = false; }
  };
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function') {
  bindNarrativeDraftsUnloadProtection(useNarrativeDraftsStore, window);
}
