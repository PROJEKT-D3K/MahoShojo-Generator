import { describe, expect, test } from 'vitest';

import {
  CrowdReviewConflictError,
  CrowdReviewForbiddenError,
  CrowdReviewNotFoundError,
  CrowdReviewServiceUnavailableError,
  CrowdReviewUnprocessableError,
} from '@/lib/crowd-review/service';
import { createCrowdReviewCurrentAssignHandler } from '@/app/api/crowd-review/current/assign/handler';
import { createCrowdReviewCurrentHandler } from '@/app/api/crowd-review/current/handler';
import { createCrowdReviewCurrentSubmitHandler } from '@/app/api/crowd-review/current/submit/handler';
import { createCrowdReviewCurrentViewDetailHandler } from '@/app/api/crowd-review/current/view-detail/handler';
import { createCrowdReviewHistoryHandler } from '@/app/api/crowd-review/history/handler';
import { createCrowdReviewSummaryHandler } from '@/app/api/crowd-review/summary/handler';

const auth = {
  user: { id: 7, username: 'hana' },
  source: 'better-auth-session' as const,
};

const jsonBody = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe('crowd review API', () => {
  test('GET /api/crowd-review/summary returns anonymous-safe defaults for logged-out viewers', async () => {
    const handler = createCrowdReviewSummaryHandler({
      getAuthUser: async () => null,
      getDb: () => {
        throw new Error('should not resolve db');
      },
      getCrowdReviewSummary: async () => ({
        eligible: false,
        inspectorStatus: 'anonymous',
        statusReason: '登录后可查看调查院状态',
        hasCurrentAssignment: false,
        hasCrowdReviewPending: false,
        entryUrl: '/investigation',
      }),
    });

    const response = await handler(new Request('https://example.test/api/crowd-review/summary'));
    const payload = await jsonBody<any>(response);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      eligible: false,
      inspectorStatus: 'anonymous',
      hasCurrentAssignment: false,
      hasCrowdReviewPending: false,
      entryUrl: '/investigation',
    });
  });

  test('POST /api/crowd-review/current/assign returns 403 for authenticated non-inspectors', async () => {
    const handler = createCrowdReviewCurrentAssignHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      assignCrowdReviewCurrentCase: async () => {
        throw new CrowdReviewForbiddenError('当前账号未持有巡查使徽章');
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/assign', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(403);
  });

  test('POST /api/crowd-review/current/assign returns existing assignment when one is already active', async () => {
    const handler = createCrowdReviewCurrentAssignHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      assignCrowdReviewCurrentCase: async () => ({
        createdNewAssignment: false,
        currentCase: {
          assignmentId: 'assignment-1',
          assignmentStatus: 'assigned',
          assignedAt: '2026-04-08T12:00:00.000Z',
          expiresAt: '2026-04-08T12:30:00.000Z',
          detailViewedAt: null,
          caseId: 'round-1',
          reportCaseId: 'case-1',
          targetEntityType: 'data_card',
          targetEntityId: 'card-1',
          targetSnapshot: null,
          reportSummary: { reasonLabels: [], details: [], references: [] },
          ruleHints: ['投票前不会展示票况'],
          availableDecisions: ['violation', 'no_violation', 'abstain'],
          postVoteSummary: null,
        },
      }),
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/assign', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    const payload = await jsonBody<any>(response);

    expect(response.status).toBe(200);
    expect(payload.createdNewAssignment).toBe(false);
    expect(payload.currentCase.assignmentId).toBe('assignment-1');
  });

  test('POST /api/crowd-review/current/assign returns 409 when assignment state changed concurrently', async () => {
    const handler = createCrowdReviewCurrentAssignHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      assignCrowdReviewCurrentCase: async () => {
        throw new CrowdReviewConflictError('案件已被其他巡查使领取，请刷新后重试');
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/assign', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(409);
  });

  test('GET /api/crowd-review/current returns 404 when no current assignment exists', async () => {
    const handler = createCrowdReviewCurrentHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      getCrowdReviewCurrentCase: async () => {
        throw new CrowdReviewNotFoundError('当前没有派单');
      },
    });

    const response = await handler(new Request('https://example.test/api/crowd-review/current'));

    expect(response.status).toBe(404);
  });

  test('POST /api/crowd-review/current/submit rejects invalid decision values with 400', async () => {
    const handler = createCrowdReviewCurrentSubmitHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      submitCrowdReviewDecision: async () => {
        throw new Error('service should not be called');
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/submit', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'assignment-1', decision: 'bad-value' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  test('POST /api/crowd-review/current/submit returns postVoteSummary and never preVoteTally fields', async () => {
    const handler = createCrowdReviewCurrentSubmitHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      submitCrowdReviewDecision: async () => ({
        assignmentId: 'assignment-1',
        assignmentStatus: 'voted',
        decision: 'violation',
        postVoteSummary: {
          roundStatus: 'active',
          resultCode: null,
          summaryText: '你的处理结果已记录',
        },
        idempotentReplay: false,
      }),
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/submit', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'assignment-1', decision: 'violation', note: null }),
      }),
    );
    const payload = await jsonBody<any>(response);

    expect(response.status).toBe(200);
    expect(payload.postVoteSummary.summaryText).toContain('已记录');
    expect('preVoteTally' in payload).toBe(false);
  });

  test('POST /api/crowd-review/current/submit returns 409 when assignment state changed concurrently', async () => {
    const handler = createCrowdReviewCurrentSubmitHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      submitCrowdReviewDecision: async () => {
        throw new CrowdReviewConflictError('派单状态已变化，请刷新后重试');
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/submit', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'assignment-1', decision: 'violation', note: null }),
      }),
    );

    expect(response.status).toBe(409);
  });

  test('POST /api/crowd-review/current/submit returns 422 when review gate is not satisfied', async () => {
    const handler = createCrowdReviewCurrentSubmitHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      submitCrowdReviewDecision: async () => {
        throw new CrowdReviewUnprocessableError('提交前请先打开「查看卡片详情」阅读案件材料');
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/submit', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'assignment-1', decision: 'violation', note: null }),
      }),
    );

    expect(response.status).toBe(422);
  });

  test('POST /api/crowd-review/current/view-detail stamps the detail view time', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const handler = createCrowdReviewCurrentViewDetailHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      markCrowdReviewDetailViewed: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { assignmentId: input.assignmentId, detailViewedAt: '2026-04-08T12:00:10.000Z' };
      },
    });

    const response = await handler(
      new Request('https://example.test/api/crowd-review/current/view-detail', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'assignment-1' }),
      }),
    );
    const payload = await jsonBody<any>(response);

    expect(response.status).toBe(200);
    expect(payload).toEqual({ assignmentId: 'assignment-1', detailViewedAt: '2026-04-08T12:00:10.000Z' });
    expect(calls).toEqual([
      expect.objectContaining({ userId: 7, assignmentId: 'assignment-1' }),
    ]);
  });

  test('POST /api/crowd-review/current/view-detail returns 400 without assignmentId and 404 for unknown assignment', async () => {
    const handler = createCrowdReviewCurrentViewDetailHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      markCrowdReviewDetailViewed: async () => {
        throw new CrowdReviewNotFoundError('当前派单不存在');
      },
    });

    const badRequest = await handler(
      new Request('https://example.test/api/crowd-review/current/view-detail', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(badRequest.status).toBe(400);

    const notFound = await handler(
      new Request('https://example.test/api/crowd-review/current/view-detail', {
        method: 'POST',
        body: JSON.stringify({ assignmentId: 'missing' }),
      }),
    );
    expect(notFound.status).toBe(404);
  });

  test('GET /api/crowd-review/history returns inspector-only history rows', async () => {
    const handler = createCrowdReviewHistoryHandler({
      requireAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      listCrowdReviewHistory: async () => ({
        items: [
          {
            assignmentId: 'assignment-1',
            reportCaseId: 'case-1',
            assignmentStatus: 'voted',
            decision: 'violation',
            completedAt: '2026-04-08T12:10:00.000Z',
            resultCode: 'violation',
          },
        ],
        fetchedAt: '2026-04-08T12:12:00.000Z',
      }),
    });

    const response = await handler(new Request('https://example.test/api/crowd-review/history'));
    const payload = await jsonBody<any>(response);

    expect(response.status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].assignmentId).toBe('assignment-1');
  });

  test('handlers translate service unavailable into 503', async () => {
    const handler = createCrowdReviewSummaryHandler({
      getAuthUser: async () => auth,
      getDb: () => ({ db: true }),
      getCrowdReviewSummary: async () => {
        throw new CrowdReviewServiceUnavailableError('众查服务当前不可用');
      },
    });

    const response = await handler(new Request('https://example.test/api/crowd-review/summary'));

    expect(response.status).toBe(503);
  });
});
