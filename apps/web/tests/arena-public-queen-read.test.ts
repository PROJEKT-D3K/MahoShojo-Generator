import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it } from 'vitest';
import { queryArenaPublicQueenEntityByQueue } from '@/lib/db/repositories/data-card-meta';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void; prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] } };
};
describe('完整段位复用的全局只读女王查询', () => {
  it.each(['strict', 'free'] as const)('只读查询 %s，少于三名权杖无女王且不混队列', async queue => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE data_cards (id TEXT, type TEXT, is_public INTEGER, review_status TEXT, deleted_at TEXT, created_at TEXT, public_since TEXT);
        CREATE TABLE arena_ratings (entity_type TEXT, entity_id TEXT, queue TEXT, rating INTEGER, games INTEGER, updated_at TEXT);
        INSERT INTO arena_ratings VALUES ('preset','first','${queue}',1700,5,'2026-01-01'), ('preset','second','${queue}',1600,5,'2026-01-01');`);
      const statements: string[] = [];
      const db = drizzle(async (sql, params) => { statements.push(sql); return { rows: sqlite.prepare(sql).all(...params).map(Object.values) }; });
      const read = () => queryArenaPublicQueenEntityByQueue(db as unknown as Parameters<typeof queryArenaPublicQueenEntityByQueue>[0], queue, { bypassCache: true });
      expect(await read()).toBeNull();
      sqlite.exec(`INSERT INTO arena_ratings VALUES ('preset','third','${queue === 'strict' ? 'free' : 'strict'}',1500,5,'2026-01-01');`);
      expect(await read()).toBeNull();
      sqlite.exec(`INSERT INTO arena_ratings VALUES ('preset','third','${queue}',1500,5,'2026-01-01');`);
      expect(await read()).toEqual({ entityType: 'preset', entityId: 'first' });
      sqlite.exec(`INSERT INTO data_cards VALUES ('private', 'character', 0, 'approved', NULL, '2026-01-01', '2026-01-01');
        INSERT INTO arena_ratings VALUES ('data_card','private','${queue}',9999,5,'2026-01-01');`);
      expect(await read()).toEqual({ entityType: 'preset', entityId: 'first' });
      sqlite.exec("UPDATE data_cards SET is_public=1, review_status='pending'");
      expect(await read()).toEqual({ entityType: 'preset', entityId: 'first' });
      sqlite.exec("UPDATE data_cards SET review_status='approved', deleted_at='deleted'");
      expect(await read()).toEqual({ entityType: 'preset', entityId: 'first' });
      sqlite.exec("UPDATE data_cards SET deleted_at=NULL");
      expect(await read()).toEqual({ entityType: 'data_card', entityId: 'private' });
      sqlite.exec("UPDATE arena_ratings SET games=4 WHERE entity_id='private'");
      expect(await read()).toEqual({ entityType: 'preset', entityId: 'first' });
      expect(statements.every(sql => sql.toLowerCase().startsWith('select '))).toBe(true);
    } finally { sqlite.close(); }
  });
});
