import { afterEach, beforeEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DataCardSummaryQuerySchema } from '@mahoshojo/contracts/data-cards';
import { listDataCardSummaries } from '@/lib/db/repositories/data-card-summaries';
import * as schema from '@/lib/db/schema';
import type { AppDrizzleDb } from '@/lib/db/drizzle';

let sqlite: Database;
let db: AppDrizzleDb;

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT);
    INSERT INTO users VALUES (1, 'alice', 'a@test');
    CREATE TABLE data_cards (id TEXT PRIMARY KEY, user_id INTEGER, type TEXT, name TEXT, description TEXT,
      data TEXT, is_public INTEGER DEFAULT 0, public_since TEXT, usage_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0, favorite_count INTEGER DEFAULT 0, review_status TEXT DEFAULT 'approved',
      is_recommended INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE data_card_updates (data_card_id TEXT PRIMARY KEY, data TEXT, name TEXT, description TEXT, updated_at TEXT);
    CREATE TABLE data_card_tags (data_card_id TEXT, tag_id TEXT, PRIMARY KEY (data_card_id, tag_id));
    CREATE TABLE data_card_metrics (data_card_id TEXT PRIMARY KEY, is_native INTEGER);
    CREATE TABLE favorites (user_id INTEGER, data_card_id TEXT, created_at TEXT, PRIMARY KEY(user_id, data_card_id));
  `);
  const insert = sqlite.prepare(`INSERT INTO data_cards
    (id,user_id,type,name,description,data,is_public,review_status,created_at,updated_at)
    VALUES (?,?,'character',?,'简介','{}',1,'approved',?,?)`);
  insert.run('null-created', 1, '空创建时间', null, '2026-10-05');
  insert.run('updated-first', 1, '较新更新', '2026-10-04', '2026-10-06');
  insert.run('updated-null', 1, '空更新时间', '2026-10-04', null);
  insert.run('tie-a', 1, '同时间 A', '2026-10-03', '2026-10-03');
  insert.run('tie-z', 1, '同时间 Z', '2026-10-03', '2026-10-03');
  // Orphan card rows are excluded by the existing users inner join.
  insert.run('orphan-newest', 999, '无用户', '9999-01-01', '9999-01-01');
});

afterEach(() => sqlite.close());

test('公开库先分页再投影，保留 COALESCE 排序、并列稳定顺序与用户可见性', async () => {
  const query = DataCardSummaryQuerySchema.parse({ sortBy: 'created_at', limit: 2 });
  const first = await listDataCardSummaries(db, null, 'public', query);
  const second = await listDataCardSummaries(db, null, 'public', { ...query, offset: 2 });
  const third = await listDataCardSummaries(db, null, 'public', { ...query, offset: 4 });

  expect(first.total).toBe(5);
  expect(first.stats).toEqual({ private: 0, public: 5, pending: 0 });
  expect([...first.cards, ...second.cards, ...third.cards].map((card) => card.id)).toEqual([
    'null-created', 'updated-first', 'updated-null', 'tie-z', 'tie-a',
  ]);
  expect([...first.cards, ...second.cards, ...third.cards].every((card) => !('data' in card))).toBe(true);
});

test('公开库 nativeOnly 在计数和分页前生效', async () => {
  sqlite.exec(`INSERT INTO data_card_metrics VALUES ('null-created',1),('tie-a',1),('tie-z',0)`);
  const query = DataCardSummaryQuerySchema.parse({ sortBy: 'created_at', nativeOnly: true, limit: 1 });
  const first = await listDataCardSummaries(db, null, 'public', query);
  const second = await listDataCardSummaries(db, null, 'public', { ...query, offset: 1 });

  expect(first.total).toBe(2);
  expect(first.cards.map((card) => card.id)).toEqual(['null-created']);
  expect(second.cards.map((card) => card.id)).toEqual(['tie-a']);
  expect(first.nextOffset).toBe(1);
  expect(second.nextOffset).toBeNull();
});

test('公开库文本、类型、标签、推荐、原生许可与数值筛选先于分页生效', async () => {
  sqlite.exec(`
    UPDATE data_cards SET data='{"nativeAllowed":true}', favorite_count=3 WHERE id='null-created';
    UPDATE data_cards SET type='questionnaire', is_recommended=1, like_count=8 WHERE id='tie-z';
    INSERT INTO data_card_tags VALUES ('tie-z','tag-a'),('tie-z','tag-b'),('tie-a','tag-a');
  `);
  const run = (input: Record<string, unknown>) => listDataCardSummaries(
    db, null, 'public', DataCardSummaryQuerySchema.parse({ limit: 1, ...input }),
  );

  const text = await run({ search: '较新更新' });
  expect(text.total).toBe(1);
  expect(text.cards[0].id).toBe('updated-first');

  const characters = await run({ types: ['character'] });
  expect(characters.total).toBe(4);
  expect(characters.cards).toHaveLength(1);

  const tagged = await run({ tagIds: ['tag-a', 'tag-b'], tagMatch: 'all' });
  expect(tagged.total).toBe(1);
  expect(tagged.cards[0].id).toBe('tie-z');

  const recommended = await run({ recommendedOnly: true });
  expect(recommended.total).toBe(1);
  expect(recommended.cards[0].id).toBe('tie-z');

  const nativeAllowed = await run({ nativeAllowedOnly: true });
  expect(nativeAllowed.total).toBe(1);
  expect(nativeAllowed.cards[0].id).toBe('null-created');

  const counts = await run({ minLikes: 8, maxFavorites: 0 });
  expect(counts.total).toBe(1);
  expect(counts.cards[0].id).toBe('tie-z');
});
