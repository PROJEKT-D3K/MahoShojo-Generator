import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { OwnedRecycleBinQuerySchema } from '@mahoshojo/contracts/data-cards';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import { listOwnedRecycleBin, readOwnedRecycleBinCard } from '@/lib/db/repositories/data-card-owned-recycle';
import * as schema from '@/lib/db/schema';

let sqlite: InstanceType<typeof Database>;
let db: AppDrizzleDb;
let statements: string[];
const original = JSON.stringify({ original: '正文'.repeat(160_000), custom: { untouched: ['legacy', 1] } }, null, 2);
const query = (overrides: Record<string, unknown> = {}) => OwnedRecycleBinQuerySchema.parse({ expectedUserId: 7, ...overrides });

beforeEach(() => {
  statements = [];
  sqlite = new Database(':memory:', { verbose: (sql) => statements.push(String(sql)) });
  db = drizzle(sqlite, { schema }) as unknown as AppDrizzleDb;
  sqlite.exec(`CREATE TABLE data_cards (
    id TEXT PRIMARY KEY,user_id INTEGER,type TEXT,name TEXT,description TEXT,data TEXT,
    is_public INTEGER,review_status TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,
    usage_count INTEGER,like_count INTEGER);
    CREATE TABLE data_card_updates (data_card_id TEXT, data TEXT);`);
  const insert = sqlite.prepare(`INSERT INTO data_cards VALUES (?,?,?,'原名','原简介',?,?,'pending',NULL,'updated',?,NULL,3)`);
  for (let i = 0; i < 29; i++) {
    insert.run(`c-${String(i).padStart(2, '0')}`, 7, i % 2 ? 'scenario' : 'character', original, i % 3 - 1, '2026-10-15');
  }
  insert.run('newest', 7, 'history', original, 0, '2026-10-16');
  insert.run('active', 7, 'character', original, 0, null);
  insert.run('foreign', 8, 'questionnaire', 'foreign body', 1, '2026-10-17');
  sqlite.exec(`INSERT INTO data_card_updates VALUES ('c-28','pending must never replace the original')`);
  statements = [];
});
afterEach(() => sqlite.close());

describe('owned recycle-bin real SQLite read boundary', () => {
  test('large originals stay in storage while all tombstones page deterministically beyond the old five-card cap', async () => {
    const first = await listOwnedRecycleBin(db, 7, query());
    const second = await listOwnedRecycleBin(db, 7, query({ offset: first.nextOffset }));
    const third = await listOwnedRecycleBin(db, 7, query({ offset: second.nextOffset }));
    expect(first).toMatchObject({ total: 30, filteredCount: 30, nextOffset: 12 });
    expect(second.nextOffset).toBe(24); expect(third.nextOffset).toBeNull();
    expect(first.cards).toHaveLength(12); expect(second.cards).toHaveLength(12); expect(third.cards).toHaveLength(6);
    expect(first.cards.map((card) => card.id)).toEqual(['newest', ...Array.from({ length: 11 }, (_, i) => `c-${28 - i}`)]);
    expect(new Set([...first.cards, ...second.cards, ...third.cards].map((card) => card.id)).size).toBe(30);
    for (const page of [first, second, third]) {
      expect(JSON.stringify(page).length).toBeLessThan(10_000);
      for (const card of page.cards) {
        expect(card).not.toHaveProperty('data'); expect(card).not.toHaveProperty('pending_data');
        expect(card).not.toHaveProperty('user_id'); expect(card.usage_count).toBe(0);
      }
    }
    expect(statements).toHaveLength(6);
    for (const statement of statements) {
      expect(statement).toMatch(/^\s*SELECT/i);
      expect(statement).not.toMatch(/\bdata_card_updates\b|SELECT\s+\*/i);
      expect(sqlite.prepare(statement).columns().map((column) => column.name)).not.toContain('data');
    }
  });

  test('total spans all own deleted types; filteredCount and nextOffset use the filtered collection', async () => {
    const first = await listOwnedRecycleBin(db, 7, query({ type: 'scenario', limit: 12 }));
    const last = await listOwnedRecycleBin(db, 7, query({ type: 'scenario', offset: 12 }));
    expect(first).toMatchObject({ total: 30, filteredCount: 14, nextOffset: 12 });
    expect(first.cards.every((card) => card.type === 'scenario')).toBe(true);
    expect(last).toMatchObject({ total: 30, filteredCount: 14, nextOffset: null });
    expect(last.cards).toHaveLength(2);
    expect(await listOwnedRecycleBin(db, 7, query({ type: 'questionnaire' }))).toEqual({ cards: [], total: 30, filteredCount: 0, nextOffset: null });
    expect(await listOwnedRecycleBin(db, 9, query())).toEqual({ cards: [], total: 0, filteredCount: 0, nextOffset: null });
  });

  test('empty and out-of-range pages terminate without deleting or pruning anything', async () => {
    expect(await listOwnedRecycleBin(db, 7, query({ offset: 30 }))).toEqual({ cards: [], total: 30, filteredCount: 30, nextOffset: null });
    expect(await listOwnedRecycleBin(db, 7, query({ offset: Number.MAX_SAFE_INTEGER - 24 }))).toEqual({ cards: [], total: 30, filteredCount: 30, nextOffset: null });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM data_cards').get()).toEqual({ count: 32 });
  });

  test('detail preserves original bytes and metadata, ignores pending content, and requires owner plus tombstone', async () => {
    const card = await readOwnedRecycleBinCard(db, 7, 'c-28');
    expect(card).toMatchObject({ id: 'c-28', data: original, name: '原名', description: '原简介', deleted_at: '2026-10-15', review_status: 'pending', is_public: 0 });
    expect(card).not.toHaveProperty('pending_data');
    expect(await readOwnedRecycleBinCard(db, 7, 'active')).toBeNull();
    expect(await readOwnedRecycleBinCard(db, 7, 'foreign')).toBeNull();
    expect(await readOwnedRecycleBinCard(db, 7, 'missing')).toBeNull();
    expect(await readOwnedRecycleBinCard(db, 8, 'c-28')).toBeNull();
    expect((await readOwnedRecycleBinCard(db, 8, 'foreign'))?.data).toBe('foreign body');
  });

  test('unparseable legacy content remains readable byte-for-byte and cannot break summaries', async () => {
    const raw = '  legacy non-JSON {\n original trailing bytes  ';
    sqlite.prepare('UPDATE data_cards SET data=? WHERE id=?').run(raw, 'c-28');
    expect((await listOwnedRecycleBin(db, 7, query())).cards).toHaveLength(12);
    expect((await readOwnedRecycleBinCard(db, 7, 'c-28'))?.data).toBe(raw);
  });

  test('questionnaire filtering reuses legacy detection without changing stored type or original bytes', async () => {
    const legacy = JSON.stringify({ kind: 'magical-girl', title: '旧问卷', questions: [{ id: 'q1' }] });
    sqlite.prepare('UPDATE data_cards SET data=? WHERE id=?').run(legacy, 'c-28');
    const page = await listOwnedRecycleBin(db, 7, query({ type: 'questionnaire' }));
    expect(page).toMatchObject({ total: 30, filteredCount: 1, nextOffset: null });
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]).toMatchObject({ id: 'c-28', type: 'character', isLegacyQuestionnaire: true });
    expect(page.cards[0]).not.toHaveProperty('data');
    expect(await readOwnedRecycleBinCard(db, 7, 'c-28')).toMatchObject({ type: 'character', isLegacyQuestionnaire: true, data: legacy });
    expect((await listOwnedRecycleBin(db, 7, query({ type: 'character' }))).filteredCount).toBe(15);
    expect((await listOwnedRecycleBin(db, 8, query({ type: 'questionnaire' }))).cards[0]).toMatchObject({ type: 'questionnaire', isLegacyQuestionnaire: false });
  });

  test('storage errors and missing aggregates reject instead of manufacturing empty success', async () => {
    sqlite.exec('DROP TABLE data_cards');
    await expect(listOwnedRecycleBin(db, 7, query())).rejects.toThrow();
    await expect(readOwnedRecycleBinCard(db, 7, 'c-28')).rejects.toThrow();
    const missing = { all: vi.fn().mockResolvedValue([]) } as unknown as AppDrizzleDb;
    await expect(listOwnedRecycleBin(missing, 7, query())).rejects.toThrow('Missing recycle-bin counts');
  });

  test('actual D1 adapter sends bounded parameterized SELECTs, including quote-like identifiers', async () => {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const d1 = drizzleD1({ prepare: (text: string) => ({ bind: (...params: unknown[]) => ({
      all: async () => { queries.push({ text, params }); return { success: true, results: sqlite.prepare(text).all(...params) }; },
    }) }) } as never, { schema });
    const page = await listOwnedRecycleBin(d1, 7, query({ type: 'character', limit: 2, offset: 1 }));
    expect(page).toMatchObject({ total: 30, filteredCount: 15, nextOffset: 3 });
    expect(page.cards.map((card) => card.id)).toEqual(['c-26', 'c-24']);
    expect(queries).toHaveLength(2);
    expect(queries.every(({ text, params }) => /^\s*SELECT/i.test(text) && params.length < 32 && !sqlite.prepare(text).columns().some((column) => column.name === 'data'))).toBe(true);
    expect(await readOwnedRecycleBinCard(d1, 7, "' OR 1=1 --")).toBeNull();
    expect(queries.at(-1)?.params).toContain("' OR 1=1 --");
  });
});
