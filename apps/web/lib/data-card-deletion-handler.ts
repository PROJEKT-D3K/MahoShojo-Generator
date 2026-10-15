import {
  OWNED_DELETE_TARGET_LIMIT,
  OwnedDataCardDeletionPreviewQuerySchema,
  OwnedDataCardDeletionPreviewSchema,
  OwnedDataCardDeletionRequestSchema,
  OwnedDataCardPurgeActiveAcknowledgementSchema,
  OwnedDataCardSoftDeleteAcknowledgementSchema,
  OwnedRecycleBinPurgeAcknowledgementSchema,
  OwnedRecycleBinPurgeRequestSchema,
  type OwnedDataCardDeletionReference,
} from '@mahoshojo/contracts/data-cards';
import { requireAuthUser } from '@/lib/auth/server';
import { config } from '@/lib/config';
import { getDrizzleDbFromRuntime, type AppDrizzleDb } from '@/lib/db/drizzle';
import {
  assertOwnedDeletionSchema, countOwnedRecycleCards, getOwnedDeletionVersion, listOwnedRecycleDeletionIds,
  purgeOwnedCardsAtomically, readOwnedDeletionSnapshot, softDeleteOwnedCardAtomically,
  toOwnedDeletionTarget, type DeletionScope, type OwnedDeletionSnapshot,
} from '@/lib/db/repositories/data-card-owned-deletion';

type Operation = 'preview' | 'soft-delete' | 'purge-active' | 'purge-recycle';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const failure = (error: string, status: number) => json({ error, code: error }, status);
const changed = () => failure('TARGET_CHANGED', 409);

function readQuery(params: URLSearchParams): Record<string, unknown> | null {
  const value: Record<string, unknown> = {};
  for (const [key, entry] of params) {
    if (!['expectedUserId', 'scope', 'id'].includes(key) || Object.prototype.hasOwnProperty.call(value, key)) return null;
    if (key === 'expectedUserId') {
      if (!/^[1-9]\d*$/.test(entry) || !Number.isSafeInteger(Number(entry))) return null;
      value[key] = Number(entry);
    } else value[key] = entry;
  }
  return value;
}
async function confirmedSnapshot(db: AppDrizzleDb, userId: number, target: OwnedDataCardDeletionReference, scope: DeletionScope): Promise<OwnedDeletionSnapshot | null> {
  const row = await readOwnedDeletionSnapshot(db, userId, target.id, scope);
  if (!row || (row.pending_user_id !== null && row.pending_user_id !== userId)
    || await getOwnedDeletionVersion(row) !== target.version) return null;
  return row;
}
function sameIds(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === expected.length
    && actual.every((id) => expected.includes(id));
}

export async function handleOwnedDataCardDeletion(req: Request, operation: Operation): Promise<Response> {
  if (req.method !== (operation === 'preview' ? 'GET' : 'POST')) return failure('METHOD_NOT_ALLOWED', 405);
  let auth: Awaited<ReturnType<typeof requireAuthUser>>;
  try { auth = await requireAuthUser(req, { strict: true }); }
  catch { return failure('AUTH_UNAVAILABLE', 503); }
  if ('response' in auth) {
    if (auth.response.status >= 500) return failure('AUTH_UNAVAILABLE', 503);
    const headers = new Headers(auth.response.headers); headers.set('Cache-Control', 'private, no-store');
    return new Response(auth.response.body, { status: auth.response.status, headers });
  }
  const userId = auth.user.id;
  const raw = operation === 'preview' ? readQuery(new URL(req.url).searchParams) : await req.json().catch(() => null);
  const parsed = operation === 'preview' ? OwnedDataCardDeletionPreviewQuerySchema.safeParse(raw)
    : operation === 'purge-recycle' ? OwnedRecycleBinPurgeRequestSchema.safeParse(raw)
      : OwnedDataCardDeletionRequestSchema.safeParse(raw);
  if (!parsed.success) return failure('INVALID_REQUEST', 400);
  if (parsed.data.expectedUserId !== userId) return failure('ACCOUNT_MISMATCH', 409);
  const limit = config.RECYCLE_BIN_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 0) return failure('STORAGE_UNAVAILABLE', 503);
  const fence = { success: true as const, accountFenceVersion: 1 as const, deleteProtocolVersion: 1 as const, ownerUserId: userId };
  try {
    const db = getDrizzleDbFromRuntime();
    if (!db) return failure('STORAGE_UNAVAILABLE', 503);
    await assertOwnedDeletionSchema(db);
    if ('scope' in parsed.data) {
      const input = parsed.data;
      const ids = input.id ? [input.id] : await listOwnedRecycleDeletionIds(db, userId);
      // Count/sentinel IDs only above; an over-limit preview never loads large card bodies.
      if (ids.length > OWNED_DELETE_TARGET_LIMIT) return failure('RECYCLE_TARGET_LIMIT', 409);
      const targets = [];
      for (const id of ids) {
        const snapshot = await readOwnedDeletionSnapshot(db, userId, id, input.scope);
        if (!snapshot) return input.id ? failure('NOT_FOUND', 404) : changed();
        if (snapshot.pending_user_id !== null && snapshot.pending_user_id !== userId) return changed();
        targets.push(await toOwnedDeletionTarget(snapshot));
      }
      return json(OwnedDataCardDeletionPreviewSchema.parse({
        ...fence, operation: input.scope === 'active' ? 'preview-active' : 'preview-recycle',
        targets, total: targets.length, recycleLimit: limit,
      }));
    }
    if ('targets' in parsed.data) {
      const input = parsed.data;
      const snapshots: OwnedDeletionSnapshot[] = [];
      for (const target of input.targets) {
        const snapshot = await confirmedSnapshot(db, userId, target, 'recycle');
        if (!snapshot) return changed();
        snapshots.push(snapshot);
      }
      const continuation = input.continuationTarget
        ? await confirmedSnapshot(db, userId, input.continuationTarget, 'active') : null;
      if (input.continuationTarget && !continuation) return changed();
      const ids = await purgeOwnedCardsAtomically(db, userId, snapshots, 'recycle', continuation ? { target: continuation, limit } : undefined);
      if (ids.length === 0) {
        if (continuation) {
          // This diagnoses a known zero-row write only; it never retries or advances the next stage.
          if (!await confirmedSnapshot(db, userId, input.continuationTarget!, 'active')) return changed();
          for (const target of input.targets) if (!await confirmedSnapshot(db, userId, target, 'recycle')) return changed();
          if (await countOwnedRecycleCards(db, userId) - snapshots.length >= limit) return failure('RECYCLE_BIN_FULL', 409);
        }
        return changed();
      }
      if (!sameIds(ids, input.targets.map((target) => target.id))) return failure('DELETE_OUTCOME_UNKNOWN', 503);
      return json(OwnedRecycleBinPurgeAcknowledgementSchema.parse({ ...fence, operation: 'purge-recycle', ids }));
    }
    const input = parsed.data;
    const snapshot = await confirmedSnapshot(db, userId, input, 'active');
    if (!snapshot) return changed();
    const ids = operation === 'soft-delete'
      ? await softDeleteOwnedCardAtomically(db, userId, snapshot, limit)
      : await purgeOwnedCardsAtomically(db, userId, [snapshot], 'active');
    if (ids.length === 0) {
      if (!await confirmedSnapshot(db, userId, input, 'active')) return changed();
      if (operation === 'soft-delete' && await countOwnedRecycleCards(db, userId) >= limit) return failure('RECYCLE_BIN_FULL', 409);
      return changed();
    }
    if (!sameIds(ids, [input.id])) return failure('DELETE_OUTCOME_UNKNOWN', 503);
    const body = { ...fence, operation, id: ids[0] };
    return json(operation === 'soft-delete' ? OwnedDataCardSoftDeleteAcknowledgementSchema.parse(body)
      : OwnedDataCardPurgeActiveAcknowledgementSchema.parse(body));
  } catch {
    // A write error or lost receipt is not proof of rollback; clients must treat 5xx as unknown.
    return failure(operation === 'preview' ? 'STORAGE_UNAVAILABLE' : 'DELETE_OUTCOME_UNKNOWN', 503);
  }
}
