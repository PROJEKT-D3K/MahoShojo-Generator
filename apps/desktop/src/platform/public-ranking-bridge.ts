import {
  PublicRankingRequestSchema, parsePublicRankingResponse,
  type PublicRankingRequest, type PublicRankingData,
} from '@mahoshojo/contracts/public-ranking';
import { DesktopCloudError, toCloudError, type InvokeFn } from './cloud-bridge';

export const CLOUD_PUBLIC_RANKING_READ_COMMAND = 'cloud_public_ranking_read';
/** Anonymous narrow read. It neither asks for nor reads the account session. */
export async function readPublicRanking<R extends PublicRankingRequest>(invoke: InvokeFn, request: R): Promise<PublicRankingData<R['kind']>> {
  const parsed = PublicRankingRequestSchema.safeParse(request);
  if (!parsed.success) throw new DesktopCloudError(CLOUD_PUBLIC_RANKING_READ_COMMAND, 'invalid-request', '排行榜读取参数无效');
  const valid = parsed.data;
  let raw: unknown;
  try { raw = await invoke(CLOUD_PUBLIC_RANKING_READ_COMMAND, { request: valid }); }
  catch (cause) { throw toCloudError(CLOUD_PUBLIC_RANKING_READ_COMMAND, cause); }
  try { return parsePublicRankingResponse(request, raw); }
  catch { throw new DesktopCloudError(CLOUD_PUBLIC_RANKING_READ_COMMAND, 'invalid-response', '排行榜返回协议或目标不匹配，已忽略内容'); }
}
