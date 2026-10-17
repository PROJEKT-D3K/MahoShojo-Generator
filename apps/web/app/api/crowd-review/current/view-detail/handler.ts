import {
  CrowdReviewConflictError,
  CrowdReviewForbiddenError,
  CrowdReviewNotFoundError,
  CrowdReviewServiceUnavailableError,
  markCrowdReviewDetailViewed,
} from '@/lib/crowd-review/service';
import { json, readJson, requireAuthUser, withApiErrorBoundary } from '@/lib/api/server';

type HandlerDeps = {
  requireAuthUser: typeof requireAuthUser;
  getDb: () => any;
  markCrowdReviewDetailViewed: typeof markCrowdReviewDetailViewed;
};

const defaultDeps: HandlerDeps = {
  requireAuthUser,
  getDb: () => null,
  markCrowdReviewDetailViewed,
};

const getDefaultDb = async () => {
  const { getDrizzleDbFromRuntime } = await import('@/lib/db/drizzle');
  return getDrizzleDbFromRuntime();
};

const toErrorResponse = (error: unknown): Response | null => {
  if (error instanceof CrowdReviewForbiddenError) {
    return json({ error: error.message }, { status: 403 });
  }
  if (error instanceof CrowdReviewNotFoundError) {
    return json({ error: error.message }, { status: 404 });
  }
  if (error instanceof CrowdReviewConflictError) {
    return json({ error: error.message }, { status: 409 });
  }
  if (error instanceof CrowdReviewServiceUnavailableError) {
    return json({ error: error.message }, { status: 503 });
  }
  return null;
};

export const createCrowdReviewCurrentViewDetailHandler =
  (deps: Partial<HandlerDeps> = {}) =>
  async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, { status: 405 });
    }

    const auth = await (deps.requireAuthUser ?? defaultDeps.requireAuthUser)(req);
    if ('response' in auth) return auth.response;

    const parsed = await readJson<Record<string, unknown>>(req);
    if ('response' in parsed) return parsed.response;
    const assignmentId = typeof parsed.data.assignmentId === 'string' ? parsed.data.assignmentId.trim() : '';

    if (!assignmentId) {
      return json({ error: '缺少 assignmentId' }, { status: 400 });
    }

    try {
      const payload = await (deps.markCrowdReviewDetailViewed ?? defaultDeps.markCrowdReviewDetailViewed)({
        db: deps.getDb ? deps.getDb() : await getDefaultDb(),
        userId: auth.user.id,
        assignmentId,
      });

      return json(payload, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const response = toErrorResponse(error);
      if (response) return response;
      throw error;
    }
  };

export const appRouteHandler = withApiErrorBoundary(createCrowdReviewCurrentViewDetailHandler());
export default appRouteHandler;
