import { OwnedDataCardRestoreRequestSchema, OwnedDataCardRestoreAcknowledgementSchema } from '@mahoshojo/contracts/data-cards';
import { requireAuthUser } from '@/lib/auth/server';
import { config } from '@/lib/config';
import { getDrizzleDbFromRuntime } from '@/lib/db/drizzle';
import { assertOwnedDeletionSchema, readOwnedDeletionSnapshot, getOwnedDeletionVersion } from '@/lib/db/repositories/data-card-owned-deletion';
import { restoreDataCardByIdAndUser } from '@/lib/db/repositories/data-cards-core';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const failure = (code: string, status: number) => json({ error: code, code }, status);
export async function appRouteHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405);
  let auth: Awaited<ReturnType<typeof requireAuthUser>>;
  try { auth = await requireAuthUser(req, { strict: true }); } catch { return failure('AUTH_UNAVAILABLE', 503); }
  if ('response' in auth) return failure(auth.response.status >= 500 ? 'AUTH_UNAVAILABLE' : 'UNAUTHORIZED', auth.response.status >= 500 ? 503 : 401);
  const parsed = OwnedDataCardRestoreRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || new URL(req.url).search !== '') return failure('INVALID_REQUEST', 400);
  const input = parsed.data; const userId = auth.user.id;
  if (input.expectedUserId !== userId) return failure('ACCOUNT_MISMATCH', 409);
  let dispatched = false;
  try {
    const db = getDrizzleDbFromRuntime(); if (!db) return failure('STORAGE_UNAVAILABLE', 503);
    await assertOwnedDeletionSchema(db);
    const snapshot = await readOwnedDeletionSnapshot(db, userId, input.id, 'recycle');
    if (!snapshot) return failure('NOT_FOUND', 404);
    if ((snapshot.pending_user_id !== null && snapshot.pending_user_id !== userId) || await getOwnedDeletionVersion(snapshot) !== input.version) return failure('TARGET_CHANGED', 409);
    // From this point a missing/invalid receipt can never be called a rollback.
    dispatched = true;
    const result = await restoreDataCardByIdAndUser(db, input.id, userId, config.DEFAULT_DATA_CARD_CAPACITY, snapshot);
    if (result.status === 'not_found') return failure('NOT_FOUND', 404);
    if (result.status === 'quota_exceeded') return failure('CAPACITY_EXCEEDED', 409);
    if (result.status !== 'restored') return failure('TARGET_CHANGED', 409);
    return json(OwnedDataCardRestoreAcknowledgementSchema.parse({ success: true, accountFenceVersion: 1, restoreProtocolVersion: 1, ownerUserId: userId, operation: 'restore', id: input.id, version: input.version }));
  } catch { return failure(dispatched ? 'RESTORE_OUTCOME_UNKNOWN' : 'STORAGE_UNAVAILABLE', 503); }
}
