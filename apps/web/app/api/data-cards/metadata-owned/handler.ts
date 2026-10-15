import { DataCardExpectedOwnerSchema, OwnedDataCardMetadataRequestSchema } from '@mahoshojo/contracts/data-cards';
import { requireAuthUser } from '@/lib/auth/server';
import { config } from '@/lib/config';
import { getDrizzleDbFromRuntime } from '@/lib/db/drizzle';
import {
  getOwnedReplacementVersion,
  readOwnedReplacementSnapshot,
  updateOwnedDataCardMetadataAtomically,
} from '@/lib/db/repositories/data-card-owned-replacement';
import { autoReviewLatestPendingPublicDataCardsForUser } from '@/lib/review/auto-data-card-review';
import { getAutoReviewPolicy } from '@/lib/review/auto-review-engine';
import { quickCheck } from '@/lib/sensitive-word-filter';

const targetChangedResponse = () => Response.json({ error: 'TARGET_CHANGED' }, { status: 409 });

export async function appRouteHandler(req: Request): Promise<Response> {
  if (req.method !== 'PUT') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const auth = await requireAuthUser(req);
  if ('response' in auth) return auth.response;
  const user = Object.freeze({ ...auth.user });
  const payload = await req.json().catch(() => null);
  const owner = DataCardExpectedOwnerSchema.safeParse(payload?.expectedUserId);
  if (!owner.success) return Response.json({ error: '无效的 expectedUserId' }, { status: 400 });
  if (owner.data !== user.id) return Response.json({ error: 'ACCOUNT_MISMATCH' }, { status: 409 });
  const parsed = OwnedDataCardMetadataRequestSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: '无效的元信息参数' }, { status: 400 });

  try {
    const db = getDrizzleDbFromRuntime();
    if (!db) return Response.json({ error: '数据卡存储不可用' }, { status: 503 });
    const snapshot = await readOwnedReplacementSnapshot(db, parsed.data.id, user.id);
    if (!snapshot) return Response.json({ error: '数据卡不存在或无权访问' }, { status: 404 });
    if (snapshot.pending_id !== null && snapshot.pending_user_id !== user.id) return targetChangedResponse();
    if (parsed.data.expectedVersion !== await getOwnedReplacementVersion(snapshot)) return targetChangedResponse();

    const { name, description } = parsed.data;
    const sensitive = await quickCheck(`${name} ${description} `);
    if (sensitive.hasSensitiveWords) return Response.json({
      error: 'SENSITIVE_WORD_DETECTED', redirect: '/arrested',
    }, { status: 403 });
    const isPublic = snapshot.is_public === -1 ? -1 : parsed.data.isPublic;
    const updated = await updateOwnedDataCardMetadataAtomically(db, snapshot, { name, description, isPublic });
    if (!updated) return targetChangedResponse();

    // 保留旧元信息路径的主卡 pending 审核触发；该审核只改审核状态。
    // 不运行待审更新审核：它会替换正文并消费 data_card_updates。
    const isExempt = user.is_review_exempt === 1 && getAutoReviewPolicy().exemptUserPolicy !== 'review';
    if (config.DATA_CARD_AUTO_REVIEW?.enabled && !isExempt && user.is_admin !== 1
      && isPublic === 1 && snapshot.review_status === 'pending') {
      const review = autoReviewLatestPendingPublicDataCardsForUser(user.id).then(() => undefined);
      const context = (req as Request & { context?: { waitUntil: (promise: Promise<void>) => void } }).context;
      if (context?.waitUntil) context.waitUntil(review);
      else await review;
    }
    return Response.json({
      success: true, id: snapshot.id, accountFenceVersion: 1, ownerUserId: user.id, metadataVersion: 1,
    });
  } catch (error) {
    console.error('Owned metadata update failed:', error);
    return Response.json({ error: '更新数据卡元信息失败' }, { status: 500 });
  }
}
