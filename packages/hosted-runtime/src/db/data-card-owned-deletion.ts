import { sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  OWNED_DELETE_TARGET_LIMIT,
  type OnlineDataCardType,
  type OwnedDataCardDeletionTarget,
} from '@mahoshojo/contracts/data-cards';
import type { AppDrizzleDb } from './drizzle';
import { D1PreparedStatement, validateD1ReturningResult } from '../d1-http-client';

export type DeletionScope = 'active' | 'recycle';
export interface OwnedDeletionSnapshot {
  id: string; user_id: number; type: OnlineDataCardType; name: string; description: string | null;
  deleted_at: string | null; metadata: string; data: string;
  pending_metadata: string; pending_data: string | null; pending_user_id: number | null;
}
// Fixed column order, encoded by SQLite itself: no cross-runtime JSON serialization assumptions.
// Engagement counters are deliberately absent; content, moderation and generation are not.
const metadata = sql`json_array(c.id, c.user_id, c.type, c.name, c.description,
  CAST(c.is_public AS INTEGER), c.public_since, c.review_status, c.is_recommended,
  c.created_at, c.updated_at, c.deleted_at, c.recycle_generation)`;
const pendingMetadata = sql`json_array(p.id, p.data_card_id, p.user_id, p.name, p.description, p.created_at, p.updated_at)`;
const scopeCondition = (scope: DeletionScope) => scope === 'active' ? sql`c.deleted_at IS NULL` : sql`c.deleted_at IS NOT NULL`;
const maxBindingBytes = 2_000_000;
const dialect = new SQLiteSyncDialect();

export function assertOwnedSnapshotQueryBounded(query: SQL): void {
  const compiled = dialect.sqlToQuery(query);
  if (compiled.params.length > 100) throw new RangeError('Deletion query exceeds D1 parameter limit');
  for (const value of compiled.params) {
    if (typeof value === 'string' && new TextEncoder().encode(value).byteLength > maxBindingBytes) {
      throw new RangeError('Deletion snapshot exceeds D1 binding limit');
    }
  }
}
const all = async <T>(db: AppDrizzleDb, query: SQL): Promise<T[]> => {
  assertOwnedSnapshotQueryBounded(query);
  return db.all<T>(query);
};

type ReturningStatement = { bind(..._params: unknown[]): ReturningStatement; all(): Promise<unknown> };
/** Drizzle's documented public $client preserves the statement receipt that db.all() discards. */
async function returningIds(db: AppDrizzleDb, query: SQL): Promise<string[]> {
  assertOwnedSnapshotQueryBounded(query);
  const client = (db as AppDrizzleDb & { $client?: { prepare(_text: string): ReturningStatement } }).$client;
  if (!client || typeof client.prepare !== 'function') throw new Error('Strict D1 returning client unavailable');
  const compiled = dialect.sqlToQuery(query);
  const statement = client.prepare(compiled.sql).bind(...compiled.params);
  const receipt = validateD1ReturningResult(statement instanceof D1PreparedStatement
    ? await statement.allStrict() : await statement.all());
  if (receipt.results.some((row) => Object.keys(row).length !== 1 || typeof row.id !== 'string' || !row.id)) {
    throw new Error('Invalid deletion RETURNING identity');
  }
  return receipt.results.map((row) => row.id as string);
}

/** A half-applied schema must not offer confirmations that old writers can invalidate invisibly. */
export async function assertOwnedDeletionSchema(db: AppDrizzleDb): Promise<void> {
  const rows = await all<{ name: string }>(db, sql`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name = 'data_cards_recycle_generation'`);
  if (rows.length !== 1) throw new Error('Confirmed deletion migration is unavailable');
  await all(db, sql`SELECT recycle_generation FROM data_cards LIMIT 0`);
}

export async function readOwnedDeletionSnapshot(db: AppDrizzleDb, userId: number, id: string, scope: DeletionScope): Promise<OwnedDeletionSnapshot | null> {
  const rows = await all<OwnedDeletionSnapshot>(db, sql`
    SELECT c.id, c.user_id, c.type, c.name, c.description, c.deleted_at,
      ${metadata} AS metadata, c.data, ${pendingMetadata} AS pending_metadata,
      p.data AS pending_data, p.user_id AS pending_user_id
    FROM data_cards c LEFT JOIN data_card_updates p ON p.data_card_id = c.id
    WHERE c.id = ${id} AND c.user_id = ${userId} AND ${scopeCondition(scope)} LIMIT 1`);
  return rows[0] ?? null;
}

export async function getOwnedDeletionVersion(row: OwnedDeletionSnapshot): Promise<string> {
  // Hash one bounded target at a time, never the entire recycle-bin document collection.
  const values = [row.metadata, row.data, row.pending_metadata, row.pending_data];
  for (const value of values) {
    if (value !== null && new TextEncoder().encode(value).byteLength > maxBindingBytes) {
      throw new RangeError('Deletion snapshot exceeds D1 binding limit');
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function toOwnedDeletionTarget(row: OwnedDeletionSnapshot): Promise<OwnedDataCardDeletionTarget> {
  return { id: row.id, type: row.type, name: row.name, description: row.description, version: await getOwnedDeletionVersion(row) };
}

/** Read at most one sentinel ID beyond the confirmation bound, before loading any bodies. */
export async function listOwnedRecycleDeletionIds(db: AppDrizzleDb, userId: number): Promise<string[]> {
  const rows = await all<{ id: string }>(db, sql`
    SELECT id, recycle_generation FROM data_cards WHERE user_id = ${userId} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC, id ASC LIMIT ${OWNED_DELETE_TARGET_LIMIT + 1}`);
  return rows.map((row) => row.id);
}

export async function countOwnedRecycleCards(db: AppDrizzleDb, userId: number): Promise<number> {
  const rows = await all<{ total: number }>(db, sql`SELECT COUNT(*) AS total FROM data_cards
    WHERE user_id = ${userId} AND deleted_at IS NOT NULL`);
  if (!rows[0] || !Number.isSafeInteger(rows[0].total) || rows[0].total < 0) throw new Error('Invalid recycle count');
  return rows[0].total;
}

function expectedValues(rows: OwnedDeletionSnapshot[]): SQL {
  return sql.join(rows.map((row) => sql`(${row.id}, ${row.metadata}, ${row.data}, ${row.pending_metadata}, ${row.pending_data})`), sql`, `);
}
const matchExpected = sql`c.id = e.id AND ${metadata} IS e.metadata AND c.data IS e.data
  AND ${pendingMetadata} IS e.pending_metadata AND p.data IS e.pending_data`;
function assertSnapshots(rows: OwnedDeletionSnapshot[], userId: number, scope: DeletionScope): void {
  if (rows.length < 1 || rows.length > OWNED_DELETE_TARGET_LIMIT || new Set(rows.map((row) => row.id)).size !== rows.length
    || rows.some((row) => row.user_id !== userId || (scope === 'active') !== (row.deleted_at === null)
      || (row.pending_user_id !== null && row.pending_user_id !== userId))) {
    throw new Error('Invalid confirmed deletion snapshots');
  }
}
const validLimit = (limit: number) => Number.isSafeInteger(limit) && limit >= 0;

/** One statement: active CAS and shared all-type capacity are checked under the same write lock. */
export async function softDeleteOwnedCardAtomically(db: AppDrizzleDb, userId: number, row: OwnedDeletionSnapshot, limit: number): Promise<string[]> {
  assertSnapshots([row], userId, 'active');
  if (!validLimit(limit)) throw new RangeError('Invalid recycle limit');
  const changed = await returningIds(db, sql`
    WITH expected(id, metadata, data, pending_metadata, pending_data) AS (VALUES ${expectedValues([row])}),
    matched AS MATERIALIZED (
      SELECT c.id FROM data_cards c JOIN expected e ON c.id = e.id
      LEFT JOIN data_card_updates p ON p.data_card_id = c.id
      WHERE c.user_id = ${userId} AND c.deleted_at IS NULL AND ${matchExpected}
    )
    UPDATE data_cards SET deleted_at = CURRENT_TIMESTAMP, recycle_generation = ${crypto.randomUUID()}
    WHERE user_id = ${userId} AND deleted_at IS NULL AND id IN (SELECT id FROM matched)
      AND (SELECT COUNT(*) FROM data_cards WHERE user_id = ${userId} AND deleted_at IS NOT NULL) < ${limit}
    RETURNING id`);
  return changed;
}

/** Explicit set CAS. MATERIALIZED prevents each deleted row changing the next row's guard.
 * A continuation additionally freezes the original active target and requires projected capacity.
 * New recycle arrivals are never included in the requested deletion set.
 */
export async function purgeOwnedCardsAtomically(
  db: AppDrizzleDb, userId: number, rows: OwnedDeletionSnapshot[], scope: DeletionScope,
  continuation?: { target: OwnedDeletionSnapshot; limit: number },
): Promise<string[]> {
  assertSnapshots(rows, userId, scope);
  if (scope === 'active' && (rows.length !== 1 || continuation)) throw new Error('Active purge requires exactly one target');
  if (continuation) {
    assertSnapshots([continuation.target], userId, 'active');
    if (!validLimit(continuation.limit)) throw new RangeError('Invalid recycle limit');
  }
  const continuationCte = continuation ? sql`,
    continuation_expected(id, metadata, data, pending_metadata, pending_data) AS (VALUES ${expectedValues([continuation.target])}),
    continuation_guard AS MATERIALIZED (
      SELECT c.id FROM data_cards c JOIN continuation_expected e ON c.id = e.id
      LEFT JOIN data_card_updates p ON p.data_card_id = c.id
      WHERE c.user_id = ${userId} AND c.deleted_at IS NULL AND ${matchExpected}
    )` : sql``;
  // This is materialized before any deletion; never recompute the projected count mid-statement.
  const capacityCte = continuation ? sql`,
    capacity_guard AS MATERIALIZED (
      SELECT COUNT(*) - ${rows.length} < ${continuation.limit} AS allowed FROM data_cards
      WHERE user_id = ${userId} AND deleted_at IS NOT NULL
    )` : sql``;
  const continuationCondition = continuation ? sql`
    AND EXISTS (SELECT 1 FROM continuation_guard)
    AND (SELECT allowed FROM capacity_guard) = 1` : sql``;
  const deleted = await returningIds(db, sql`
    WITH expected(id, metadata, data, pending_metadata, pending_data) AS (VALUES ${expectedValues(rows)}),
    matched AS MATERIALIZED (
      SELECT c.id FROM data_cards c JOIN expected e ON c.id = e.id
      LEFT JOIN data_card_updates p ON p.data_card_id = c.id
      WHERE c.user_id = ${userId} AND ${scopeCondition(scope)} AND ${matchExpected}
    )${continuationCte}${capacityCte},
    approved AS MATERIALIZED (
      SELECT id FROM matched WHERE (SELECT COUNT(*) FROM matched) = ${rows.length}${continuationCondition}
    )
    DELETE FROM data_cards WHERE user_id = ${userId} AND id IN (SELECT id FROM approved)
      AND ${scope === 'active' ? sql`deleted_at IS NULL` : sql`deleted_at IS NOT NULL`}
    RETURNING id`);
  return deleted;
}

/** Shared full-snapshot SQL guard for restore and confirmed deletion; no client body bindings. */
export function ownedRecycleSnapshotGuard(row: OwnedDeletionSnapshot, userId: number): SQL {
  assertSnapshots([row], userId, 'recycle');
  return sql`EXISTS (
    WITH expected(id, metadata, data, pending_metadata, pending_data) AS (VALUES ${expectedValues([row])})
    SELECT 1 FROM data_cards c JOIN expected e ON c.id = e.id
    LEFT JOIN data_card_updates p ON p.data_card_id = c.id
    WHERE c.user_id = ${userId} AND c.deleted_at IS NOT NULL AND ${matchExpected}
  )`;
}
