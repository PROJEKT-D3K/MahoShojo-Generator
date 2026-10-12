import {
  DesktopBattleReportRequestSchema, DesktopBattleReportResponseSchema,
  BattleReportListSchema, BattleReportDetailSchema, BattleReportGenerationIdSchema,
  type DesktopBattleReportRequest, type BattleReportList, type BattleReportDetail,
} from '@mahoshojo/contracts/battle-report-history';
import { DesktopCloudError, toCloudError, type InvokeFn } from './cloud-bridge';

export const CLOUD_BATTLE_REPORTS_READ_COMMAND = 'cloud_battle_reports_read';
export async function readCloudBattleReports(invoke: InvokeFn, request: Extract<DesktopBattleReportRequest, { kind: 'list' }>): Promise<BattleReportList>;
export async function readCloudBattleReports(invoke: InvokeFn, request: Extract<DesktopBattleReportRequest, { kind: 'detail' }>): Promise<BattleReportDetail>;
export async function readCloudBattleReports(invoke: InvokeFn, request: DesktopBattleReportRequest): Promise<BattleReportList | BattleReportDetail> {
  const parsed = DesktopBattleReportRequestSchema.safeParse(request);
  if (!parsed.success) {
    const unsupportedId = request.kind === 'detail' && !BattleReportGenerationIdSchema.safeParse(request.generationId).success;
    throw new DesktopCloudError(CLOUD_BATTLE_REPORTS_READ_COMMAND, 'invalid-request', unsupportedId
      ? '此历史编号暂不支持桌面端打开，请在网页版查看' : '战报读取参数无效');
  }
  let raw: unknown;
  try { raw = await invoke(CLOUD_BATTLE_REPORTS_READ_COMMAND, { request: parsed.data }); }
  catch (cause) { throw toCloudError(CLOUD_BATTLE_REPORTS_READ_COMMAND, cause); }
  const result = DesktopBattleReportResponseSchema.safeParse(raw);
  if (!result.success || result.data.userId !== request.expectedUserId || result.data.data.viewerUserId !== request.expectedUserId) {
    throw new DesktopCloudError(CLOUD_BATTLE_REPORTS_READ_COMMAND, 'invalid-response', '战报返回协议或账号不匹配，已忽略内容');
  }
  const data = request.kind === 'list' ? BattleReportListSchema.safeParse(result.data.data) : BattleReportDetailSchema.safeParse(result.data.data);
  if (!data.success || (request.kind === 'list' && 'page' in data.data && (data.data.page !== request.filters.page || data.data.pageSize !== request.filters.pageSize))
    || (request.kind === 'detail' && 'record' in data.data && data.data.record.id !== request.generationId)) {
    throw new DesktopCloudError(CLOUD_BATTLE_REPORTS_READ_COMMAND, 'invalid-response', '战报返回目标不匹配，已忽略内容');
  }
  return data.data;
}
