import {
  OwnedRecycleBinDetailQuerySchema,
  OwnedRecycleBinDetailResponseSchema,
  OwnedRecycleBinPageSchema,
  OwnedRecycleBinQuerySchema,
} from '@mahoshojo/contracts/data-cards';
import { AuthAccountUnavailableError, requireAuthUser } from '@/lib/auth/server';
import { getDrizzleDbFromRuntime } from '@/lib/db/drizzle';
import { listOwnedRecycleBin, readOwnedRecycleBinCard } from '@/lib/db/repositories/data-card-owned-recycle';

const json = (body: unknown, status = 200): Response => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

function readQuery(params: URLSearchParams, detail: boolean): Record<string, unknown> | null {
  const allowed = new Set(detail ? ['expectedUserId', 'id'] : ['expectedUserId', 'limit', 'offset', 'type']);
  const query: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(query, key)) return null;
    if (key === 'expectedUserId' || key === 'limit' || key === 'offset') {
      if (!/^(0|[1-9]\d*)$/.test(value)) return null;
      const number = Number(value);
      if (!Number.isSafeInteger(number)) return null;
      query[key] = number;
    } else {
      query[key] = value;
    }
  }
  return query;
}

export async function handleOwnedRecycleRead(req: Request, detail: boolean): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  let auth: Awaited<ReturnType<typeof requireAuthUser>>;
  try {
    auth = await requireAuthUser(req, { strict: true });
  } catch (error) {
    return json({ error: error instanceof AuthAccountUnavailableError ? 'ACCOUNT_UNAVAILABLE' : 'AUTH_UNAVAILABLE' }, 503);
  }
  if ('response' in auth) {
    if (auth.response.status >= 500) return json({ error: 'AUTH_UNAVAILABLE' }, 503);
    const headers = new Headers(auth.response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(auth.response.body, { status: auth.response.status, headers });
  }
  // 捕获实际 owner，后续读取不会重新解析身份，也不使用客户端声称的 owner。
  const userId = auth.user.id;
  const raw = readQuery(new URL(req.url).searchParams, detail);
  const parsed = detail ? OwnedRecycleBinDetailQuerySchema.safeParse(raw) : OwnedRecycleBinQuerySchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'INVALID_QUERY' }, 400);
  if (parsed.data.expectedUserId !== userId) return json({ error: 'ACCOUNT_MISMATCH' }, 409);
  try {
    const db = getDrizzleDbFromRuntime();
    if (!db) return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
    if ('id' in parsed.data) {
      const card = await readOwnedRecycleBinCard(db, userId, parsed.data.id);
      if (!card) return json({ error: 'NOT_FOUND' }, 404);
      return json(OwnedRecycleBinDetailResponseSchema.parse({
        success: true, accountFenceVersion: 1, ownerUserId: userId, card,
      }));
    }
    const page = await listOwnedRecycleBin(db, userId, parsed.data);
    return json(OwnedRecycleBinPageSchema.parse({
      success: true, accountFenceVersion: 1, ownerUserId: userId, ...page,
    }));
  } catch {
    return json({ error: 'STORAGE_UNAVAILABLE' }, 503);
  }
}

export async function appRouteHandler(req: Request): Promise<Response> {
  return handleOwnedRecycleRead(req, false);
}
