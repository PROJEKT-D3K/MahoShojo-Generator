import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { AppDrizzleDb } from '@/lib/db/drizzle';
import { listPublicDataCardsWithFilters, listUserDataCards } from '@/lib/db/repositories/data-cards-core';
import { listUserFavoritesWithCards } from '@/lib/db/repositories/favorites';
import * as schema from '@/lib/db/schema';

let sqlite: Database;
let db: AppDrizzleDb;

const exec = (sqlText: string) => sqlite.exec(sqlText);

describe('listPublicDataCardsWithFilters', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;

    exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        email TEXT NOT NULL
      );
      CREATE TABLE data_cards (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        data TEXT NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        public_since TEXT,
        usage_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        favorite_count INTEGER DEFAULT 0,
        review_status TEXT DEFAULT 'approved',
        is_recommended INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE data_card_tags (
        data_card_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (data_card_id, tag_id)
      );
      CREATE TABLE data_card_updates (
        data_card_id TEXT PRIMARY KEY, data TEXT, name TEXT, description TEXT, updated_at TEXT
      );
      CREATE TABLE favorites (user_id INTEGER, data_card_id TEXT, created_at TEXT);

      INSERT INTO users (id, username, email) VALUES
        (1, 'alice', 'alice@example.test');

      INSERT INTO data_cards (
        id, user_id, type, name, description, data, is_public, review_status,
        is_recommended, like_count, usage_count, favorite_count, created_at, updated_at
      ) VALUES
        ('old-high-likes', 1, 'character', '高赞旧卡', '', '{}', 1, 'approved', 1, 30, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('new-low-likes', 1, 'character', '低赞新卡', '', '{}', 1, 'approved', 1, 1, 30, 2, '2026-01-02T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
        ('middle-high-favorites', 1, 'character', '高收藏中间卡', '', '{}', 1, 'approved', 1, 2, 2, 30, '2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('not-recommended', 1, 'character', '非推荐卡', '', '{}', 1, 'approved', 0, 99, 99, 99, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  test('自有卡片分页稳定排序，保留正文/待审内容并隔离其他用户', async () => {
    exec(`INSERT INTO data_card_updates (data_card_id, data) VALUES ('not-recommended', '{"pending":true}')`);
    const first = await listUserDataCards(db, { userId: 1, limit: 2, offset: 0 });
    const second = await listUserDataCards(db, { userId: 1, limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map(row => row.id)).size).toBe(4);
    expect(first[0]).toMatchObject({ id: 'not-recommended', data: '{}', pending_data: '{"pending":true}' });
    expect(await listUserDataCards(db, { userId: 2, limit: 2, offset: 0 })).toEqual([]);
  });

  test('收藏同时间分页不重复，并保持公开审核权限过滤', async () => {
    exec(`INSERT INTO favorites SELECT 7, id, '2026-09-20' FROM data_cards`);
    const first = await listUserFavoritesWithCards(db, 7, undefined, { limit: 2, offset: 0 });
    const second = await listUserFavoritesWithCards(db, 7, undefined, { limit: 2, offset: 2 });
    expect(new Set([...first, ...second].map(row => row.id)).size).toBe(4);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.every(row => row.data === '{}')).toBe(true);
    exec(`UPDATE data_cards SET is_public = 0 WHERE id = 'old-high-likes'`);
    const visible = await listUserFavoritesWithCards(db, 7, undefined, { limit: 8, offset: 0 });
    expect(visible).toHaveLength(3);
    expect(visible.map(row => row.id)).not.toContain('old-high-likes');
    expect(await listUserFavoritesWithCards(db, 8, undefined, { limit: 8, offset: 0 })).toEqual([]);
  });

  test('旧全文公开列表按 id 稳定分页，保留原始列的 NULL 排序', async () => {
    exec(`
      DELETE FROM data_cards;
      INSERT INTO data_cards (id,user_id,type,name,data,is_public,review_status,created_at,updated_at,like_count,usage_count,favorite_count)
      VALUES
        ('a',1,'character','a','{}',1,'approved','2026-01-01','2026-01-01',0,0,0),
        ('b',1,'character','b','{}',1,'approved','2026-01-01','2026-01-01',0,0,0),
        ('c',1,'character','c','{}',1,'approved',NULL,'2026-02-01',0,0,0),
        ('d',1,'character','d','{}',1,'approved',NULL,'2026-02-01',0,0,0),
        ('e',1,'character','e','{}',1,'approved','2026-01-01','2026-01-01',NULL,NULL,NULL),
        ('f',1,'character','f','{}',1,'approved','2026-01-01','2026-01-01',NULL,NULL,NULL);
    `);
    for (const sortBy of [undefined, 'created_at', 'likes', 'usage', 'favorites'] as const) {
      const pages = await Promise.all([0, 2, 4].map((offset) => listPublicDataCardsWithFilters(db, { sortBy, limit: 2, offset })));
      const ids = pages.flat().map((row) => row.id);
      expect(ids).toEqual(!sortBy || sortBy === 'created_at'
        ? ['f', 'e', 'b', 'a', 'd', 'c'] : ['b', 'a', 'd', 'c', 'f', 'e']);
      expect(new Set(ids).size).toBe(6);
    }
  });

  test('管理员推荐列表应保留用户选择的排序方式', async () => {
    const cases: Array<{
      sortBy: 'likes' | 'usage' | 'favorites' | 'created_at';
      expectedFirstId: string;
    }> = [
      { sortBy: 'created_at', expectedFirstId: 'middle-high-favorites' },
      { sortBy: 'likes', expectedFirstId: 'old-high-likes' },
      { sortBy: 'usage', expectedFirstId: 'new-low-likes' },
      { sortBy: 'favorites', expectedFirstId: 'middle-high-favorites' },
    ];

    for (const item of cases) {
      const rows = await listPublicDataCardsWithFilters(db, {
        limit: 10,
        offset: 0,
        type: 'character',
        recommendedOnly: true,
        sortBy: item.sortBy,
      });

      expect(rows.map((row) => row.id)).not.toContain('not-recommended');
      expect(rows[0]?.id).toBe(item.expectedFirstId);
    }
  });
});
