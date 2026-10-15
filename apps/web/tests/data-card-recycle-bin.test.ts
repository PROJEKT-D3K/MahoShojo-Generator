import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppDrizzleDb } from '@/lib/db/drizzle';
import {
  permanentlyDeleteDataCardsByUserAndIds,
  pruneUserRecycleBinDataCards,
  restoreDataCardByIdAndUser,
} from '@/lib/db/repositories/data-cards-core';
import { pruneUserRecycleBin } from '@/lib/database/data-cards';
import * as schema from '@/lib/db/schema';

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => runtime.db }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: async () => ({ user: { id: 7 } }) }));
import recycleHandler from '@/app/api/data-card-recycle/handler';

let sqlite: Database;
let db: AppDrizzleDb;

const readCards = (connection = sqlite) => connection.prepare(
  'SELECT id, user_id, deleted_at FROM data_cards ORDER BY id',
).all();

const createD1Db = (
  connection: Database,
  queries: string[],
  beforeExecute?: () => Promise<void>,
) => drizzleD1({
  prepare: (text: string) => ({
    bind: (...params: unknown[]) => ({
      raw: async () => {
        queries.push(text);
        await beforeExecute?.();
        return connection.prepare(text).raw().all(...params);
      },
      all: async () => {
        queries.push(text);
        await beforeExecute?.();
        return { success: true, results: connection.prepare(text).all(...params) };
      },
    }),
  }),
} as never, { schema });

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  runtime.db = db;
  sqlite.exec(`
    CREATE TABLE data_cards (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, deleted_at TEXT, updated_at TEXT
    );
    INSERT INTO data_cards (id, user_id, deleted_at) VALUES
      ('oldest', 7, '2026-01-01'), ('middle', 7, '2026-01-02'),
      ('newest', 7, '2026-01-03'), ('active', 7, NULL),
      ('other-deleted', 8, '2025-01-01'), ('other-active', 8, NULL);
  `);
});

afterEach(() => {
  runtime.db = null;
  sqlite.close();
});

describe('回收站永久删除边界', () => {
  test('只删除本人仍在回收站的卡片，拒绝活动卡、其他用户和缺失 ID', async () => {
    expect(await permanentlyDeleteDataCardsByUserAndIds(db, 7, [
      ' oldest ', 'oldest', 'active', 'other-deleted', 'other-active', 'missing', '',
    ])).toBe(1);
    expect(readCards().map((row) => (row as { id: string }).id)).toEqual([
      'active', 'middle', 'newest', 'other-active', 'other-deleted',
    ]);
    expect(await permanentlyDeleteDataCardsByUserAndIds(db, 7, [])).toBe(0);
    expect(await permanentlyDeleteDataCardsByUserAndIds(db, 7, ['oldest', 'active'])).toBe(0);
  });

  test('恢复先提交后，旧的显式永久删除请求不能删除活动卡', async () => {
    expect(await restoreDataCardByIdAndUser(db, 'oldest', 7)).toBe(1);
    expect(await permanentlyDeleteDataCardsByUserAndIds(db, 7, ['oldest'])).toBe(0);
    expect(sqlite.prepare('SELECT deleted_at FROM data_cards WHERE id = ?').get('oldest'))
      .toEqual({ deleted_at: null });
  });

  test.each(['active', 'other-active', 'other-deleted', 'missing'])('DELETE 接口拒绝非本人回收站目标 %s', async (id) => {
    const before = readCards();
    const response = await recycleHandler(new Request(`https://example.test/api/data-card-recycle?id=${id}`, {
      method: 'DELETE',
    }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '数据卡不存在或无权访问' });
    expect(readCards()).toEqual(before);
  });

  test('DELETE 接口保留成功响应与重复删除的 404 形状', async () => {
    const request = () => new Request('https://example.test/api/data-card-recycle?id=oldest', { method: 'DELETE' });
    const response = await recycleHandler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: '数据卡已彻底删除' });
    expect((await recycleHandler(request())).status).toBe(404);
  });
});

describe('回收站原子裁剪', () => {
  test('保留最新 keep 张，只报告实际删除的本人墓碑 ID', async () => {
    expect((await pruneUserRecycleBin(7, 1)).sort()).toEqual(['middle', 'oldest']);
    expect(readCards()).toEqual([
      { id: 'active', user_id: 7, deleted_at: null },
      { id: 'newest', user_id: 7, deleted_at: '2026-01-03' },
      { id: 'other-active', user_id: 8, deleted_at: null },
      { id: 'other-deleted', user_id: 8, deleted_at: '2025-01-01' },
    ]);
    expect(await pruneUserRecycleBin(7, 1)).toEqual([]);
  });

  test.each([3, 4, Number.MAX_SAFE_INTEGER])('未超过 keep=%s 时不删除', async (keep) => {
    const before = readCards();
    expect(await pruneUserRecycleBinDataCards(db, 7, keep)).toEqual([]);
    expect(readCards()).toEqual(before);
  });

  test('keep=0 清空本人的回收站，保留活动卡与其他用户', async () => {
    expect((await pruneUserRecycleBinDataCards(db, 7, 0)).sort()).toEqual(['middle', 'newest', 'oldest']);
    expect(readCards().map((row) => (row as { id: string }).id)).toEqual(['active', 'other-active', 'other-deleted']);
    expect(await pruneUserRecycleBinDataCards(db, 9, 0)).toEqual([]);
  });

  test('非负小数仍沿用向下取整的 keep 语义', async () => {
    expect((await pruneUserRecycleBinDataCards(db, 7, 1.9)).sort()).toEqual(['middle', 'oldest']);
  });

  test.each([-1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    '非法 keep=%s 报错并安全保留全部数据', async (keep) => {
      const before = readCards();
      await expect(pruneUserRecycleBinDataCards(db, 7, keep)).rejects.toThrow(RangeError);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await pruneUserRecycleBin(7, keep)).toEqual([]);
      expect(error).toHaveBeenCalledWith('裁剪回收站失败:', expect.any(RangeError));
      expect(readCards()).toEqual(before);
    },
  );

  test('同一删除时间使用 ID 稳定决定保留项', async () => {
    sqlite.exec(`UPDATE data_cards SET deleted_at = 'same-second' WHERE user_id = 7 AND deleted_at IS NOT NULL`);
    expect((await pruneUserRecycleBinDataCards(db, 7, 1)).sort()).toEqual(['newest', 'oldest']);
    expect(sqlite.prepare('SELECT id FROM data_cards WHERE user_id = 7 AND deleted_at IS NOT NULL').all())
      .toEqual([{ id: 'middle' }]);
  });

  test('恢复发生在裁剪前，当前回收站已达上限时不按旧列表继续删', async () => {
    expect(await restoreDataCardByIdAndUser(db, 'oldest', 7)).toBe(1);
    const before = readCards();
    expect(await pruneUserRecycleBin(7, 2)).toEqual([]);
    expect(readCards()).toEqual(before);
  });

  test('RETURNING 只报告真正被删除的 ID，不返回被数据库跳过的候选项', async () => {
    sqlite.exec(`CREATE TRIGGER skip_delete BEFORE DELETE ON data_cards
      WHEN OLD.id = 'oldest' BEGIN SELECT RAISE(IGNORE); END`);
    expect(await pruneUserRecycleBin(7, 1)).toEqual(['middle']);
    expect(sqlite.prepare('SELECT id FROM data_cards WHERE id = ?').get('oldest')).toEqual({ id: 'oldest' });
  });

  test('语句失败整体回滚，不报告部分删除', async () => {
    const before = readCards();
    sqlite.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON data_cards
      WHEN OLD.id = 'oldest' BEGIN SELECT RAISE(ABORT, 'delete failed'); END`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await pruneUserRecycleBin(7, 1)).toEqual([]);
    expect(readCards()).toEqual(before);
  });

  test('真实 D1 Drizzle adapter 只执行一条 DELETE，原子选择并返回实际 IDs', async () => {
    const queries: string[] = [];
    runtime.db = createD1Db(sqlite, queries);
    expect((await pruneUserRecycleBin(7, 1)).sort()).toEqual(['middle', 'oldest']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^delete from/i);
    expect(queries[0]).toMatch(/LIMIT -1 OFFSET \?/);
    expect(queries[0]).toMatch(/returning/i);
  });

  test.each(['restore-first', 'cleanup-first'])('两个独立 SQLite 连接交错执行 %s', async (order) => {
    const dir = mkdtempSync(join(tmpdir(), 'recycle-cleanup-'));
    const path = join(dir, 'race.sqlite');
    writeFileSync(path, sqlite.serialize());
    const cleanup = new Database(path);
    const restore = new Database(path);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = async () => { entered(); await blocked; };
    const cleanupQueries: string[] = [];
    const restoreQueries: string[] = [];
    const cleanupDb = createD1Db(cleanup, cleanupQueries, order === 'restore-first' ? wait : undefined);
    const restoreDb = createD1Db(restore, restoreQueries, order === 'cleanup-first' ? wait : undefined);
    try {
      if (order === 'restore-first') {
        const pendingCleanup = pruneUserRecycleBinDataCards(cleanupDb, 7, 1);
        await started;
        expect(await restoreDataCardByIdAndUser(restoreDb, 'oldest', 7)).toBe(1);
        release();
        expect(await pendingCleanup).toEqual(['middle']);
        expect(cleanup.prepare('SELECT deleted_at FROM data_cards WHERE id = ?').get('oldest'))
          .toEqual({ deleted_at: null });
      } else {
        const pendingRestore = restoreDataCardByIdAndUser(restoreDb, 'oldest', 7);
        await started;
        expect((await pruneUserRecycleBinDataCards(cleanupDb, 7, 1)).sort()).toEqual(['middle', 'oldest']);
        release();
        expect(await pendingRestore).toBe(0);
        expect(cleanup.prepare('SELECT id FROM data_cards WHERE id = ?').get('oldest')).toBeUndefined();
      }
      expect(cleanupQueries).toHaveLength(1);
      expect(restoreQueries).toHaveLength(1);
      expect(cleanup.prepare('SELECT id FROM data_cards WHERE deleted_at IS NOT NULL AND user_id = 7').all())
        .toEqual([{ id: 'newest' }]);
    } finally {
      release();
      cleanup.close();
      restore.close();
      rmSync(dir, { recursive: true });
    }
  });
});
