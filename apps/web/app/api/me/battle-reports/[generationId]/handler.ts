import { checkBattleReportExpectedViewer, type BattleReportDetail } from '@mahoshojo/contracts/battle-report-history';
import {
  getBattleReportGenerationByIdLite,
  updateBattleReportGenerationOutputHasSensitiveWords,
} from '@/lib/database/battle-report-generations';
import { resolveBattleReportDisplayTitle } from '@/lib/arena/battle-report-display-title';
import {
  extractBattleReportGenerationErrorMessage,
  loadBattleReportGenerationOutputText,
} from '@/lib/arena/battle-report-record-utils';
import { getBattleReportGenerationCombatantsByGenerationId } from '@/lib/database/battle-report-generation-combatants';
import { parseGenerationCombatantsFallback } from '@/lib/database/arena-ratings';
import { resolveBattleReportAccess } from '@/lib/arena/battle-report-access';
import { json, requireAuthUser } from '@/lib/api/server';
import { quickCheck } from '@/lib/sensitive-word-filter';

const getGenerationIdFromUrl = (url: string): string | null => {
  try {
    const prefix = '/api/me/battle-reports/';
    const pathname = new URL(url).pathname;
    if (!pathname.startsWith(prefix)) return null;
    const segment = pathname.slice(prefix.length);
    if (!segment || segment.includes('/')) return null;
    // Decode one segment once. Historical IDs stay opaque DB keys, never a rebuilt URL.
    const generationId = decodeURIComponent(segment);
    return generationId && !generationId.includes('/') && !generationId.includes('\\') ? generationId : null;
  } catch {
    return null;
  }
};

async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, { status: 405 });

  const auth = await requireAuthUser(req);
  if ('response' in auth) return auth.response;

  const viewerCheck = checkBattleReportExpectedViewer(new URL(req.url).searchParams, auth.user.id);
  if (viewerCheck) return json({ error: viewerCheck === 'mismatch' ? '账号已变化，请重新载入战报' : 'expectedUserId 无效' }, { status: viewerCheck === 'mismatch' ? 409 : 400 });

  const generationId = getGenerationIdFromUrl(req.url);
  if (!generationId) return json({ error: 'generationId 缺失或编码无效' }, { status: 400 });

  const record = await getBattleReportGenerationByIdLite(generationId);
  if (!record) return json({ error: '记录不存在' }, { status: 404 });

  const access = await resolveBattleReportAccess(generationId, auth.user.id);
  if (!access) return json({ error: '无权限' }, { status: 403 });
  const isArenaParticipant = access.scope === 'arena-participant';

  const tableCombatants = await getBattleReportGenerationCombatantsByGenerationId(generationId);
  const combatants = tableCombatants.length > 0 ? tableCombatants : parseGenerationCombatantsFallback(generationId, record.extra_json);

  const output = await loadBattleReportGenerationOutputText({
    generationId: record.id,
    outputPreview: record.output_preview,
  });
  const outputPreview = output.outputText || null;
  const hasPreviewText = Boolean(outputPreview && outputPreview.trim());
  const contentExpired = output.source === 'r2' && !output.hasStoredOutput && !output.readError;

  let contentBlocked = record.output_has_sensitive_words === 1;
  if (hasPreviewText) {
    const sensitiveCheck = await quickCheck(outputPreview!);
    contentBlocked = Boolean(sensitiveCheck.hasSensitiveWords);
    await updateBattleReportGenerationOutputHasSensitiveWords(record.id, contentBlocked);
  }

  const canRegenerate = output.hasStoredOutput && !output.readError && !contentBlocked;
  const errorMessage = extractBattleReportGenerationErrorMessage(record.extra_json);

  return json({
    success: true,
    viewerUserId: auth.user.id,
    record: {
      id: record.id,
      startedAt: record.started_at,
      endedAt: record.ended_at,
      durationMs: record.duration_ms,
      status: record.status,
      endpoint: record.endpoint,
      generationMode: record.generation_mode,
      mode: record.mode,
      scenarioTitle: record.scenario_title,
      language: record.language,
      storyLength: record.story_length,
      headline: record.headline,
      displayTitle: resolveBattleReportDisplayTitle({
        headline: record.headline,
        content: contentBlocked ? null : outputPreview,
        contextLabel: record.scenario_title,
        mode: record.mode,
      }),
      winner: record.winner,
      outputPreview: contentBlocked ? null : outputPreview,
      hasPreview: Boolean(outputPreview && outputPreview.trim()) && !contentBlocked,
      contentBlocked,
      canRegenerate,
      outputSource: output.source,
      outputReadError: output.readError,
      contentExpired,
      errorMessage,
      outputHasShieldWords: Boolean(record.output_has_shield_words),
      pvpRoomId: record.pvp_room_id,
      pvpMatchId: record.pvp_match_id,
      pvpRoundId: record.pvp_round_id,
      accessScope: access.scope,
      arenaParticipantRole: access.arenaParticipantRole,
      sourceKind: record.source_kind,
    },
    combatants: combatants.map((c) => ({
      sortIndex: c.sort_index,
      name: c.name,
      type: c.type,
      ...(isArenaParticipant ? {} : {
        templateId: c.template_id,
        isNative: Boolean(c.is_native),
        isPreset: Boolean(c.is_preset),
        characterGuidance: typeof c.character_guidance === 'string' && c.character_guidance.trim() ? c.character_guidance : null,
        dataCardId: c.data_card_id,
        dataCardUpdatedAt: c.data_card_updated_at,
      }),
      teamId: c.team_id,
    })),
  } satisfies BattleReportDetail);
}

export const appRouteHandler = handler;
export default appRouteHandler;
