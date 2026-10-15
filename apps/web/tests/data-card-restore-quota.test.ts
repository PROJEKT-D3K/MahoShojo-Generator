import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/lib/db/schema';
import { restoreDataCardByIdAndUser } from '@/lib/db/repositories/data-cards-core';
import { deletionFixture, recycleMigration } from './helpers/owned-deletion-fixture';

let sqlite: InstanceType<typeof Database>;
const makeDb = (execute: (text: string, params: unknown[]) => Promise<{ success: true; results: Record<string, unknown>[]; meta: { changes: number } }>) => drizzle({
  prepare: (text: string) => ({ bind: (...params: unknown[]) => ({
    all: () => execute(text, params),
    raw: async () => (await execute(text, params)).results.map(Object.values),
  }) }),
} as never, { schema });
const db = () => makeDb(async (text, params) => {
  const results = sqlite.prepare(text).all(...params) as Record<string, unknown>[];
  const { n } = sqlite.prepare('SELECT changes() AS n').get() as { n: number };
  return { success: true, results, meta: { changes: n } };
});
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(deletionFixture + recycleMigration);
  sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, slot_count INTEGER); INSERT INTO users VALUES (7, 2), (8, 20)');
});
afterEach(() => { sqlite.close(); runtime.db = null; runtime.error = null; });

test('两次恢复不能重复占用最后一槽', async () => {
  await restoreDataCardByIdAndUser(db(), 'r1', 7, 20);
  await restoreDataCardByIdAndUser(db(), 'r2', 7, 20);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM data_cards WHERE user_id=7 AND deleted_at IS NULL').get()).toEqual({ n: 2 });
});

test.each(['r1', 'r2'])('成功只改变墓碑和更新时间，保留正文/审核/待审/代际：%s', async (id) => {
  sqlite.prepare("UPDATE data_cards SET recycle_generation='generation' WHERE id=?").run(id);
  sqlite.prepare("INSERT INTO data_card_updates(id,data_card_id,user_id,data) VALUES ('p',?,7,'pending')").run(id);
  const before = sqlite.prepare('SELECT * FROM data_cards WHERE id=?').get(id) as Record<string, unknown>;
  const pending = sqlite.prepare('SELECT * FROM data_card_updates').all();
  expect(await restoreDataCardByIdAndUser(db(), id, 7, 20)).toEqual({ status: 'restored', id });
  expect(sqlite.prepare('SELECT * FROM data_cards WHERE id=?').get(id)).toEqual({ ...before, deleted_at: null, updated_at: expect.any(String) });
  expect(sqlite.prepare('SELECT * FROM data_card_updates').all()).toEqual(pending);
});

test.each(['foreign', 'a', 'missing'])('其他账号、活动卡及永久删除的目标不能误写：%s', async (id) => {
  const before = sqlite.prepare('SELECT * FROM data_cards').all();
  expect(await restoreDataCardByIdAndUser(db(), id, 7, 20)).toEqual({ status: 'not_found' });
  expect(sqlite.prepare('SELECT * FROM data_cards').all()).toEqual(before);
});

test.each([null, 0, -3, 2.9, 3])('当前容量遵循有效正整数/默认规则：%s', async (capacity) => {
  sqlite.prepare('UPDATE users SET slot_count=? WHERE id=7').run(capacity);
  const expected = capacity !== null && capacity > 0 ? Math.trunc(capacity) : 1;
  expect((await restoreDataCardByIdAndUser(db(), 'r1', 7, 1)).status).toBe(expected >= 2 ? 'restored' : 'quota_exceeded');
});

import { DATA_CARD_SLOT_BYTES } from '@/lib/data-card-size';
import { HOT_CARD_FAVORITE_THRESHOLD, HOT_CARD_USAGE_THRESHOLD } from '@/lib/constants';
import { countUserUsedDataCardSlots } from '@/lib/db/repositories/data-cards-core';

test.each(['body', 'pending', 'active-pending'])('UTF-8多槽按正文/待审最大体积计费：%s', async (source) => {
  const large = '中'.repeat(Math.floor(DATA_CARD_SLOT_BYTES / 3) + 1);
  if (source === 'body') sqlite.prepare("UPDATE data_cards SET data=? WHERE id='r1'").run(large);
  else sqlite.prepare('INSERT INTO data_card_updates(id,data_card_id,user_id,data) VALUES (?,?,7,?)').run('p', source === 'pending' ? 'r1' : 'a', large);
  expect((await restoreDataCardByIdAndUser(db(), 'r1', 7, 20)).status).toBe('quota_exceeded');
  sqlite.exec('UPDATE users SET slot_count=3 WHERE id=7');
  expect((await restoreDataCardByIdAndUser(db(), 'r1', 7, 20)).status).toBe('restored');
  expect(await countUserUsedDataCardSlots(db(), 7)).toBe(3);
});

test('热门只减一槽，零成本卡可在恰好满额时恢复', async () => {
  sqlite.exec('UPDATE users SET slot_count=1 WHERE id=7');
  sqlite.prepare("UPDATE data_cards SET favorite_count=?,usage_count=? WHERE id='r1'").run(HOT_CARD_FAVORITE_THRESHOLD + 1, HOT_CARD_USAGE_THRESHOLD + 1);
  expect((await restoreDataCardByIdAndUser(db(), 'r1', 7, 20)).status).toBe('restored');
  expect(await countUserUsedDataCardSlots(db(), 7)).toBe(1);
  sqlite.prepare("UPDATE data_cards SET data=?,favorite_count=?,usage_count=? WHERE id='r2'").run('x'.repeat(DATA_CARD_SLOT_BYTES + 1), HOT_CARD_FAVORITE_THRESHOLD + 1, HOT_CARD_USAGE_THRESHOLD + 1);
  expect((await restoreDataCardByIdAndUser(db(), 'r2', 7, 20)).status).toBe('quota_exceeded');
});

test.each(['body', 'pending', 'active', 'capacity'])('执行前变化必须按写时值拒绝：%s', async (change) => {
  let first = true;
  const connection = makeDb(async (text, params) => {
    if (first) {
      first = false;
      if (change === 'capacity') sqlite.exec('UPDATE users SET slot_count=1 WHERE id=7');
      else if (change === 'pending') sqlite.prepare("INSERT INTO data_card_updates(id,data_card_id,data) VALUES ('p','r1',?)").run('x'.repeat(DATA_CARD_SLOT_BYTES + 1));
      else sqlite.prepare('UPDATE data_cards SET data=? WHERE id=?').run('x'.repeat(DATA_CARD_SLOT_BYTES + 1), change === 'body' ? 'r1' : 'a');
    }
    const results = sqlite.prepare(text).all(...params) as Record<string, unknown>[];
    const { n } = sqlite.prepare('SELECT changes() AS n').get() as { n: number };
    return { success: true, results, meta: { changes: n } };
  });
  expect((await restoreDataCardByIdAndUser(connection, 'r1', 7, 20)).status).toBe('quota_exceeded');
  expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='r1'").get()).toEqual({ deleted_at: 'same-second' });
});

const runtime = vi.hoisted(() => ({ db: null as unknown, error: null as Error | null }));
vi.mock('@/lib/db/drizzle', () => ({ getDrizzleDbFromRuntime: () => { if (runtime.error) throw runtime.error; return runtime.db; } }));
vi.mock('@/lib/auth/server', () => ({ requireAuthUser: async () => ({ user: { id: 7 } }) }));
import handler from '@/app/api/data-card-recycle/handler';
const patch = (id: unknown = 'r1') => handler(new Request('https://example.test/api/data-card-recycle', {
  method: 'PATCH', body: JSON.stringify({ id }), headers: { 'Content-Type': 'application/json' },
}));

test('真实PATCH保持成功、满额、缺失与非法ID语义', async () => {
  runtime.db = db();
  expect((await patch()).status).toBe(200);
  expect((await patch()).status).toBe(404);
  expect((await patch('r2')).status).toBe(409);
  expect((await patch('foreign')).status).toBe(404);
  expect((await patch(null)).status).toBe(400);
  expect((await patch({})).status).toBe(400);
});

test.each(['connection', 'query', 'pending-table', 'users-table', 'diagnostic'])('存储异常failclosed，不按零占用/空待审恢复：%s', async (failure) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const before = sqlite.prepare('SELECT * FROM data_cards').all();
  if (failure === 'pending-table') sqlite.exec('DROP TABLE data_card_updates');
  if (failure === 'users-table') sqlite.exec('DROP TABLE users');
  if (failure === 'diagnostic') sqlite.exec('UPDATE users SET slot_count=1 WHERE id=7');
  let calls = 0;
  runtime.db = failure === 'connection' ? null : makeDb(async (text, params) => {
    if (failure === 'query' || (failure === 'diagnostic' && ++calls === 2)) throw new Error('storage failed');
    const results = sqlite.prepare(text).all(...params) as Record<string, unknown>[];
    const { n } = sqlite.prepare('SELECT changes() AS n').get() as { n: number };
    return { success: true, results, meta: { changes: n } };
  });
  expect((await patch()).status).toBe(500);
  expect(sqlite.prepare('SELECT * FROM data_cards').all()).toEqual(before);
});

test.each([undefined, {}, { success: true, results: [], meta: { changes: 1 } },
  { success: true, results: [{ id: 'wrong' }], meta: { changes: 1 } }])('写后坏回执不归一化成零，不重试：%j', async (receipt) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let writes = 0;
  runtime.db = drizzle({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({ all: async () => {
    writes++; sqlite.prepare(text).all(...params); return receipt;
  } }) }) } as never, { schema });
  expect((await patch()).status).toBe(500);
  expect(writes).toBe(1);
  expect(sqlite.prepare("SELECT deleted_at FROM data_cards WHERE id='r1'").get()).toEqual({ deleted_at: null });
});


test.each(['0x1', '0b1', 'garbage', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('异常容量不回退为更大默认值：%s', async (value) => {
  sqlite.prepare('UPDATE users SET slot_count=? WHERE id=7').run(value);
  const before = sqlite.prepare('SELECT * FROM data_cards').all();
  await expect(restoreDataCardByIdAndUser(db(), 'r1', 7, 20)).rejects.toThrow('Invalid restore quota diagnosis');
  expect(sqlite.prepare('SELECT * FROM data_cards').all()).toEqual(before);
});

import { D1PreparedStatement, type D1HttpTransport } from '@mahoshojo/hosted-runtime/d1-http-client';

test('HTTP客户端使用strictReturning/none且拒绝归一化坏回执，不重发', async () => {
  const query = vi.fn(async () => ({ success: true, result: [{ success: true, results: null, meta: { changes: 0 } }] }));
  const transport = { query, queryRaw: vi.fn(), queryBatch: vi.fn() } as D1HttpTransport;
  const connection = drizzle({ prepare: (text: string) => new D1PreparedStatement(text, transport) } as never, { schema });
  await expect(restoreDataCardByIdAndUser(connection, 'r1', 7, 20)).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(expect.stringMatching(/^update /), expect.any(Array), { retry: 'none', strictReturning: true });
});

import { purgeOwnedCardsAtomically, readOwnedDeletionSnapshot } from '@/lib/db/repositories/data-card-owned-deletion';

test.each(['restore-first', 'purge-first'])('真实B2集合删除与恢复的两种确定顺序：%s', async (order) => {
  const connection = db();
  const snapshots = await Promise.all(['r1', 'r2'].map((id) => readOwnedDeletionSnapshot(connection, 7, id, 'recycle')));
  const targets = snapshots.map((row) => row!);
  if (order === 'restore-first') {
    expect((await restoreDataCardByIdAndUser(connection, 'r1', 7, 20)).status).toBe('restored');
    expect(await purgeOwnedCardsAtomically(connection, 7, targets, 'recycle')).toEqual([]);
    expect(sqlite.prepare("SELECT id,deleted_at FROM data_cards WHERE id IN ('r1','r2') ORDER BY id").all())
      .toEqual([{ id: 'r1', deleted_at: null }, { id: 'r2', deleted_at: 'same-second' }]);
  } else {
    expect((await purgeOwnedCardsAtomically(connection, 7, targets, 'recycle')).sort()).toEqual(['r1', 'r2']);
    expect((await restoreDataCardByIdAndUser(connection, 'r1', 7, 20)).status).toBe('not_found');
    expect(sqlite.prepare("SELECT id FROM data_cards WHERE id IN ('r1','r2')").all()).toEqual([]);
  }
});

test.each([-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])('非法默认容量拒绝写入：%s', async (capacity) => {
  const before = sqlite.prepare('SELECT * FROM data_cards').all();
  await expect(restoreDataCardByIdAndUser(db(), 'r1', 7, capacity)).rejects.toThrow(RangeError);
  expect(sqlite.prepare('SELECT * FROM data_cards').all()).toEqual(before);
});
