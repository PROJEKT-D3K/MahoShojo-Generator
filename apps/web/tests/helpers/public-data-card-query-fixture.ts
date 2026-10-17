import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import * as schema from '@/lib/db/schema';

export const publicSummaryIndexMigration = readFileSync(fileURLToPath(
  new URL('../../../../drizzle/0021_public_data_card_summary_indexes.sql', import.meta.url),
), 'utf8');
export const publicSummaryIndexNames = [
  'idx_data_cards_public_summary_created', 'idx_data_cards_public_summary_likes',
  'idx_data_cards_public_summary_type_created', 'idx_data_cards_public_summary_type_likes',
];
export type CapturedQuery = { sql: string; params: unknown[] };

export function createPublicCardQueryFixture(publicCount = 2048) {
  const sqlite = new Database(':memory:');
  // Exercise legacy orphan-row visibility without weakening production foreign keys.
  sqlite.pragma('foreign_keys = OFF');
  const queries: CapturedQuery[] = [];
  const db = drizzle(sqlite, { schema, logger: { logQuery(sql, params) { queries.push({ sql, params }); } } }) as unknown as AppDrizzleDb;
  const source = readFileSync(fileURLToPath(new URL('../../lib/database/schema.sql', import.meta.url)), 'utf8');
  // Reuse the real table and pre-migration indexes, including the old type-first index.
  sqlite.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT);
    ${source.match(/CREATE TABLE IF NOT EXISTS data_cards \([\s\S]*?\n\);/)![0]}
    CREATE TABLE data_card_tags (data_card_id TEXT, tag_id TEXT, PRIMARY KEY (data_card_id, tag_id));
    CREATE TABLE data_card_metrics (data_card_id TEXT PRIMARY KEY, is_native INTEGER);
    CREATE TABLE favorites (user_id INTEGER, data_card_id TEXT, created_at TEXT, PRIMARY KEY (user_id, data_card_id));
    CREATE TABLE data_card_updates (data_card_id TEXT PRIMARY KEY, data TEXT, name TEXT, description TEXT, updated_at TEXT);
  `);
  for (const [statement] of source.matchAll(/CREATE (?:UNIQUE )?INDEX[\s\S]*?;/g)) {
    if (/\bON data_cards\(/.test(statement) && !publicSummaryIndexNames.some((name) => statement.includes(name))) sqlite.exec(statement);
  }
  const user = sqlite.prepare('INSERT INTO users VALUES (?, ?, ?)');
  for (let i = 1; i <= 10; i++) user.run(i, `author-${i}`, `user${i}@example.test`);
  const insert = sqlite.prepare(`INSERT INTO data_cards
    (id,user_id,type,name,description,data,is_public,review_status,deleted_at,created_at,updated_at,public_since,like_count,usage_count,favorite_count,is_recommended)
    VALUES (@id,@user,@type,@name,'synthetic description',@data,@visibility,@review,@deleted,@created,@updated,@created,@likes,@usage,@favorites,@recommended)`);
  sqlite.transaction(() => {
    for (let i = 0; i < publicCount + 512; i++) {
      const eligible = i < publicCount;
      const day = `2026-01-${String(1 + i % 28).padStart(2, '0')}`;
      const type = i % 100 < 80 ? 'character' : i % 100 < 95 ? 'scenario' : i % 100 < 99 ? 'history' : 'questionnaire';
      insert.run({
        id: `synthetic-${String(i).padStart(6, '0')}`, user: 1 + i % 10, type, name: `synthetic ${i}`,
        data: i % 31 === 0 ? 'invalid historical JSON' : JSON.stringify({ content: 'x'.repeat(4096), nativeAllowed: i % 5 === 0 }),
        visibility: eligible ? 1 : [0, -1, 1, 1][i % 4], review: eligible || i % 4 !== 2 ? 'approved' : 'pending',
        deleted: !eligible && i % 4 === 3 ? day : null,
        created: i % 17 === 0 ? null : day, updated: i % 19 === 0 ? null : day,
        likes: i % 13 === 0 ? null : i % 53, usage: i % 47, favorites: i % 11, recommended: i % 7 === 0 ? 1 : 0,
      });
    }
    sqlite.exec(`INSERT INTO data_card_tags SELECT id, 'tag-a' FROM data_cards WHERE rowid % 3 = 0;
      INSERT INTO data_card_tags SELECT id, 'tag-b' FROM data_cards WHERE rowid % 7 = 0;
      INSERT INTO data_card_metrics SELECT id, rowid % 2 FROM data_cards;`);
  })();
  return { sqlite, db, queries, source };
}

export function queryPlan(sqlite: Database, query: CapturedQuery) {
  return sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ id: number; parent: number; detail: string }>;
}
