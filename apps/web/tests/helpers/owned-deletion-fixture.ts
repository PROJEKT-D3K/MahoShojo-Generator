import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/lib/db/schema';
import { readFileSync } from 'node:fs';
export const deletionFixture = `
PRAGMA foreign_keys = ON;
CREATE TABLE data_cards (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT, data TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0, public_since TEXT,
  review_status TEXT, is_recommended INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT,
  usage_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0, favorite_count INTEGER DEFAULT 0
);
CREATE TABLE data_card_updates (
  id TEXT PRIMARY KEY, data_card_id TEXT UNIQUE NOT NULL REFERENCES data_cards(id) ON DELETE CASCADE,
  user_id INTEGER, name TEXT, description TEXT, data TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE related (id TEXT PRIMARY KEY, card_id TEXT REFERENCES data_cards(id) ON DELETE CASCADE);
INSERT INTO data_cards (id,user_id,type,name,data,review_status,updated_at,deleted_at)
VALUES ('a',7,'character','活动卡','{"source":1}','pending','same-second',NULL),
       ('r1',7,'scenario','墓碑一','{"source":1}','pending','same-second','same-second'),
       ('r2',7,'questionnaire','墓碑二','{"source":1}','approved','same-second','same-second'),
       ('foreign',8,'history','其他账号','{}','approved','same-second','same-second');
`;
export const recycleMigration = readFileSync(new URL('../../../../drizzle/0019_data_card_recycle_generation.sql', import.meta.url), 'utf8');

export function createDeletionFixtureDb(connection: InstanceType<typeof Database>, transform?: (sql: string, receipt: { success: true; results: unknown[]; meta: { changes: number } }) => unknown) {
  return drizzle({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({
    raw: async () => connection.prepare(text).all(...params).map(row => Object.values(row as Record<string, unknown>)),
    all: async () => {
      const results = connection.prepare(text).all(...params);
      const { n } = connection.prepare('SELECT changes() AS n').get() as { n: number };
      const receipt = { success: true as const, results, meta: { changes: n } };
      return transform ? transform(text, receipt) : receipt;
    },
  }) }) } as never, { schema });
}
