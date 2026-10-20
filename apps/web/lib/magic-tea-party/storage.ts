import { resolveMagicTeaPartyPlayerIdentity } from '@mahoshojo/domain/magic-tea-party/player-identity';
import { sameMagicTeaPartyRoleSource } from '@mahoshojo/domain/magic-tea-party/role-editor';
import type { MagicTeaPartyRole, MagicTeaPartyMessage, MagicTeaPartySession, MagicTeaPartyTachieAsset } from '@/lib/magic-tea-party/types';

const DB_NAME = 'magic-tea-party:v1';
const LEGACY_DB_NAME = 'magic-tavern:v1';
const DB_VERSION = 2;
const IDB_MIGRATION_KEY = 'magic-tea-party:migrated-indexeddb-v1';

let dbPromise: Promise<IDBDatabase> | null = null;

const ensureBrowser = () => {
  if (typeof window === 'undefined') {
    throw new Error('Magic Tea Party 本地存储仅支持在浏览器端使用。');
  }
  if (!('indexedDB' in window)) {
    throw new Error('当前浏览器不支持 IndexedDB，无法使用魔法茶会本地存储。');
  }
};

const openMagicTeaPartyDbInternal = (): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('by_updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('by_sessionId', 'sessionId');
        store.createIndex('by_session_createdAt', ['sessionId', 'createdAt']);
      }

      if (!db.objectStoreNames.contains('tachieAssets')) {
        const store = db.createObjectStore('tachieAssets', { keyPath: 'id' });
        store.createIndex('by_sessionId', 'sessionId');
        store.createIndex('by_cacheKey', 'cacheKey');
        store.createIndex('by_roleId', 'roleId');
        store.createIndex('by_lastUsedAt', 'lastUsedAt');
      }

      if (!db.objectStoreNames.contains('tachieBlobs')) {
        db.createObjectStore('tachieBlobs', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
  });

const readMigrationFlag = (): string | null => {
  try {
    return window.localStorage.getItem(IDB_MIGRATION_KEY);
  } catch {
    return null;
  }
};

const writeMigrationFlag = (value: string): void => {
  try {
    window.localStorage.setItem(IDB_MIGRATION_KEY, value);
  } catch {
    // ignore
  }
};

const openLegacyDb = async (): Promise<IDBDatabase | null> => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;

  try {
    const databases = typeof window.indexedDB.databases === 'function' ? await window.indexedDB.databases() : null;
    if (Array.isArray(databases) && !databases.some((db) => db?.name === LEGACY_DB_NAME)) {
      return null;
    }
  } catch {
    // ignore
  }

  return await new Promise<IDBDatabase | null>((resolve) => {
    let isFresh = false;
    const request = window.indexedDB.open(LEGACY_DB_NAME);

    request.onupgradeneeded = () => {
      isFresh = true;
    };

    request.onsuccess = () => {
      const db = request.result;
      if (isFresh) {
        db.close();
        try {
          window.indexedDB.deleteDatabase(LEGACY_DB_NAME);
        } catch {
          // ignore
        }
        resolve(null);
        return;
      }
      resolve(db);
    };

    request.onerror = () => resolve(null);
  });
};

const readAllFromStore = async <T>(db: IDBDatabase, storeName: string): Promise<T[]> =>
  await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取旧数据失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取旧数据失败'));

    const items: T[] = [];
    const store = tx.objectStore(storeName);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value as T);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取旧数据失败'));
  });

const readStoreKeys = async (db: IDBDatabase, storeName: string): Promise<Set<string>> =>
  await new Promise<Set<string>>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取新数据失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取新数据失败'));

    const keys = new Set<string>();
    const store = tx.objectStore(storeName);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(keys);
        return;
      }
      keys.add(String(cursor.key));
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取新数据失败'));
  });

const writeItemsToStore = async <T>(db: IDBDatabase, storeName: string, items: T[]): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([storeName], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('写入旧数据失败'));
    tx.onerror = () => reject(tx.error ?? new Error('写入旧数据失败'));

    const store = tx.objectStore(storeName);
    items.forEach((item) => store.put(item));
  });

const migrateLegacyDbIfNeeded = async (targetDb: IDBDatabase): Promise<void> => {
  if (typeof window === 'undefined') return;
  if (readMigrationFlag()) return;

  const legacyDb = await openLegacyDb();
  if (!legacyDb) {
    writeMigrationFlag(new Date().toISOString());
    return;
  }

  try {
    const storeNames = ['sessions', 'messages', 'tachieAssets'] as const;
    for (const storeName of storeNames) {
      const legacyItems = await readAllFromStore<Record<string, unknown>>(legacyDb, storeName);
      if (legacyItems.length === 0) continue;

      const existingKeys = await readStoreKeys(targetDb, storeName);
      const merged = legacyItems.filter((item) => {
        const key = item?.id ? String(item.id) : '';
        return key && !existingKeys.has(key);
      });
      if (merged.length === 0) continue;
      await writeItemsToStore(targetDb, storeName, merged);
    }

    legacyDb.close();
    try {
      window.indexedDB.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      // ignore
    }

    writeMigrationFlag(new Date().toISOString());
  } catch {
    try {
      legacyDb.close();
    } catch {
      // ignore
    }
  }
};

export const openMagicTeaPartyDb = async (): Promise<IDBDatabase> => {
  ensureBrowser();

  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const db = await openMagicTeaPartyDbInternal();
    await migrateLegacyDbIfNeeded(db);
    return db;
  })();

  return dbPromise;
};

export const putMagicTeaPartySession = async (session: MagicTeaPartySession): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存会话失败'));
    tx.onerror = () => reject(tx.error ?? new Error('保存会话失败'));
    tx.objectStore('sessions').put(session);
  });
};

/** Replace one frozen role in the latest session, acknowledging only the completed transaction. */
export const compareAndReplaceMagicTeaPartyRole = async (params: {
  sessionId: string;
  createdAt: number;
  source: MagicTeaPartyRole;
  next: MagicTeaPartyRole;
  isCurrent: () => boolean;
}): Promise<MagicTeaPartySession | null> => {
  const { sessionId, createdAt, isCurrent } = params;
  const source = structuredClone(params.source);
  const next = structuredClone(params.next);
  const db = await openMagicTeaPartyDb();
  if (!isCurrent() || source.id !== next.id) return null;
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readwrite');
    let committed: MagicTeaPartySession | null = null;
    tx.oncomplete = () => resolve(committed);
    tx.onabort = () => reject(tx.error ?? new Error('保存角色失败，草稿已保留。'));
    tx.onerror = () => reject(tx.error ?? new Error('保存角色失败，草稿已保留。'));
    const store = tx.objectStore('sessions');
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const current = request.result as MagicTeaPartySession | undefined;
      const matches = current?.roles.filter(role => role.id === source.id) ?? [];
      if (!isCurrent() || !current || current.createdAt !== createdAt || matches.length !== 1
        || !sameMagicTeaPartyRoleSource(matches[0], source)) return;
      committed = { ...current, roles: current.roles.map(role => role.id === source.id ? next : role), updatedAt: Date.now() };
      store.put(committed);
    };
  });
};

const summarySettingKeys = [
  'autoSummaryEnabled', 'providerId', 'modelId', 'language', 'userDisplayName', 'contextWindowTokens',
  'responseReserveTokens', 'maxContextMessages', 'summaryTriggerRatio', 'summaryMaxTokens', 'summaryMinGapMessages',
  'enableSummary',
] as const;

export type MagicTeaPartySessionWriteOptions = {
  preserveSummary?: boolean;
  /** Only the explicit player selector owns this field; old turn/draft writes cannot restore it. */
  updatePlayerRole?: boolean;
  /** Only explicit role-list mutations may replace roles; unchanged entries keep their latest value. */
  sourceRoles?: MagicTeaPartyRole[];
};

const mergeRoleChanges = (current: MagicTeaPartyRole[], source: MagicTeaPartyRole[] | undefined, next: MagicTeaPartyRole[]): MagicTeaPartyRole[] => {
  if (!source) return current;
  const unique = (roles: MagicTeaPartyRole[]) => new Map(roles.map(role => [role.id, role]));
  const currentMap = unique(current); const sourceMap = unique(source); const nextMap = unique(next);
  const conflict = () => new Error('角色已变化，未保存过时修改；请重新加载后再试。');
  if (currentMap.size !== current.length || sourceMap.size !== source.length || nextMap.size !== next.length) throw conflict();
  for (const role of source) {
    const replacement = nextMap.get(role.id);
    if (sameMagicTeaPartyRoleSource(role, replacement)) continue;
    const latest = currentMap.get(role.id);
    if (!latest && !replacement) continue;
    if (!sameMagicTeaPartyRoleSource(role, latest)) throw conflict();
  }
  const merged: MagicTeaPartyRole[] = [];
  for (const role of next) {
    const original = sourceMap.get(role.id);
    if (!original) {
      if (currentMap.has(role.id)) throw conflict();
      merged.push(role);
    } else if (sameMagicTeaPartyRoleSource(original, role)) {
      const latest = currentMap.get(role.id);
      if (latest) merged.push(latest); // An unchanged stale entry cannot resurrect a removed role.
    } else merged.push(role);
  }
  const retainedSourceIds = source.filter(role => nextMap.has(role.id)).map(role => role.id);
  const retainedNextIds = next.filter(role => sourceMap.has(role.id)).map(role => role.id);
  const reordered = retainedSourceIds.some((id, index) => id !== retainedNextIds[index]);
  if (reordered) return [...merged, ...current.filter(role => !sourceMap.has(role.id) && !nextMap.has(role.id))];
  const mergedMap = unique(merged);
  return [...current.flatMap(role => {
    if (!sourceMap.has(role.id)) return [role];
    const replacement = mergedMap.get(role.id);
    return replacement ? [replacement] : [];
  }), ...merged.filter(role => !currentMap.has(role.id))];
};

/** Existing-session writes do not own roles unless they explicitly supply a source→next role-list change. */
export const putMagicTeaPartySessionPreservingRoles = async (
  session: MagicTeaPartySession, options: MagicTeaPartySessionWriteOptions = {},
): Promise<MagicTeaPartySession> => {
  session = structuredClone(session);
  const sourceRoles = options.sourceRoles ? structuredClone(options.sourceRoles) : undefined;
  const preserveSummary = options.preserveSummary;
  const db = await openMagicTeaPartyDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readwrite');
    let next = session;
    let failure: unknown;
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('保存会话失败'));
    tx.onerror = () => reject(failure ?? tx.error ?? new Error('保存会话失败'));
    const store = tx.objectStore('sessions');
    const request = store.get(session.id);
    request.onsuccess = () => {
      try {
        const current = request.result as MagicTeaPartySession | undefined;
        if (!current || current.createdAt !== session.createdAt) throw new Error('会话已删除或替换，未保存过时结果');
        next = { ...session, roles: mergeRoleChanges(current.roles, sourceRoles, session.roles), updatedAt: Math.max(current.updatedAt, session.updatedAt) };
        next.playerRoleId = resolveMagicTeaPartyPlayerIdentity({ roles: next.roles,
          playerRoleId: options.updatePlayerRole ? session.playerRoleId : current.playerRoleId }).playerRoleId;
        if (preserveSummary) {
          const settings = { ...session.settings };
          for (const key of summarySettingKeys) Object.assign(settings, { [key]: current.settings[key] });
          settings.outputPlan = current.settings.outputPlan
            ? { ...(settings.outputPlan ?? current.settings.outputPlan), summary: current.settings.outputPlan.summary }
            : undefined;
          next = { ...next, settings, summary: current.summary, summarySections: current.summarySections,
            summaryMeta: current.summaryMeta, autoSummaryState: current.autoSummaryState };
        }
        store.put(next);
      } catch (error) { failure = error; tx.abort(); }
    };
  });
};

/** Original-turn bookkeeping must not restore summary or roles captured before another edit. */
export const putMagicTeaPartySessionKeepingSummary = (session: MagicTeaPartySession): Promise<MagicTeaPartySession> =>
  putMagicTeaPartySessionPreservingRoles(session, { preserveSummary: true });

/** Explicit opt-in only changes this setting, preserving any other tab's latest summary. */
export const setMagicTeaPartyAutoSummaryEnabled = async (sessionId: string, enabled: boolean): Promise<MagicTeaPartySession | null> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readwrite');
    let next: MagicTeaPartySession | null = null;
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(tx.error ?? new Error('保存自动摘要设置失败'));
    tx.onerror = () => reject(tx.error ?? new Error('保存自动摘要设置失败'));
    const store = tx.objectStore('sessions');
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const current = request.result as MagicTeaPartySession | undefined;
      if (!current) return;
      next = { ...current, settings: { ...current.settings, autoSummaryEnabled: enabled }, updatedAt: Date.now() };
      store.put(next);
    };
  });
};

/** Only summary ownership participates in this conditional write; unrelated session edits survive. */
export const captureMagicTeaPartySummarySnapshot = (session: MagicTeaPartySession): string => {
  const settings = session.settings;
  return JSON.stringify({
    summary: session.summary, summarySections: session.summarySections, summaryMeta: session.summaryMeta,
    autoSummaryState: session.autoSummaryState,
    settings: {
      autoSummaryEnabled: settings.autoSummaryEnabled, providerId: settings.providerId, modelId: settings.modelId,
      language: settings.language, userDisplayName: settings.userDisplayName,
      contextWindowTokens: settings.contextWindowTokens, responseReserveTokens: settings.responseReserveTokens,
      maxContextMessages: settings.maxContextMessages, summaryTriggerRatio: settings.summaryTriggerRatio,
      summaryMaxTokens: settings.summaryMaxTokens, summaryMinGapMessages: settings.summaryMinGapMessages,
      enableSummary: settings.enableSummary, outputSummary: settings.outputPlan?.summary,
    },
  });
};

export type MagicTeaPartySummaryPatch = Partial<Pick<MagicTeaPartySession,
  'summary' | 'summarySections' | 'summaryMeta' | 'autoSummaryState'>>;

export const compareAndPatchMagicTeaPartySummary = async (params: {
  sessionId: string;
  expectedSnapshot: string;
  patch: MagicTeaPartySummaryPatch;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<MagicTeaPartySession | null> => {
  const db = await openMagicTeaPartyDb();
  if (params.signal?.aborted || params.isCurrent?.() === false) return null;
  return await new Promise<MagicTeaPartySession | null>((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readwrite');
    let next: MagicTeaPartySession | null = null;
    const abort = () => { try { tx.abort(); } catch { /* transaction already ended */ } };
    const cleanup = () => params.signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(next); };
    tx.onabort = () => {
      cleanup();
      if (params.signal?.aborted || params.isCurrent?.() === false) resolve(null);
      else reject(tx.error ?? new Error('保存摘要失败'));
    };
    tx.onerror = () => { cleanup(); reject(tx.error ?? new Error('保存摘要失败')); };
    params.signal?.addEventListener('abort', abort, { once: true });
    const store = tx.objectStore('sessions');
    const request = store.get(params.sessionId);
    request.onsuccess = () => {
      const current = request.result as MagicTeaPartySession | undefined;
      if (!current || params.signal?.aborted || params.isCurrent?.() === false
        || captureMagicTeaPartySummarySnapshot(current) !== params.expectedSnapshot) return;
      // Explicit keys prevent callers from accidentally turning this into a whole-session put.
      next = { ...current, updatedAt: Date.now() };
      for (const key of ['summary', 'summarySections', 'summaryMeta', 'autoSummaryState'] as const) {
        if (Object.prototype.hasOwnProperty.call(params.patch, key)) Object.assign(next, { [key]: params.patch[key] });
      }
      store.put(next);
    };
  });
};

export const getMagicTeaPartySession = async (sessionId: string): Promise<MagicTeaPartySession | null> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise<MagicTeaPartySession | null>((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取会话失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取会话失败'));
    const request = tx.objectStore('sessions').get(sessionId);
    request.onsuccess = () => resolve((request.result as MagicTeaPartySession | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('读取会话失败'));
  });
};

export const listMagicTeaPartySessions = async (options?: { limit?: number }): Promise<MagicTeaPartySession[]> => {
  const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50;
  const db = await openMagicTeaPartyDb();
  return await new Promise<MagicTeaPartySession[]>((resolve, reject) => {
    const tx = db.transaction(['sessions'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取会话列表失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取会话列表失败'));

    const sessions: MagicTeaPartySession[] = [];
    const index = tx.objectStore('sessions').index('by_updatedAt');
    const request = index.openCursor(null, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(sessions);
        return;
      }
      sessions.push(cursor.value as MagicTeaPartySession);
      if (sessions.length >= limit) {
        resolve(sessions);
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取会话列表失败'));
  });
};

export const deleteMagicTeaPartySession = async (sessionId: string): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['sessions', 'messages', 'tachieAssets', 'tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('删除会话失败'));
    tx.onerror = () => reject(tx.error ?? new Error('删除会话失败'));

    tx.objectStore('sessions').delete(sessionId);

    const deleteByIndex = (store: IDBObjectStore, indexName: string) => {
      const index = store.index(indexName);
      const request = index.openCursor(IDBKeyRange.only(sessionId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {
          // ignore
        }
      };
    };

    deleteByIndex(tx.objectStore('messages'), 'by_sessionId');

    const assetsStore = tx.objectStore('tachieAssets');
    const blobsStore = tx.objectStore('tachieBlobs');
    const assetsIndex = assetsStore.index('by_sessionId');
    const assetsRequest = assetsIndex.openCursor(IDBKeyRange.only(sessionId));
    assetsRequest.onsuccess = () => {
      const cursor = assetsRequest.result;
      if (!cursor) return;
      const assetId = cursor.value?.id ? String(cursor.value.id) : '';
      if (assetId) blobsStore.delete(assetId);
      cursor.delete();
      cursor.continue();
    };
    assetsRequest.onerror = () => {
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };
  });
};

export const putMagicTeaPartyMessage = async (message: MagicTeaPartyMessage): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['messages'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存消息失败'));
    tx.onerror = () => reject(tx.error ?? new Error('保存消息失败'));
    tx.objectStore('messages').put(message);
  });
};

export const listMagicTeaPartyMessages = async (sessionId: string): Promise<MagicTeaPartyMessage[]> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise<MagicTeaPartyMessage[]>((resolve, reject) => {
    const tx = db.transaction(['messages'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取消息失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取消息失败'));

    const messages: MagicTeaPartyMessage[] = [];
    const index = tx.objectStore('messages').index('by_session_createdAt');
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const request = index.openCursor(range, 'next');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(messages);
        return;
      }
      messages.push(cursor.value as MagicTeaPartyMessage);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取消息失败'));
  });
};

export const deleteMagicTeaPartyMessages = async (messageIds: string[]): Promise<void> => {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return;
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['messages'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('删除消息失败'));
    tx.onerror = () => reject(tx.error ?? new Error('删除消息失败'));

    const store = tx.objectStore('messages');
    for (const messageId of messageIds) {
      if (!messageId) continue;
      store.delete(messageId);
    }
  });
};

export const putMagicTeaPartyTachieAsset = async (asset: MagicTeaPartyTachieAsset): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('保存立绘缓存失败'));
    tx.objectStore('tachieAssets').put(asset);
  });
};

export const listMagicTeaPartyTachieAssets = async (sessionId: string): Promise<MagicTeaPartyTachieAsset[]> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise<MagicTeaPartyTachieAsset[]>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取立绘缓存失败'));

    const items: MagicTeaPartyTachieAsset[] = [];
    const index = tx.objectStore('tachieAssets').index('by_sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId), 'next');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)));
        return;
      }
      items.push(cursor.value as MagicTeaPartyTachieAsset);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取立绘缓存失败'));
  });
};

export const listAllMagicTeaPartyTachieAssets = async (): Promise<MagicTeaPartyTachieAsset[]> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise<MagicTeaPartyTachieAsset[]>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取立绘缓存失败'));

    const items: MagicTeaPartyTachieAsset[] = [];
    const index = tx.objectStore('tachieAssets').index('by_lastUsedAt');
    const request = index.openCursor(null, 'next');

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value as MagicTeaPartyTachieAsset);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('读取立绘缓存失败'));
  });
};

export const deleteMagicTeaPartyTachieAsset = async (assetId: string): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets', 'tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('删除立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('删除立绘缓存失败'));
    tx.objectStore('tachieAssets').delete(assetId);
    tx.objectStore('tachieBlobs').delete(assetId);
  });
};

export const deleteMagicTeaPartyTachieAssetsByIds = async (assetIds: string[]): Promise<void> => {
  if (!Array.isArray(assetIds) || assetIds.length === 0) return;
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets', 'tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('删除立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('删除立绘缓存失败'));

    const store = tx.objectStore('tachieAssets');
    const blobStore = tx.objectStore('tachieBlobs');
    for (const assetId of assetIds) {
      if (!assetId) continue;
      store.delete(assetId);
      blobStore.delete(assetId);
    }
  });
};

export const deleteMagicTeaPartyTachieAssets = async (sessionId: string): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets', 'tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('删除立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('删除立绘缓存失败'));

    const store = tx.objectStore('tachieAssets');
    const blobStore = tx.objectStore('tachieBlobs');
    const index = store.index('by_sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const assetId = cursor.value?.id ? String(cursor.value.id) : '';
      if (assetId) blobStore.delete(assetId);
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };
  });
};

export const putMagicTeaPartyTachieBlob = async (assetId: string, blob: Blob): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('保存立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('保存立绘缓存失败'));
    tx.objectStore('tachieBlobs').put({ id: assetId, blob });
  });
};

export const getMagicTeaPartyTachieBlob = async (assetId: string): Promise<Blob | null> => {
  const db = await openMagicTeaPartyDb();
  return await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(['tachieBlobs'], 'readonly');
    tx.onabort = () => reject(tx.error ?? new Error('读取立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('读取立绘缓存失败'));
    const request = tx.objectStore('tachieBlobs').get(assetId);
    request.onsuccess = () => {
      const payload = request.result as { blob?: Blob } | undefined;
      resolve(payload?.blob ?? null);
    };
    request.onerror = () => reject(request.error ?? new Error('读取立绘缓存失败'));
  });
};

export const clearMagicTeaPartyTachieCache = async (): Promise<void> => {
  const db = await openMagicTeaPartyDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tachieAssets', 'tachieBlobs'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('清理立绘缓存失败'));
    tx.onerror = () => reject(tx.error ?? new Error('清理立绘缓存失败'));
    tx.objectStore('tachieAssets').clear();
    tx.objectStore('tachieBlobs').clear();
  });
};
