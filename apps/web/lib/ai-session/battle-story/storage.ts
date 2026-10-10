import { digestBattleStoryCommitValue } from '@mahoshojo/domain/arena-story-commit';
import { randomUUID } from '@/lib/crypto';
import { openAiSessionDb, requestToPromise, transactionToPromise } from '@/lib/ai-session/storage';
import { AI_SESSION_STORE_NAMES } from '@/lib/ai-session/types';
import type {
  BattleStoryCheckpointListOptions,
  BattleStoryCheckpointRecord,
  BattleStoryChapterListOptions,
  BattleStoryChapterRecord,
  BattleStoryDeterministicDigest,
  BattleStorySessionAction,
  BattleStorySessionListOptions,
  BattleStorySessionRecord,
} from '@/lib/ai-session/battle-story/types';

export { commitCompletedBattleStoryChapter, getBattleStoryOperationReceipt, BattleStoryCommitConflictError, BattleStoryCommitNotSavedError } from './commit-storage';
export type { WebBattleStoryCompletedCommit } from './commit-storage';

const DEFAULT_LIST_LIMIT = 50;

const normalizeLimit = (value: number | undefined, fallback = DEFAULT_LIST_LIMIT): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
};

const buildSessionRange = (sessionId: string): IDBKeyRange => {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
};

const buildCheckpointRange = (sessionId: string): IDBKeyRange => {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
};

const readByCursor = async <T>(
  requestFactory: () => IDBRequest<IDBCursorWithValue | null>,
  options?: {
    limit?: number;
    filter?: (value: T) => boolean;
  }
): Promise<T[]> => {
  const limit = normalizeLimit(options?.limit);

  return await new Promise<T[]>((resolve, reject) => {
    const items: T[] = [];
    const request = requestFactory();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }

      const value = cursor.value as T;
      const passed = typeof options?.filter === 'function' ? options.filter(value) : true;
      if (passed) {
        items.push(value);
      }

      if (items.length >= limit) {
        resolve(items);
        return;
      }

      cursor.continue();
    };

    request.onerror = () => reject(request.error ?? new Error('IndexedDB 游标读取失败'));
  });
};

export const createBattleStorySessionRecord = (input: {
  title: string;
  branchLabel?: string;
  source: BattleStorySessionRecord['source'];
  seed: BattleStorySessionRecord['seed'];
  workingCombatants: unknown[];
  lastChapterInputCombatants?: unknown[];
  sessionSummary?: string;
  summaryMeta?: BattleStorySessionRecord['summaryMeta'];
  chapterPlan?: BattleStorySessionRecord['chapterPlan'];
  branchOf?: BattleStorySessionRecord['branchOf'];
}): BattleStorySessionRecord => {
  const now = Date.now();
  const title = (input.title ?? '').trim() || '未命名连续战报';

  return {
    id: randomUUID(),
    title,
    ...(typeof input.branchLabel === 'string' && input.branchLabel.trim()
      ? { branchLabel: input.branchLabel.trim() }
      : {}),
    createdAt: now,
    updatedAt: now,
    source: input.source,
    seed: input.seed,
    workingCombatants: Array.isArray(input.workingCombatants) ? input.workingCombatants : [],
    ...(Array.isArray(input.lastChapterInputCombatants)
      ? { lastChapterInputCombatants: input.lastChapterInputCombatants }
      : {}),
    ...(input.sessionSummary ? { sessionSummary: input.sessionSummary } : {}),
    ...(input.summaryMeta ? { summaryMeta: input.summaryMeta } : {}),
    ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    ...(input.branchOf ? { branchOf: input.branchOf } : {}),
    lastChapterId: null,
    chapterCount: 0,
  };
};

export const createBattleStoryCheckpointRecord = (input: {
  sessionId: string;
  boundaryIndex: number;
  combatants: unknown[];
  chapterId?: string | null;
}): BattleStoryCheckpointRecord => ({
  id: randomUUID(),
  sessionId: input.sessionId,
  boundaryIndex: Math.max(0, Math.floor(input.boundaryIndex)),
  ...(input.chapterId ? { chapterId: input.chapterId } : {}),
  combatants: Array.isArray(input.combatants) ? input.combatants : [],
  createdAt: Date.now(),
});

export const createBattleStoryChapterRecord = (input: {
  sessionId: string;
  index: number;
  action: BattleStorySessionAction;
  title: string;
  markdown: string;
  reportJson: Record<string, unknown>;
  cardSnapshot?: BattleStoryChapterRecord['cardSnapshot'];
  deterministicDigest: BattleStoryDeterministicDigest;
  sourceChapterId?: string | null;
  generationId?: string | null;
}): BattleStoryChapterRecord => {
  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    index: Math.max(1, Math.floor(input.index)),
    action: input.action,
    status: 'active',
    ...(input.sourceChapterId ? { sourceChapterId: input.sourceChapterId } : {}),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    title: (input.title ?? '').trim() || input.deterministicDigest.chapterTitle || `第 ${input.index} 章`,
    markdown: input.markdown,
    reportJson: input.reportJson ?? {},
    ...(input.cardSnapshot ? { cardSnapshot: input.cardSnapshot } : {}),
    deterministicDigest: input.deterministicDigest,
    createdAt: Date.now(),
  };
};

export const putBattleStorySession = async (session: BattleStorySessionRecord): Promise<void> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions], 'readwrite');
  transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions).put(session);
  await transactionToPromise(transaction);
};

export const getBattleStorySession = async (sessionId: string): Promise<BattleStorySessionRecord | null> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions], 'readonly');
  const request = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions).get(sessionId);
  const result = await requestToPromise(request);
  await transactionToPromise(transaction);
  return (result as BattleStorySessionRecord | undefined) ?? null;
};

export const updateBattleStorySession = async (
  sessionId: string,
  updater: (session: BattleStorySessionRecord) => BattleStorySessionRecord,
  expectedSession?: BattleStorySessionRecord
): Promise<BattleStorySessionRecord> => {
  const db = await openAiSessionDb();

  return await new Promise<BattleStorySessionRecord>((resolve, reject) => {
    const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions], 'readwrite');
    const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions);
    const request = store.get(sessionId);

    let next: BattleStorySessionRecord | undefined;
    let failure: unknown;
    transaction.oncomplete = () => next ? resolve(next) : reject(new Error('更新会话没有结果'));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('更新 battle story session 失败'));
    transaction.onerror = () => reject(transaction.error ?? new Error('更新 battle story session 失败'));

    request.onsuccess = () => {
      const current = request.result as BattleStorySessionRecord | undefined;
      if (!current) {
        reject(new Error(`未找到 battle story session: ${sessionId}`));
        return;
      }

      try {
        if (expectedSession && digestBattleStoryCommitValue(current) !== digestBattleStoryCommitValue(expectedSession)) {
          throw new Error('会话已变化，忽略过时的摘要更新');
        }
        next = updater(current);
        store.put(next);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };

    request.onerror = () => reject(request.error ?? new Error('读取 battle story session 失败'));
  });
};

export const listBattleStorySessions = async (options?: BattleStorySessionListOptions): Promise<BattleStorySessionRecord[]> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions], 'readonly');
  const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions);
  const direction = options?.direction ?? 'prev';

  const requestFactory = () => {
    if (options?.branchSessionId) {
      const index = store.index('by_branch_session');
      return index.openCursor(IDBKeyRange.only(options.branchSessionId), direction);
    }
    return store.index('by_updatedAt').openCursor(null, direction);
  };

  const result = await readByCursor<BattleStorySessionRecord>(requestFactory, {
    limit: options?.limit,
    filter: (value) => {
      if (options?.includeArchived) return true;
      return typeof value.archivedAt !== 'number';
    },
  });
  await transactionToPromise(transaction);
  return result;
};

export const deleteBattleStorySession = async (
  sessionId: string
): Promise<{ deletedSession: boolean; deletedChapterCount: number }> => {
  const db = await openAiSessionDb();

  return await new Promise<{ deletedSession: boolean; deletedChapterCount: number }>((resolve, reject) => {
    const transaction = db.transaction(
      [
        AI_SESSION_STORE_NAMES.battleStorySessions,
        AI_SESSION_STORE_NAMES.battleStoryChapters,
        AI_SESSION_STORE_NAMES.battleStoryCheckpoints,
      ],
      'readwrite'
    );
    const sessionStore = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions);
    const chapterStore = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters);
    const checkpointStore = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints);
    const chapterIndex = chapterStore.index('by_session_index');
    const checkpointIndex = checkpointStore.index('by_session_boundary');
    const chapterCursorRequest = chapterIndex.openCursor(buildSessionRange(sessionId), 'next');

    let deletedChapterCount = 0;
    let deletedSession = false;
    let deletedCheckpoints = false;

    transaction.oncomplete = () => resolve({ deletedSession, deletedChapterCount });
    transaction.onabort = () => reject(transaction.error ?? new Error('删除 battle story session 失败'));
    transaction.onerror = () => reject(transaction.error ?? new Error('删除 battle story session 失败'));

    chapterCursorRequest.onsuccess = () => {
      const cursor = chapterCursorRequest.result;
      if (!cursor) {
        if (!deletedCheckpoints) {
          deletedCheckpoints = true;
          const checkpointCursorRequest = checkpointIndex.openCursor(buildCheckpointRange(sessionId), 'next');
          checkpointCursorRequest.onsuccess = () => {
            const checkpointCursor = checkpointCursorRequest.result;
            if (!checkpointCursor) {
              const deleteSessionRequest = sessionStore.delete(sessionId);
              deleteSessionRequest.onsuccess = () => {
                deletedSession = true;
              };
              deleteSessionRequest.onerror = () => {
                reject(deleteSessionRequest.error ?? new Error('删除 battle story session 失败'));
              };
              return;
            }
            checkpointStore.delete(checkpointCursor.primaryKey);
            checkpointCursor.continue();
          };
          checkpointCursorRequest.onerror = () => {
            reject(checkpointCursorRequest.error ?? new Error('删除 battle story checkpoint 失败'));
          };
          return;
        };
        return;
      }

      chapterStore.delete(cursor.primaryKey);
      deletedChapterCount += 1;
      cursor.continue();
    };

    chapterCursorRequest.onerror = () => {
      reject(chapterCursorRequest.error ?? new Error('删除 battle story chapter 失败'));
    };
  });
};

// Keep the parent check and child writes under the same lock as whole-session deletion.
// This does not make the surrounding legacy branch/rewrite phases atomic.
const putBattleStoryChildren = async (
  storeName: typeof AI_SESSION_STORE_NAMES.battleStoryChapters | typeof AI_SESSION_STORE_NAMES.battleStoryCheckpoints,
  records: (BattleStoryChapterRecord | BattleStoryCheckpointRecord)[],
): Promise<void> => {
  const db = await openAiSessionDb();
  const pendingRecords = records.map((record) => ({ record, sessionId: record.sessionId }));
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStorySessions, storeName], 'readwrite');
    const sessions = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStorySessions);
    const children = transaction.objectStore(storeName);
    const sessionIds = [...new Set(pendingRecords.map((record) => record.sessionId))];
    let remaining = sessionIds.length;
    let failure: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('写入 battle story 子记录失败'));
    transaction.onerror = () => { failure ??= transaction.error; };
    for (const sessionId of sessionIds) {
      const request = sessions.getKey(sessionId);
      request.onsuccess = () => {
        try {
          if (request.result === undefined) throw new Error(`未找到 battle story session: ${sessionId}`);
          remaining -= 1;
          if (remaining === 0) {
            if (pendingRecords.some(({ record, sessionId }) => record.sessionId !== sessionId)) {
              throw new Error('battle story 子记录所属会话已变化，未写入');
            }
            pendingRecords.forEach(({ record }) => children.put(record));
          }
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
    }
  });
};

export const putBattleStoryChapter = async (chapter: BattleStoryChapterRecord): Promise<void> => {
  await putBattleStoryChildren(AI_SESSION_STORE_NAMES.battleStoryChapters, [chapter]);
};

export const putBattleStoryCheckpoint = async (checkpoint: BattleStoryCheckpointRecord): Promise<void> => {
  await putBattleStoryChildren(AI_SESSION_STORE_NAMES.battleStoryCheckpoints, [checkpoint]);
};

export const putBattleStoryCheckpoints = async (checkpoints: BattleStoryCheckpointRecord[]): Promise<void> => {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return;
  await putBattleStoryChildren(AI_SESSION_STORE_NAMES.battleStoryCheckpoints, checkpoints);
};

export const getBattleStoryChapter = async (chapterId: string): Promise<BattleStoryChapterRecord | null> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryChapters], 'readonly');
  const request = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters).get(chapterId);
  const result = await requestToPromise(request);
  await transactionToPromise(transaction);
  return (result as BattleStoryChapterRecord | undefined) ?? null;
};

export const getBattleStoryCheckpointByBoundary = async (
  sessionId: string,
  boundaryIndex: number
): Promise<BattleStoryCheckpointRecord | null> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryCheckpoints], 'readonly');
  const index = transaction
    .objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints)
    .index('by_session_boundary');
  const request = index.get([sessionId, Math.max(0, Math.floor(boundaryIndex))]);
  const result = await requestToPromise(request);
  await transactionToPromise(transaction);
  return (result as BattleStoryCheckpointRecord | undefined) ?? null;
};

export const listBattleStoryChaptersBySession = async (
  sessionId: string,
  options?: BattleStoryChapterListOptions
): Promise<BattleStoryChapterRecord[]> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryChapters], 'readonly');
  const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters);
  const direction = options?.direction ?? 'next';
  const query = buildSessionRange(sessionId);

  const result = await readByCursor<BattleStoryChapterRecord>(
    () => store.index('by_session_index').openCursor(query, direction),
    {
      limit: options?.limit,
      filter: (value) => {
        if (options?.includeSuperseded) return true;
        return value.status !== 'superseded';
      },
    }
  );

  await transactionToPromise(transaction);
  return result;
};

export const listBattleStoryCheckpointsBySession = async (
  sessionId: string,
  options?: BattleStoryCheckpointListOptions
): Promise<BattleStoryCheckpointRecord[]> => {
  const db = await openAiSessionDb();
  const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryCheckpoints], 'readonly');
  const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints);
  const direction = options?.direction ?? 'next';
  const query = buildCheckpointRange(sessionId);

  const result = await readByCursor<BattleStoryCheckpointRecord>(
    () => store.index('by_session_boundary').openCursor(query, direction),
    {
      limit: options?.limit,
    }
  );

  await transactionToPromise(transaction);
  return result;
};

export const getBattleStoryLatestActiveChapter = async (
  sessionId: string
): Promise<BattleStoryChapterRecord | null> => {
  const items = await listBattleStoryChaptersBySession(sessionId, {
    limit: 1,
    direction: 'prev',
    includeSuperseded: false,
  });
  return items[0] ?? null;
};

export const markBattleStoryChapterSuperseded = async (input: {
  chapterId: string;
  supersededByChapterId: string;
}): Promise<BattleStoryChapterRecord> => {
  const db = await openAiSessionDb();

  return await new Promise<BattleStoryChapterRecord>((resolve, reject) => {
    const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryChapters], 'readwrite');
    const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters);
    const request = store.get(input.chapterId);

    transaction.onabort = () => reject(transaction.error ?? new Error('标记 superseded 失败'));
    transaction.onerror = () => reject(transaction.error ?? new Error('标记 superseded 失败'));

    request.onsuccess = () => {
      const current = request.result as BattleStoryChapterRecord | undefined;
      if (!current) {
        reject(new Error(`未找到 battle story chapter: ${input.chapterId}`));
        return;
      }

      const next: BattleStoryChapterRecord = {
        ...current,
        status: 'superseded',
        supersededByChapterId: input.supersededByChapterId,
      };

      const putRequest = store.put(next);
      putRequest.onsuccess = () => resolve(next);
      putRequest.onerror = () => reject(putRequest.error ?? new Error('写入 superseded chapter 失败'));
    };

    request.onerror = () => reject(request.error ?? new Error('读取 battle story chapter 失败'));
  });
};

export const deleteBattleStoryChaptersFromIndex = async (input: {
  sessionId: string;
  startIndex: number;
}): Promise<number> => {
  const db = await openAiSessionDb();

  return await new Promise<number>((resolve, reject) => {
    const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryChapters], 'readwrite');
    const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryChapters);
    const index = store.index('by_session_index');
    const request = index.openCursor(
      IDBKeyRange.bound(
        [input.sessionId, Math.max(1, Math.floor(input.startIndex))],
        [input.sessionId, Number.MAX_SAFE_INTEGER]
      ),
      'next'
    );
    let deletedCount = 0;

    transaction.oncomplete = () => resolve(deletedCount);
    transaction.onabort = () => reject(transaction.error ?? new Error('删除 battle story chapters 失败'));
    transaction.onerror = () => reject(transaction.error ?? new Error('删除 battle story chapters 失败'));

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      deletedCount += 1;
      cursor.continue();
    };

    request.onerror = () => reject(request.error ?? new Error('读取 battle story chapter 游标失败'));
  });
};

export const deleteBattleStoryCheckpointsFromBoundary = async (input: {
  sessionId: string;
  startBoundaryIndex: number;
}): Promise<number> => {
  const db = await openAiSessionDb();

  return await new Promise<number>((resolve, reject) => {
    const transaction = db.transaction([AI_SESSION_STORE_NAMES.battleStoryCheckpoints], 'readwrite');
    const store = transaction.objectStore(AI_SESSION_STORE_NAMES.battleStoryCheckpoints);
    const index = store.index('by_session_boundary');
    const request = index.openCursor(
      IDBKeyRange.bound(
        [input.sessionId, Math.max(0, Math.floor(input.startBoundaryIndex))],
        [input.sessionId, Number.MAX_SAFE_INTEGER]
      ),
      'next'
    );
    let deletedCount = 0;

    transaction.oncomplete = () => resolve(deletedCount);
    transaction.onabort = () => reject(transaction.error ?? new Error('删除 battle story checkpoints 失败'));
    transaction.onerror = () => reject(transaction.error ?? new Error('删除 battle story checkpoints 失败'));

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      deletedCount += 1;
      cursor.continue();
    };

    request.onerror = () => reject(request.error ?? new Error('读取 battle story checkpoint 游标失败'));
  });
};
