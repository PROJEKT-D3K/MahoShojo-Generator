import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import type { AppDrizzleDb } from '@/lib/db/drizzle';
import { softDeleteDataCardByIdAndUser } from '@/lib/db/repositories/data-cards-core';
import { deleteDataCard } from '@/lib/database/data-cards';
import { config } from '@/lib/config';
import * as schema from '@/lib/db/schema';

const runtime = vi.hoisted(() => ({ db: null as unknown, error: null as Error | null }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => { if (runtime.error) throw runtime.error; return runtime.db; } }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: async () => ({ user: { id: 7 } }) }));
import handler from '@/app/api/data-cards/handler';

let sqlite: Database;
let db: AppDrizzleDb;
const readCards = () => sqlite.prepare('SELECT * FROM data_cards ORDER BY id').all();
const request = (id = 'active') => new Request(`https://example.test/api/data-cards?id=${id}`, { method: 'DELETE' });
const createD1Db = (execute: (text: string, params: unknown[]) => Promise<unknown[][]>) => drizzleD1({
  prepare: (text: string) => ({ bind: (...params: unknown[]) => ({ raw: () => execute(text, params) }) }),
} as never, { schema });

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  runtime.db = db;
  runtime.error = null;
  sqlite.exec(`
    CREATE TABLE data_cards (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
      deleted_at TEXT, updated_at TEXT, data TEXT
    );
    INSERT INTO data_cards (id, user_id, type, deleted_at, data) VALUES
      ('old-character', 7, 'character', '2026-01-01', '{"keep":"character"}'),
      ('old-scenario', 7, 'scenario', '2026-01-02', '{"keep":"scenario"}'),
      ('old-questionnaire', 7, 'questionnaire', '2026-01-03', '{"keep":"questionnaire"}'),
      ('active', 7, 'character', NULL, '{"keep":"active"}'),
      ('other-deleted', 8, 'character', '2025-01-01', '{}'),
      ('other-active', 8, 'character', NULL, '{}');
  `);
});

afterEach(() => {
  runtime.db = null;
  runtime.error = null;
  sqlite.close();
});

describe('普通删除的原子回收站容量限制', () => {
  test('未满时只软删目标，并从 RETURNING 回报实际 ID；所有旧墓碑完整保留', async () => {
    const before = readCards().filter((row) => (row as { id: string }).id !== 'active');
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, 4)).toEqual({ status: 'deleted', id: 'active' });
    expect(readCards().filter((row) => (row as { id: string }).id !== 'active')).toEqual(before);
    expect(sqlite.prepare('SELECT deleted_at, data FROM data_cards WHERE id = ?').get('active'))
      .toEqual({ deleted_at: expect.any(String), data: '{"keep":"active"}' });
  });

  test.each([0, 1, 2, 3])('满额或历史超限 limit=%s 时跨类型合计，保留每一条记录', async (limit) => {
    const before = readCards();
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, limit)).toEqual({ status: 'recycle_bin_full' });
    expect(readCards()).toEqual(before);
  });

  test('叙事历史卡也占用同一账号容量，不限于当前可见的角色/问卷筛选', async () => {
    sqlite.exec(`INSERT INTO data_cards (id, user_id, type, deleted_at, data)
      VALUES ('old-history', 7, 'history', '2026-01-04', '{}')`);
    const before = readCards();
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, 4)).toEqual({ status: 'recycle_bin_full' });
    expect(readCards()).toEqual(before);
  });

  test('账号之间独立计数，其他 owner 的墓碑不占本人容量', async () => {
    expect(await softDeleteDataCardByIdAndUser(db, 'other-active', 8, 2)).toEqual({ status: 'deleted', id: 'other-active' });
    expect(sqlite.prepare('SELECT deleted_at FROM data_cards WHERE id = ?').get('active')).toEqual({ deleted_at: null });
  });

  test.each(['missing', 'other-active', 'other-deleted'])('满额也不能把无权目标 %s 当成本人卡', async (id) => {
    const before = readCards();
    expect(await softDeleteDataCardByIdAndUser(db, id, 7, 0)).toEqual({ status: 'not_found' });
    expect(readCards()).toEqual(before);
  });

  test('已在回收站和重复请求单独拒绝，不再次更新时间或占容量', async () => {
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, 4)).toEqual({ status: 'deleted', id: 'active' });
    const before = readCards();
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, 4)).toEqual({ status: 'already_deleted' });
    expect(await softDeleteDataCardByIdAndUser(db, 'old-character', 7, 4)).toEqual({ status: 'already_deleted' });
    expect(readCards()).toEqual(before);
  });

  test.each([-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('非法容量 %s 抛错且不写入', async (limit) => {
    const before = readCards();
    await expect(softDeleteDataCardByIdAndUser(db, 'active', 7, limit)).rejects.toThrow(RangeError);
    expect(readCards()).toEqual(before);
  });

  test('D1 adapter 成功只执行一条带 owner/active/COUNT 的 UPDATE RETURNING，无先读后写', async () => {
    const queries: string[] = [];
    const d1 = createD1Db(async (text, params) => {
      queries.push(text);
      return sqlite.prepare(text).raw().all(...params) as unknown[][];
    });
    expect(await softDeleteDataCardByIdAndUser(d1, 'active', 7, 4)).toEqual({ status: 'deleted', id: 'active' });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^update /i);
    expect(queries[0]).toMatch(/COUNT\(\*\)/);
    expect(queries[0]).toMatch(/deleted_at" is null/i);
    expect(queries[0]).toMatch(/deleted_at" IS NOT NULL/);
    expect(queries[0]).toMatch(/returning "id"/i);
  });

  test('UPDATE 被跳过时不可把目标 ID 或重读状态当作成功回执', async () => {
    sqlite.exec(`CREATE TRIGGER skip_update BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(IGNORE); END`);
    const before = readCards();
    expect(await softDeleteDataCardByIdAndUser(db, 'active', 7, 4)).toEqual({ status: 'conflict' });
    expect(readCards()).toEqual(before);
  });

  test('UPDATE 拒绝后诊断前容量释放，仅提示冲突重试，不猜测已删除', async () => {
    let calls = 0;
    const d1 = createD1Db(async (text, params) => {
      if (++calls === 2) sqlite.exec(`UPDATE data_cards SET deleted_at = NULL WHERE id = 'old-character'`);
      return sqlite.prepare(text).raw().all(...params) as unknown[][];
    });
    expect(await softDeleteDataCardByIdAndUser(d1, 'active', 7, 3)).toEqual({ status: 'conflict' });
    expect(sqlite.prepare('SELECT deleted_at FROM data_cards WHERE id = ?').get('active')).toEqual({ deleted_at: null });
  });

  test('数据库 UPDATE 失败保留所有数据并透传异常', async () => {
    sqlite.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(ABORT, 'storage write failed'); END`);
    const before = readCards();
    await expect(deleteDataCard('active', 7)).rejects.toThrow();
    expect(readCards()).toEqual(before);
  });

  test('诊断读取故障不能转换成空回收站或满额', async () => {
    let calls = 0;
    runtime.db = createD1Db(async (text, params) => {
      if (++calls === 2) throw new Error('storage read failed');
      return sqlite.prepare(text).raw().all(...params) as unknown[][];
    });
    sqlite.exec(`CREATE TRIGGER skip_update BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(IGNORE); END`);
    const before = readCards();
    await expect(deleteDataCard('active', 7)).rejects.toThrow();
    expect(readCards()).toEqual(before);
  });

  test('两个 SQLite worker/独立连接同时争抢最后一位，恰有一个成功且旧墓碑全保留', async () => {
    sqlite.exec(`INSERT INTO data_cards (id, user_id, type, data) VALUES ('active-2', 7, 'scenario', '{}')`);
    const before = readCards().filter((row) => (row as { deleted_at: string | null }).deleted_at !== null);
    const dir = mkdtempSync(join(tmpdir(), 'recycle-capacity-'));
    const path = join(dir, 'race.sqlite');
    writeFileSync(path, sqlite.serialize());
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const barrier = new Int32Array(gate);
    let readyCount = 0;
    let ready!: () => void;
    const bothReady = new Promise<void>((resolve) => { ready = resolve; });
    const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');
    const workers = [0, 1].map(() => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.module);
      const db = new Database(workerData.path);
      db.pragma('busy_timeout = 5000');
      parentPort.on('message', ({ text, params }) => {
        try {
          if (/^update /i.test(text)) {
            parentPort.postMessage({ ready: true });
            Atomics.wait(new Int32Array(workerData.gate), 0, 0);
          }
          parentPort.postMessage({ rows: db.prepare(text).raw().all(...params) });
        } catch (error) { parentPort.postMessage({ error: String(error) }); }
      });
    `, { eval: true, workerData: { module: sqliteModule, path, gate } }));
    const connections = workers.map((worker) => createD1Db((text, params) => new Promise<unknown[][]>((resolve, reject) => {
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onMessage = (message: { ready?: boolean; error?: string; rows?: unknown[][] }) => {
        if (message.ready) { if (++readyCount === 2) ready(); return; }
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve(message.rows!);
      };
      const cleanup = () => { worker.off('error', onError); worker.off('message', onMessage); };
      worker.on('error', onError); worker.on('message', onMessage);
      worker.postMessage({ text, params });
    })));
    try {
      const results = Promise.all([
        softDeleteDataCardByIdAndUser(connections[0], 'active', 7, 4),
        softDeleteDataCardByIdAndUser(connections[1], 'active-2', 7, 4),
      ]);
      await Promise.race([bothReady, results]);
      expect(readyCount).toBe(2);
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      expect((await results).map((result) => result.status).sort()).toEqual(['deleted', 'recycle_bin_full']);
      const inspect = new Database(path);
      try {
        expect(inspect.prepare('SELECT COUNT(*) AS count FROM data_cards WHERE user_id = 7 AND deleted_at IS NOT NULL').get())
          .toEqual({ count: 4 });
        expect(inspect.prepare('SELECT * FROM data_cards WHERE id IN (?, ?, ?, ?) ORDER BY id')
          .all('old-character', 'old-scenario', 'old-questionnaire', 'other-deleted')).toEqual(before);
        expect(inspect.prepare('SELECT COUNT(*) AS count FROM data_cards WHERE id IN (?, ?) AND deleted_at IS NULL')
          .get('active', 'active-2')).toEqual({ count: 1 });
      } finally { inspect.close(); }
    } finally {
      Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(dir, { recursive: true });
    }
  });
});

describe('legacy DELETE 回执与存储错误', () => {
  const fillRecycleBin = () => {
    for (let i = 3; i < config.RECYCLE_BIN_LIMIT; i += 1) {
      sqlite.prepare('INSERT INTO data_cards (id, user_id, type, deleted_at) VALUES (?, 7, ?, ?)')
        .run(`extra-${i}`, 'scenario', '2026-01-01');
    }
  };

  test('成功响应兼容旧客户端，只执行软删，不自动清理旧卡', async () => {
    const before = readCards().filter((row) => (row as { id: string }).id !== 'active');
    const queries: string[] = [];
    runtime.db = createD1Db(async (text, params) => {
      queries.push(text);
      return sqlite.prepare(text).raw().all(...params) as unknown[][];
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, message: '数据卡已移入回收站' });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^update /i);
    expect(readCards().filter((row) => (row as { id: string }).id !== 'active')).toEqual(before);
  });

  test('服务端配置容量已满时返回 409 与旧客户端可直接显示的 error，绝不裁剪', async () => {
    fillRecycleBin();
    const before = readCards();
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'RECYCLE_BIN_FULL',
      error: '回收站已满，所有类型的数据卡共享账号回收站容量。本次未删除该卡或其他卡片，请先到回收站恢复或彻底删除不需要的卡片后重试。',
    });
    expect(readCards()).toEqual(before);
  });

  test.each(['missing', 'other-active', 'other-deleted'])('不存在或不属于本人 %s 返回相同 404', async (id) => {
    const response = await handler(request(id));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '数据卡不存在或无权访问' });
  });

  test('重复删除返回已在回收站冲突，不报告第二次成功', async () => {
    expect((await handler(request())).status).toBe(200);
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DATA_CARD_ALREADY_DELETED' });
  });

  test('未实际更新且诊断已变化时返回可重试冲突', async () => {
    sqlite.exec(`CREATE TRIGGER skip_update BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(IGNORE); END`);
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'DATA_CARD_DELETE_CONFLICT' });
  });

  test.each(['unavailable', 'initialization', 'write-failure', 'read-failure'])('存储故障 %s 返回 500，不伪装成 404 或满额', async (failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if (failure === 'unavailable') runtime.db = null;
    if (failure === 'initialization') runtime.error = new Error('storage initialization failed');
    if (failure === 'write-failure') sqlite.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON data_cards BEGIN SELECT RAISE(ABORT, 'write failed'); END`);
    if (failure === 'read-failure') {
      fillRecycleBin();
      runtime.db = createD1Db(async (text, params) => {
        if (/^select /i.test(text)) throw new Error('read failed');
        return sqlite.prepare(text).raw().all(...params) as unknown[][];
      });
    }
    const before = readCards();
    const response = await handler(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: '删除数据卡失败' });
    expect(readCards()).toEqual(before);
  });
});
