import { z } from './zod';

/** Transport budgets, not historical content or generation limits. Never truncate a report. */
export const BATTLE_REPORT_MAX_PAGE = 10_000;
export const BATTLE_REPORT_LIST_MAX_BYTES = 1024 * 1024;
export const BATTLE_REPORT_DETAIL_MAX_BYTES = 16 * 1024 * 1024;
export const BattleReportViewerIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const BattleReportGenerationIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/);
export const BattleReportFiltersSchema = z.object({
  page: z.number().int().min(1).max(BATTLE_REPORT_MAX_PAGE),
  pageSize: z.number().int().min(1).max(30),
  status: z.enum(['', 'completed', 'aborted', 'failed']),
  mode: z.enum(['', 'classic', 'kizuna', 'daily', 'scenario']),
  generationMode: z.enum(['', 'stream', 'non-stream']),
  pvpOnly: z.boolean(),
  sort: z.enum(['started_at_desc', 'started_at_asc']),
  q: z.string().max(120),
}).strict();
export type BattleReportFilters = z.infer<typeof BattleReportFiltersSchema>;
export const DEFAULT_BATTLE_REPORT_FILTERS: BattleReportFilters = {
  page: 1, pageSize: 10, status: '', mode: '', generationMode: '', pvpOnly: false, sort: 'started_at_desc', q: '',
};
const nullableText = z.string().nullable();
export const BattleReportSummarySchema = z.object({
  // Do not constrain historical record IDs using the narrower native route input grammar.
  id: z.string(), startedAt: z.string(), status: z.string(), endpoint: z.string(),
  generationMode: z.string(), mode: z.string(), headline: nullableText, displayTitle: nullableText,
  winner: nullableText, hasPreview: z.boolean(), canRegenerate: z.boolean(), contentBlocked: z.boolean(),
  errorMessage: nullableText, outputHasShieldWords: z.boolean(),
  pvpRoomId: nullableText, pvpMatchId: nullableText, pvpRoundId: nullableText,
  sourceKind: z.enum(['solo', 'arena-multiplayer', 'pvp']),
  arenaParticipantRole: z.enum(['host', 'member']).nullable(),
}).strict();
export type BattleReportSummary = z.infer<typeof BattleReportSummarySchema>;
export const BattleReportCombatantSchema = z.object({
  sortIndex: z.number(), name: z.string(), type: nullableText, teamId: z.number().nullable(),
  templateId: nullableText.optional(), isNative: z.boolean().optional(), isPreset: z.boolean().optional(),
  characterGuidance: nullableText.optional(), dataCardId: nullableText.optional(), dataCardUpdatedAt: nullableText.optional(),
}).strict();
export const BattleReportDetailRecordSchema = BattleReportSummarySchema.extend({
  endedAt: z.string(), durationMs: z.number(), scenarioTitle: nullableText, language: nullableText,
  storyLength: nullableText, outputPreview: nullableText,
  outputSource: z.enum(['d1', 'r2', 'none']), outputReadError: nullableText, contentExpired: z.boolean(),
  accessScope: z.enum(['owner', 'arena-participant', 'pvp-participant']),
}).strict();
export const BattleReportListSchema = z.object({
  success: z.literal(true), viewerUserId: BattleReportViewerIdSchema,
  page: z.number().int().min(1).max(BATTLE_REPORT_MAX_PAGE), pageSize: z.number().int().min(1).max(30),
  total: z.number().int().nonnegative(), records: z.array(BattleReportSummarySchema).max(30),
}).strict();
export type BattleReportList = z.infer<typeof BattleReportListSchema>;
export const BattleReportDetailSchema = z.object({
  success: z.literal(true), viewerUserId: BattleReportViewerIdSchema,
  record: BattleReportDetailRecordSchema, combatants: z.array(BattleReportCombatantSchema),
}).strict();
export type BattleReportDetail = z.infer<typeof BattleReportDetailSchema>;
export const DesktopBattleReportRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), expectedUserId: BattleReportViewerIdSchema, filters: BattleReportFiltersSchema }).strict(),
  z.object({ kind: z.literal('detail'), expectedUserId: BattleReportViewerIdSchema, generationId: BattleReportGenerationIdSchema }).strict(),
]);
export type DesktopBattleReportRequest = z.infer<typeof DesktopBattleReportRequestSchema>;
export const DesktopBattleReportResponseSchema = z.object({
  userId: BattleReportViewerIdSchema,
  data: z.union([BattleReportListSchema, BattleReportDetailSchema]),
}).strict();
export type DesktopBattleReportResponse = z.infer<typeof DesktopBattleReportResponseSchema>;

/** Optional on the server for old clients; guarded clients must verify the actual viewer too. */
export function checkBattleReportExpectedViewer(params: URLSearchParams, viewerUserId: number): 'invalid' | 'mismatch' | null {
  const values = params.getAll('expectedUserId');
  if (!values.length) return null;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]!)) return 'invalid';
  const expected = BattleReportViewerIdSchema.safeParse(Number(values[0]));
  if (!expected.success) return 'invalid';
  return expected.data === viewerUserId ? null : 'mismatch';
}

export function battleReportQueryParams(filters: BattleReportFilters): URLSearchParams {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
  if (filters.status) params.set('status', filters.status);
  if (filters.mode) params.set('mode', filters.mode);
  if (filters.generationMode) params.set('generationMode', filters.generationMode);
  if (filters.pvpOnly) params.set('pvpOnly', '1');
  params.set('sort', filters.sort);
  if (filters.q) params.set('q', filters.q);
  return params;
}
