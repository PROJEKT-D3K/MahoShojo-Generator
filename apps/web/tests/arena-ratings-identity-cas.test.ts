import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/repositories/data-card-meta', () => ({ queryArenaPublicQueenEntityByQueue: async () => null }));
import { applyArenaRatingsUpdateIfBothMatch, markArenaRatingEventStatus, markArenaRatingEventApplied } from '@/lib/db/repositories/arena-ratings-write';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (_path: string) => {
    exec(_sql: string): void; close(): void;
    prepare(_sql: string): { run(..._params: unknown[]): unknown; all(..._params: unknown[]): Record<string, unknown>[] };
  };
};
const initial = { rating: 1000, games: 0, wins: 0, losses: 0, draws: 0 };
const computed = { aBefore: initial, bBefore: initial,
  aAfter: { ...initial, rating: 1020, games: 1, wins: 1 },
  bAfter: { ...initial, rating: 980, games: 1, losses: 1 },
  deltaA: 20, deltaB: -20, detailsJson: {} };
const entities = [{ entityType: 'data_card' as const, entityId: 'a' }, { entityType: 'data_card' as const, entityId: 'b' }] as const;

describe('rating source guards execute atomically in SQLite', () => {
  it.each(['none', 'body-same-timestamp', 'version', 'private', 'unapproved', 'deleted', 'reconcile-before', 'reconcile-after', 'free-owner', 'free-owner-changed', 'skip-first', 'apply-first', 'skipped-after', 'applied-conflict', 'skipped-conflict', 'computed-mismatch-after'] as const)('both or neither rating updates: %s', async (change) => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`
CREATE TABLE data_cards(id TEXT PRIMARY KEY, type TEXT, data TEXT, updated_at TEXT, user_id INTEGER, is_public INTEGER, review_status TEXT, deleted_at TEXT);
CREATE TABLE arena_rating_events(id TEXT PRIMARY KEY, queue TEXT, status TEXT, skip_reason TEXT, applied_at TEXT,
 a_entity_type TEXT, a_entity_id TEXT, b_entity_type TEXT, b_entity_id TEXT,
 a_before_rating INTEGER, a_before_games INTEGER, a_after_rating INTEGER, a_after_games INTEGER,
 b_before_rating INTEGER, b_before_games INTEGER, b_after_rating INTEGER, b_after_games INTEGER, a_delta INTEGER, b_delta INTEGER);
INSERT INTO arena_rating_events VALUES('event','strict','pending',NULL,NULL,'data_card','a','data_card','b',1000,0,1020,1,1000,0,980,1,20,-20);
CREATE TABLE arena_ratings(entity_type TEXT, entity_id TEXT, queue TEXT, rating INTEGER, games INTEGER,
 wins INTEGER, losses INTEGER, draws INTEGER, season_peak_rating INTEGER, season_peak_games INTEGER,
 season_peak_at TEXT, season_peak_tier TEXT, season_low_rating INTEGER, season_low_games INTEGER, season_low_at TEXT,
 last_delta INTEGER, last_applied_at TEXT, updated_at TEXT);
INSERT INTO data_cards VALUES('a','character','{"name":"A"}','v1',42,1,'approved',NULL),('b','character','{"name":"B"}','v1',42,1,'approved',NULL);
INSERT INTO arena_ratings(entity_type,entity_id,queue,rating,games,wins,losses,draws) VALUES('data_card','a','strict',1000,0,0,0,0),('data_card','b','strict',1000,0,0,0,0);
      `);
      const queue = change.startsWith('free-owner') ? 'free' : 'strict';
      if (queue === 'free') sqlite.exec("UPDATE arena_ratings SET queue='free'; UPDATE arena_rating_events SET queue='free'; UPDATE data_cards SET is_public=0");
      if (change.endsWith('-conflict')) {
        sqlite.exec(`UPDATE arena_rating_events SET status='${change === 'applied-conflict' ? 'applied' : 'skipped'}'; UPDATE arena_ratings SET rating=1500, games=5`);
      }
      if (change === 'computed-mismatch-after') sqlite.exec("UPDATE arena_rating_events SET a_delta=999");
      if (change === 'skipped-after') sqlite.exec("UPDATE arena_rating_events SET status='skipped'");
      if (change === 'reconcile-after' || change === 'skipped-after' || change === 'computed-mismatch-after') sqlite.exec("UPDATE arena_ratings SET rating=CASE entity_id WHEN 'a' THEN 1020 ELSE 980 END, games=1, wins=CASE entity_id WHEN 'a' THEN 1 ELSE 0 END, losses=CASE entity_id WHEN 'b' THEN 1 ELSE 0 END");
      const guards = sqlite.prepare('SELECT id, data, updated_at AS updatedAt FROM data_cards ORDER BY id').all()
        .map((row) => ({ id: row.id as string, data: row.data as string, updatedAt: row.updatedAt as string, authorizedUserId: 42 }));
      let beforeUpdate = true;
      const updates: string[] = [];
      const db = drizzle(async (sql, params, method) => {
        if (sql.startsWith('update "arena_ratings"') && sql.includes('returning')) {
          updates.push(sql);
          if (beforeUpdate) {
            beforeUpdate = false;
            const edits: Record<string, string> = {
              'body-same-timestamp': "data = '{\"name\":\"replacement\"}'", version: "updated_at = 'v2'",
              private: 'is_public = 0', 'free-owner-changed': 'user_id = 99', unapproved: "review_status = 'pending'", deleted: "deleted_at = 'now'",
            };
            if (edits[change]) sqlite.exec(`UPDATE data_cards SET ${edits[change]} WHERE id='b'`);
          }
        }
        const statement = sqlite.prepare(sql);
        if (method === 'run') { statement.run(...params); return { rows: [] }; }
        return { rows: statement.all(...params).map((row) => Object.values(row)) };
      });
      const typedDb = db as unknown as Parameters<typeof applyArenaRatingsUpdateIfBothMatch>[0];
      if (change === 'skip-first') {
        expect(await markArenaRatingEventStatus(typedDb, 'event', 'skipped', { skipReason: 'entity-reference-unavailable' })).toBe(true);
      }
      if (change === 'computed-mismatch-after') {
        await expect(applyArenaRatingsUpdateIfBothMatch(typedDb, queue, [...entities], computed, 'now', null, 'event'))
          .rejects.toThrow('ARENA_RATING_EVENT_SETTLEMENT_RETRY');
        expect(updates).toHaveLength(0);
        expect(sqlite.prepare("SELECT status FROM arena_rating_events WHERE id='event'").all()[0]?.status).toBe('pending');
        return;
      }
      const result = await applyArenaRatingsUpdateIfBothMatch(
        db as unknown as Parameters<typeof applyArenaRatingsUpdateIfBothMatch>[0], queue, [...entities], computed, 'now', change.startsWith('reconcile-') ? null : guards, 'event',
      );
      expect(result).toBe(change === 'skip-first' || change === 'skipped-after' || change === 'skipped-conflict' ? 'event-skipped' : change === 'none' || change === 'free-owner' || change === 'apply-first' ? 'applied' : change === 'reconcile-after' || change === 'applied-conflict' ? 'already-applied' : 'identity-conflict');
      expect(updates).toHaveLength(change === 'reconcile-after' || change === 'skipped-after' || change.endsWith('-conflict') ? 0 : 1);
      if (updates.length && !change.startsWith('reconcile-')) expect((updates[0].match(/EXISTS/g) ?? []).length).toBe(3);
      const rows = sqlite.prepare('SELECT rating,games,wins,losses,draws FROM arena_ratings ORDER BY entity_id').all();
      expect(rows.map((row) => [row.rating, row.games, row.wins, row.losses, row.draws])).toEqual(change.endsWith('-conflict') ? [[1500, 5, 0, 0, 0], [1500, 5, 0, 0, 0]] : change === 'none' || change === 'free-owner' || change === 'reconcile-after' || change === 'apply-first' || change === 'skipped-after' ? [[1020, 1, 1, 0, 0], [980, 1, 0, 1, 0]] : [[1000, 0, 0, 0, 0], [1000, 0, 0, 0, 0]]);
      if (change.endsWith('-conflict')) {
        expect(await markArenaRatingEventStatus(typedDb, 'event', 'failed', { skipReason: 'rating-conflict' })).toBe(false);
        expect(sqlite.prepare("SELECT status FROM arena_rating_events WHERE id='event'").all()[0]?.status)
          .toBe(change === 'applied-conflict' ? 'applied' : 'skipped');
      }
      if (change === 'apply-first') {
        expect(await markArenaRatingEventStatus(typedDb, 'event', 'skipped', { skipReason: 'entity-reference-unavailable' })).toBe(false);
        expect(sqlite.prepare("SELECT status FROM arena_rating_events WHERE id='event'").all()[0]?.status).toBe('pending');
        expect(await applyArenaRatingsUpdateIfBothMatch(typedDb, queue, [...entities], computed, 'retry', null, 'event')).toBe('already-applied');
        await markArenaRatingEventApplied(typedDb, 'event', 'retry');
        expect(sqlite.prepare("SELECT status FROM arena_rating_events WHERE id='event'").all()[0]?.status).toBe('applied');
        expect(await markArenaRatingEventStatus(typedDb, 'event', 'skipped', { skipReason: 'entity-version-changed' })).toBe(false);
      }
      if (change === 'skip-first' || change === 'skipped-after') {
        expect(sqlite.prepare("SELECT status FROM arena_rating_events WHERE id='event'").all()[0]?.status).toBe('skipped');
      }
    } finally { sqlite.close(); }
  });
});
