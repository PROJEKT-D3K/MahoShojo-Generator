import { getUserByAuthKey } from '@/lib/database/users';
import { hasBetterAuthSessionCookie } from '@/lib/auth/better-auth';
import { isBearerOnlyHonoAuthMode } from '@/lib/auth/hono-auth-mode';

export interface AuthenticatedUser {
  id: number;
  username: string;
  prefix?: string | null;
  is_banned?: string | null;
  is_admin?: number | null;
  is_review_exempt?: number | null;
}

export type AuthUserSource = 'better-auth-session' | 'legacy-bearer';

export type AuthUserContext = {
  user: AuthenticatedUser;
  source: AuthUserSource;
};

export type AuthReadOptions = { strict?: boolean };

export class AuthAccountUnavailableError extends Error {
  constructor() { super('Session account mapping unavailable'); this.name = 'AuthAccountUnavailableError'; }
}

type AuthServerDeps = {
  getSessionAuthUserImpl: (req: Request, options?: AuthReadOptions) => Promise<unknown>;
  getUserByAuthKeyStrictImpl: (authKey: string) => Promise<unknown>;
  getUserByAuthKeyImpl: typeof getUserByAuthKey;
  hasBetterAuthSessionCookieImpl: typeof hasBetterAuthSessionCookie;
};

export type RequireAuthUserResult = { user: AuthenticatedUser; source: AuthUserSource } | { response: Response };

export type AuthServerApi = {
  getLegacyBearerAuthUser: (req: Request) => Promise<AuthenticatedUser | null>;
  getAuthUser: (req: Request) => Promise<AuthUserContext | null>;
  requireAuthUser: (req: Request, options?: AuthReadOptions) => Promise<RequireAuthUserResult>;
};

const defaultAuthServerDeps: AuthServerDeps = {
  getSessionAuthUserImpl: async (req, options) => {
    const { getSessionAuthUserForApp } = await import('@/lib/auth/server-app');
    return getSessionAuthUserForApp(req, options);
  },
  getUserByAuthKeyStrictImpl: async (authKey) => {
    const [{ getDrizzleDbFromRuntime }, { getBusinessUserByAuthKey }] = await Promise.all([
      import('@/lib/db/drizzle'), import('@/lib/db/repositories/business-users'),
    ]);
    const db = getDrizzleDbFromRuntime();
    if (!db) throw new Error('Authentication storage unavailable');
    const user = await getBusinessUserByAuthKey(db, authKey);
    return user ? { ...user, is_banned: user.isBanned, is_admin: user.isAdmin, is_review_exempt: user.isReviewExempt } : null;
  },
  getUserByAuthKeyImpl: getUserByAuthKey,
  hasBetterAuthSessionCookieImpl: hasBetterAuthSessionCookie,
};

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const toPositiveInteger = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  return null;
};

const toOptionalInteger = (value: unknown): number | undefined => {
  if (value == null) return undefined;

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return undefined;
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) return undefined;
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) return undefined;
    return parsed;
  }

  return undefined;
};

const toAuthenticatedUser = (raw: unknown): AuthenticatedUser | null => {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const id = toPositiveInteger(record.id);
  if (!id || !isNonEmptyString(record.username)) return null;

  const user: AuthenticatedUser = {
    id,
    username: record.username.trim(),
  };

  if (record.prefix == null || typeof record.prefix === 'string') {
    user.prefix = record.prefix as string | null | undefined;
  }

  if (record.is_banned == null || typeof record.is_banned === 'string') {
    user.is_banned = record.is_banned as string | null | undefined;
  }

  const isAdmin = toOptionalInteger(record.is_admin);
  if (isAdmin !== undefined) {
    user.is_admin = isAdmin;
  }

  const isReviewExempt = toOptionalInteger(record.is_review_exempt);
  if (isReviewExempt !== undefined) {
    user.is_review_exempt = isReviewExempt;
  }

  return user;
};

const getSessionAuthUser = async (req: Request, deps: AuthServerDeps, options: AuthReadOptions = {}): Promise<AuthenticatedUser | null> => {
  if (!deps.hasBetterAuthSessionCookieImpl(req)) return null;
  if (options.strict) return toAuthenticatedUser(await deps.getSessionAuthUserImpl(req, options));

  try {
    return toAuthenticatedUser(await deps.getSessionAuthUserImpl(req));
  } catch (error) {
    console.error('[auth][server] 会话探测失败:', error);
    return null;
  }
};

const getBearerAuthKey = (req: Request): string | null => {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const authKey = authHeader.slice('Bearer '.length).trim();
  if (!authKey) return null;
  return authKey;
};

const isBannedUser = (user: AuthenticatedUser): boolean =>
  typeof user.is_banned === 'string' && user.is_banned.trim().length > 0;

const getLegacyBearerAuthUserWithDeps = async (
  req: Request,
  deps: AuthServerDeps,
  options: AuthReadOptions = {},
): Promise<AuthenticatedUser | null> => {
  const authKey = getBearerAuthKey(req);
  if (!authKey) return null;
  return toAuthenticatedUser(await (options.strict ? deps.getUserByAuthKeyStrictImpl(authKey) : deps.getUserByAuthKeyImpl(authKey)));
};

const getAuthUserWithDeps = async (req: Request, deps: AuthServerDeps, options: AuthReadOptions = {}): Promise<AuthUserContext | null> => {
  if (isBearerOnlyHonoAuthMode()) {
    const bearerUser = await getLegacyBearerAuthUserWithDeps(req, deps, options);
    return bearerUser ? { user: bearerUser, source: 'legacy-bearer' } : null;
  }

  const sessionUser = await getSessionAuthUser(req, deps, options);
  if (sessionUser) {
    return { user: sessionUser, source: 'better-auth-session' };
  }

  // 严格读取不允许失效的 cookie 改用另一份 Bearer 身份。
  if (options.strict && deps.hasBetterAuthSessionCookieImpl(req)) return null;
  const legacyUser = await getLegacyBearerAuthUserWithDeps(req, deps, options);
  if (legacyUser) {
    return { user: legacyUser, source: 'legacy-bearer' };
  }

  return null;
};

const requireAuthUserWithDeps = async (req: Request, deps: AuthServerDeps, options: AuthReadOptions = {}): Promise<RequireAuthUserResult> => {
  const context = await getAuthUserWithDeps(req, deps, options);
  if (!context) {
    return { response: json({ error: '未授权' }, 401) };
  }

  if (isBannedUser(context.user)) {
    return { response: json({ error: '账号已被封禁' }, 403) };
  }

  return context;
};

export const createAuthServer = (overrides: Partial<AuthServerDeps> = {}): AuthServerApi => {
  const deps: AuthServerDeps = {
    ...defaultAuthServerDeps,
    ...overrides,
  };

  return {
    getLegacyBearerAuthUser: (req) => getLegacyBearerAuthUserWithDeps(req, deps),
    getAuthUser: (req) => getAuthUserWithDeps(req, deps),
    requireAuthUser: (req, options) => requireAuthUserWithDeps(req, deps, options),
  };
};

const defaultAuthServer = createAuthServer();

export const getLegacyBearerAuthUser = async (req: Request): Promise<AuthenticatedUser | null> =>
  defaultAuthServer.getLegacyBearerAuthUser(req);

export const getAuthUser = async (req: Request): Promise<AuthUserContext | null> => defaultAuthServer.getAuthUser(req);

export const requireAuthUser = async (req: Request, options?: AuthReadOptions): Promise<RequireAuthUserResult> =>
  defaultAuthServer.requireAuthUser(req, options);
