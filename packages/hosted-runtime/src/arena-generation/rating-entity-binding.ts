import { inferCharacterKind } from '@mahoshojo/domain/data-cards';
import type { AuthenticationResolver } from '../node-runtime/authenticated-user';
import type { NodeDataD1Client } from '../node-runtime/data-ports';
import type { ArenaSeasonContext } from './season-context';
import { ARENA_PRESET_AUTHORITY } from './generated/arena-preset-authority';
import { digestArenaRatingJson, projectArenaRatingIdentity } from './rating-identity-projection';

export { digestArenaRatingJson } from './rating-identity-projection';

export const isCurrentArenaPresetRatingBinding = (entity: ArenaRatingBoundEntity): boolean => (
  ARENA_PRESET_AUTHORITY.some((entry) => entry.kind === 'character'
    && entry.id === entity.entityId && entry.versionToken === entity.contentDigest)
);

export type ArenaRatingBoundEntity = Readonly<{
  entityType: 'data_card' | 'preset';
  entityId: string;
  contentDigest: string;
  updatedAt: string | null;
  authorizedUserId: number | null;
}>;
export type ArenaRatingEntityBinding = Readonly<
  | { version: 1; status: 'bound'; entities: readonly [ArenaRatingBoundEntity, ArenaRatingBoundEntity] }
  | { version: 1; status: 'unbound'; reason: 'entity-body-mismatch' | 'entity-reference-unavailable' }
>;
const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const unbound = (reason: 'entity-body-mismatch' | 'entity-reference-unavailable'): ArenaRatingEntityBinding => (
  { version: 1, status: 'unbound', reason }
);

export const parseArenaRatingEntityBinding = (value: unknown): ArenaRatingEntityBinding | null => {
  const binding = recordOf(value);
  if (binding?.version !== 1) return null;
  if (binding.status === 'unbound'
    && (binding.reason === 'entity-body-mismatch' || binding.reason === 'entity-reference-unavailable')) {
    return unbound(binding.reason);
  }
  if (binding.status !== 'bound' || !Array.isArray(binding.entities) || binding.entities.length !== 2) return null;
  const entities: ArenaRatingBoundEntity[] = [];
  for (const value of binding.entities) {
    const entity = recordOf(value);
    if (!entity || (entity.entityType !== 'data_card' && entity.entityType !== 'preset')
      || !text(entity.entityId) || text(entity.entityId).length > 256
      || typeof entity.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(entity.contentDigest)
      || !(entity.updatedAt === null || typeof entity.updatedAt === 'string' && entity.updatedAt.length <= 128)
      || !(entity.authorizedUserId === null || typeof entity.authorizedUserId === 'number'
        && Number.isSafeInteger(entity.authorizedUserId) && entity.authorizedUserId > 0)
      || entity.entityType === 'data_card' && !text(entity.updatedAt)) return null;
    entities.push({ entityType: entity.entityType, entityId: text(entity.entityId),
      contentDigest: entity.contentDigest, updatedAt: entity.updatedAt as string | null,
      authorizedUserId: entity.authorizedUserId as number | null });
  }
  return { version: 1, status: 'bound', entities: entities as [ArenaRatingBoundEntity, ArenaRatingBoundEntity] };
};

// This is only a cheap read-admission filter. Settlement still owns all eligibility rules.
export const mayRequestArenaRating = (input: {
  payload: Record<string, unknown>; actorKey: string; ipAnonymized: string | null; season: ArenaSeasonContext | null;
}): boolean => {
  const { payload, season } = input;
  if (!input.ipAnonymized || !Array.isArray(payload.combatants) || payload.combatants.length !== 2) return false;
  if (payload.arenaFreeRankingEnabled === true) return true;
  if (!/^user:\d+$/u.test(input.actorKey) || !season?.authorityAvailable) return false;
  const requiredLore = new Set(season.questionnaireLorePresetIds);
  const actualLore = new Set(Array.isArray(payload.questionnaireLoreIds) ? payload.questionnaireLoreIds.map(text).filter(Boolean) : []);
  if (requiredLore.size ? requiredLore.size !== actualLore.size || [...requiredLore].some((id) => !actualLore.has(id))
    : payload.questionnaireLoreEnabled === true && !season.questionnaireLoreAllowed) return false;
  if (season.mode === 'scenario' && (!payload.scenario
    || season.scenarioPresetFilename && text(payload.scenarioFileName) !== season.scenarioPresetFilename
    || Array.isArray(payload.auxScenarios) && payload.auxScenarios.length > 0)) return false;
  return payload.mode === season.mode && payload.language === 'zh-CN'
    && text(payload.userGuidance) === season.storyGuidance
    && payload.readArenaHistory === false && payload.readCurrentState === false && payload.readNarrativeHistory === false
    && (!Array.isArray(payload.materials) || payload.materials.length === 0)
    && (!Array.isArray(payload.adjudicationEvents) || payload.adjudicationEvents.length === 0)
    && payload.combatants.every((value) => !text(recordOf(value)?.characterGuidance));
};

export const bindArenaRatingEntities = async (input: {
  payload: Record<string, unknown>;
  request: Request;
  getD1Client?: () => NodeDataD1Client | null;
  resolveAuthentication?: AuthenticationResolver;
}): Promise<ArenaRatingEntityBinding> => {
  const combatants = Array.isArray(input.payload.combatants) ? input.payload.combatants.map(recordOf) : [];
  if (combatants.length !== 2 || combatants.some((value) => !value)) return unbound('entity-reference-unavailable');
  const references = combatants.map((combatant) => ({
    entityType: combatant!.isPreset === true ? 'preset' as const : 'data_card' as const,
    entityId: combatant!.isPreset === true ? text(combatant!.filename) : text(combatant!.sourceDataCardId),
  }));
  if (references.some((ref) => !ref.entityId || ref.entityId.length > 256)) return unbound('entity-reference-unavailable');
  if (references[0]!.entityType === references[1]!.entityType && references[0]!.entityId === references[1]!.entityId) {
    return unbound('entity-body-mismatch');
  }
  const onlineIds = [...new Set(references.filter((ref) => ref.entityType === 'data_card').map((ref) => ref.entityId))];
  const rows = new Map<string, Record<string, unknown>>();
  let ownerId: number | null = null;
  try {
    if (onlineIds.length) {
      const authentication = await input.resolveAuthentication?.(input.request) ?? { status: 'anonymous' as const };
      if (authentication.status === 'denied') return unbound('entity-reference-unavailable');
      ownerId = authentication.status === 'authenticated' ? authentication.userId : null;
      const client = input.getD1Client?.();
      if (!client) return unbound('entity-reference-unavailable');
      const result = await client.prepare(`
SELECT id, type, data, updated_at
FROM data_cards
WHERE id IN (${onlineIds.map(() => '?').join(', ')})
  AND deleted_at IS NULL
  AND (user_id = ? OR (is_public = 1 AND review_status = 'approved'))
      `.trim()).bind(...onlineIds, ownerId).all({ retry: 'safe-read' });
      if (!result.success) return unbound('entity-reference-unavailable');
      for (const row of result.results) rows.set(text(row.id), row);
    }
    const entities: ArenaRatingBoundEntity[] = [];
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index]!;
      const combatant = combatants[index]!;
      const projected = projectArenaRatingIdentity(combatant.data);
      if (!projected) return unbound('entity-body-mismatch');
      const kind = inferCharacterKind(projected);
      const type = kind === 'general' ? 'general-character' : kind;
      if (combatant.type !== type) return unbound('entity-body-mismatch');
      const identityDigest = await digestArenaRatingJson(projected);
      if (reference.entityType === 'preset') {
        const preset = ARENA_PRESET_AUTHORITY.find((entry) => entry.kind === 'character' && entry.id === reference.entityId);
        if (!preset || preset.ratingIdentityDigest !== identityDigest) return unbound('entity-body-mismatch');
        entities.push({ ...reference, contentDigest: preset.versionToken, updatedAt: null, authorizedUserId: null });
      } else {
        const row = rows.get(reference.entityId);
        if (!row || row.type !== 'character' || typeof row.data !== 'string' || !text(row.updated_at)) {
          return unbound('entity-reference-unavailable');
        }
        const canonical: unknown = JSON.parse(row.data);
        if (await digestArenaRatingJson(projectArenaRatingIdentity(canonical)) !== identityDigest) return unbound('entity-body-mismatch');
        entities.push({ ...reference, contentDigest: await digestArenaRatingJson(canonical), updatedAt: text(row.updated_at),
          authorizedUserId: ownerId });
      }
    }
    return { version: 1, status: 'bound', entities: entities as [ArenaRatingBoundEntity, ArenaRatingBoundEntity] };
  } catch {
    // Do not expose private-card existence, contents, or database failure details.
    return unbound('entity-reference-unavailable');
  }
};
