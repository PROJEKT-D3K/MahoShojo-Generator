'use client';

import { COMBATANT_TYPE_LABELS } from '@mahoshojo/domain/arena-file-parser';
import { ArenaCombatantTags, ArenaCombatantTechScore } from '@mahoshojo/ui-web/arena';

import { useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArenaRankingQueueFeedback } from '@mahoshojo/ui-web/arena';

import { TierBadge } from '@/components/ranking/TierBadge';
import { TechBadge } from '@/components/ranking/TechBadge';
import { computeEloExpectedScore } from '@/lib/arena/elo';
import { authStorage } from '@/lib/auth';
import { downloadBlob } from '@/lib/client/blobUrl';
import { computeTechIndex } from '@/lib/metrics/techIndex';
import {
  parseGenerationRankingResponse,
  requireGenerationRankingResponse,
  type GenerationRankingParticipant,
} from '@/lib/arena/generation-ranking';

import { useBattleActions } from '../../../hooks/useBattleActions';
import { getArenaRosterCombatantKey as getCombatantKey, useBattleStore } from '../../../stores/useBattleStore';
import { formatCombatantCount, isCombatantLimitReached } from '../../../types';
import type { CombatantData } from '../../../types';
import { getCombatantDisplayName } from '../../../utils/characterValidator';
import {
  GENERATION_RANKING_MAX_ATTEMPTS,
  GENERATION_RANKING_MAX_DURATION_MS,
  getGenerationRankingRefetchInterval,
  shouldEnableGenerationRankingRecovery,
} from '../../../utils/generation-ranking-polling';
import type {
  ArenaRosterRowExtras,
  ArenaRosterRowView,
  ArenaRosterSectionModel,
  ArenaRosterTeamView,
} from './roster-contract';

type Queue = 'strict' | 'free';

type ApiRating = {
  queue: Queue;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  tier: string;
};

type EloWinRatePrediction = {
  queue: Queue;
  expectedScore: number;
  expectedPct: number;
  selfRating: number;
  opponentRating: number;
};

type DataCardMetaResponse = {
  success: boolean;
  metrics: { techScore: number; techLevel: string } | null;
  ratings: { strict: ApiRating | null; free: ApiRating | null };
};

type PresetMetaResponse = {
  success: boolean;
  ratings: { strict: ApiRating | null; free: ApiRating | null };
};

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  const json = (await res.json()) as T;
  if (!res.ok) {
    const errorMessage =
      typeof (json as any)?.error === 'string' ? (json as any).error : `HTTP ${res.status}: ${JSON.stringify(json)}`;
    throw new Error(errorMessage);
  }
  return json;
};

const toFiniteNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const buildEntityKeyForCombatant = (combatant: CombatantData): string | null => {
  if (combatant.isPreset) {
    const id = (combatant.filename ?? '').toString().trim();
    return id ? `preset:${id}` : null;
  }
  const id = (combatant.sourceDataCardId ?? '').toString().trim();
  return id ? `data_card:${id}` : null;
};

const pickTierBadge = (ratings?: { strict: ApiRating | null; free: ApiRating | null } | null): { tier: string; label: string } | null => {
  if (ratings?.strict?.tier) return { tier: ratings.strict.tier, label: '严格' };
  if (ratings?.free?.tier) return { tier: ratings.free.tier, label: '自由' };
  return null;
};

const TEAM_KEY_PREFIX = 'team:';

const teamIdFromKey = (key: string): number => Number(key.slice(TEAM_KEY_PREFIX.length));

/**
 * 单人 roster/分队 adapter：把 battle store 与排位/技术值增强逻辑
 * 映射为共享 ArenaRosterSection 消费的 ArenaRosterSectionModel。
 */
export const useSoloRosterSectionModel = (input: {
  onShowDetails: (combatant: CombatantData) => void;
}): ArenaRosterSectionModel => {
  const { onShowDetails } = input;
  const queryClient = useQueryClient();
  const combatants = useBattleStore((state) => state.combatants);
  const teams = useBattleStore((state) => state.teams);
  const isGenerating = useBattleStore((state) => state.isGenerating);
  const lastGenerationId = useBattleStore((state) => state.lastGenerationId);
  const removeCombatant = useBattleStore((state) => state.removeCombatant);
  const moveCombatant = useBattleStore((state) => state.moveCombatant);
  const addTeam = useBattleStore((state) => state.addTeam);
  const removeTeam = useBattleStore((state) => state.removeTeam);
  const renameTeam = useBattleStore((state) => state.renameTeam);
  const toggleTeamCollapsed = useBattleStore((state) => state.toggleTeamCollapsed);
  const updateCombatantTeam = useBattleStore((state) => state.updateCombatantTeam);
  const updateCombatantCharacterGuidance = useBattleStore((state) => state.updateCombatantCharacterGuidance);
  const { handleAddRandomPlaceholder, handleClearRoster } = useBattleActions();

  const [copiedStatus, setCopiedStatus] = useState<Record<string, boolean>>({});
  const generationRankingPollingRef = useRef({ generationId: '', startedAt: 0, attemptCount: 0 });

  const downloadJson = (combatant: CombatantData) => {
    const jsonData = JSON.stringify(combatant.data, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    const baseName = getCombatantDisplayName(combatant.data);
    downloadBlob(blob, `${baseName}_修正版.json`);
  };

  const copyJson = async (combatant: CombatantData) => {
    const jsonData = JSON.stringify(combatant.data, null, 2);
    await navigator.clipboard.writeText(jsonData);
    setCopiedStatus((prev) => ({ ...prev, [getCombatantKey(combatant)]: true }));
    setTimeout(() => {
      setCopiedStatus((prev) => ({ ...prev, [getCombatantKey(combatant)]: false }));
    }, 2000);
  };

  const readableCombatants = useMemo(
    () => combatants.filter((c): c is CombatantData => 'data' in c),
    [combatants],
  );

  const techByCombatantKey = useMemo(() => {
    const map = new Map<string, { techScore: number; techLevel: string }>();
    for (const combatant of readableCombatants) {
      const key = getCombatantKey(combatant);
      try {
        const result = computeTechIndex(combatant.data);
        map.set(key, { techScore: result.techScore, techLevel: result.techLevel });
      } catch {
        // 技术值用于增强显示，失败不影响主流程
      }
    }
    return map;
  }, [readableCombatants]);

  const metaTargets = useMemo(() => {
    return readableCombatants
      .map((combatant) => {
        const entityKey = buildEntityKeyForCombatant(combatant);
        if (!entityKey) return null;
        if (combatant.isPreset) {
          return {
            entityKey,
            kind: 'preset' as const,
            id: combatant.filename,
          };
        }
        const dataCardId = combatant.sourceDataCardId;
        if (!dataCardId) return null;
        return {
          entityKey,
          kind: 'data_card' as const,
          id: dataCardId,
        };
      })
      .filter(Boolean) as Array<{ entityKey: string; kind: 'data_card' | 'preset'; id: string }>;
  }, [readableCombatants]);

  const metaQueries = useQueries({
    queries: metaTargets.map((target) => {
      if (target.kind === 'preset') {
        return {
          queryKey: ['arenaPresetMeta', target.id],
          queryFn: () => fetchJson<PresetMetaResponse>(`/api/arena/preset-meta?entityId=${encodeURIComponent(target.id)}`),
          staleTime: 60_000,
        };
      }
      return {
        queryKey: ['arenaDataCardMeta', target.id],
        queryFn: async () => {
          const authHeader = await authStorage.getAuthHeader();
          const headers: Record<string, string> = {};
          if (authHeader) headers.Authorization = authHeader;
          return fetchJson<DataCardMetaResponse>(
            `/api/data-card-meta?dataCardId=${encodeURIComponent(target.id)}`,
            Object.keys(headers).length > 0 ? { headers } : undefined,
          );
        },
        staleTime: 60_000,
      };
    }),
  });

  const metaByEntityKey = useMemo(() => {
    const map = new Map<string, { ratings: { strict: ApiRating | null; free: ApiRating | null }; tech?: { techScore: number; techLevel: string } | null }>();
    metaTargets.forEach((target, index) => {
      const data = metaQueries[index]?.data as any;
      const ratings = (data?.ratings ?? { strict: null, free: null }) as { strict: ApiRating | null; free: ApiRating | null };
      const tech = (data?.metrics ?? null) as { techScore: number; techLevel: string } | null;
      map.set(target.entityKey, { ratings, tech });
    });
    return map;
  }, [metaQueries, metaTargets]);

  const generationRankingQueryKey = ['arenaGenerationRanking', lastGenerationId] as const;
  const cachedGenerationRanking = parseGenerationRankingResponse(
    queryClient.getQueryData<unknown>(generationRankingQueryKey),
  );
  const hasTerminalRanking = Boolean(
    cachedGenerationRanking?.success
      && cachedGenerationRanking.state === 'ready'
      && Array.isArray(cachedGenerationRanking.participants)
      && !cachedGenerationRanking.participants.some((participant) =>
        (participant.queues.strict.eligible && ['missing', 'pending'].includes(participant.queues.strict.eventStatus))
        || (participant.queues.free.eligible && ['missing', 'pending'].includes(participant.queues.free.eventStatus)),
      ),
  );
  const generationRankingRecoveryEnabled = shouldEnableGenerationRankingRecovery({
    generationId: lastGenerationId,
    isGenerating,
    hasTerminalRanking,
  });

  const generationRankingQuery = useQuery({
    queryKey: generationRankingQueryKey,
    queryFn: async ({ signal }) => {
      const generationId = lastGenerationId as string;
      if (generationRankingPollingRef.current.generationId !== generationId) {
        generationRankingPollingRef.current = { generationId, startedAt: Date.now(), attemptCount: 0 };
      }
      generationRankingPollingRef.current.attemptCount += 1;
      const payload = await fetchJson<unknown>(
        `/api/arena/generation-ranking?generationId=${encodeURIComponent(lastGenerationId as string)}`,
        { signal },
      );
      return requireGenerationRankingResponse(payload);
    },
    enabled: generationRankingRecoveryEnabled,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const data = parseGenerationRankingResponse(query.state.data);
      let pending = Boolean(data?.success && data.state === 'pending');
      if (data?.success && data.state === 'ready') {
        pending = data.participants.some((p) =>
          (p.queues.strict.eligible && (p.queues.strict.eventStatus === 'missing' || p.queues.strict.eventStatus === 'pending')) ||
          (p.queues.free.eligible && (p.queues.free.eventStatus === 'missing' || p.queues.free.eventStatus === 'pending')),
        );
      }
      const polling = generationRankingPollingRef.current;
      return getGenerationRankingRefetchInterval({
        enabled: generationRankingRecoveryEnabled,
        pending,
        attemptCount: polling.attemptCount,
        elapsedMs: polling.startedAt > 0 ? Date.now() - polling.startedAt : 0,
      });
    },
  });
  const generationRankingData = parseGenerationRankingResponse(generationRankingQuery.data);

  const generationParticipantByEntityKey = useMemo(() => {
    const map = new Map<string, GenerationRankingParticipant>();
    const data = generationRankingData;
    if (!data || !data.success || data.state !== 'ready') return map;
    data.participants.forEach((p) => {
      if (typeof p.entityKey === 'string' && p.entityKey.trim()) {
        map.set(p.entityKey.trim(), p);
      }
    });
    return map;
  }, [generationRankingData]);

  const generationRankingPollingStopped = (() => {
    const data = generationRankingData;
    if (!data?.success) return false;
    const pending = data.state === 'pending' || (data.state === 'ready' && data.participants.some((participant) =>
      (participant.queues.strict.eligible && ['missing', 'pending'].includes(participant.queues.strict.eventStatus))
      || (participant.queues.free.eligible && ['missing', 'pending'].includes(participant.queues.free.eventStatus)),
    ));
    if (!pending) return false;
    const polling = generationRankingPollingRef.current;
    return polling.attemptCount >= GENERATION_RANKING_MAX_ATTEMPTS
      || (polling.startedAt > 0 && Date.now() - polling.startedAt >= GENERATION_RANKING_MAX_DURATION_MS);
  })();

  const eloPredictionByCombatantKey = useMemo(() => {
    const map = new Map<string, EloWinRatePrediction>();

    if (combatants.length !== 2 || readableCombatants.length !== 2) return map;

    const [player, opponent] = readableCombatants;
    const playerKey = getCombatantKey(player);
    const opponentKey = getCombatantKey(opponent);

    const playerEntityKey = buildEntityKeyForCombatant(player);
    const opponentEntityKey = buildEntityKeyForCombatant(opponent);
    if (!playerEntityKey || !opponentEntityKey) return map;

    const playerMeta = metaByEntityKey.get(playerEntityKey);
    const opponentMeta = metaByEntityKey.get(opponentEntityKey);

    const playerParticipant = generationParticipantByEntityKey.get(playerEntityKey);
    const opponentParticipant = generationParticipantByEntityKey.get(opponentEntityKey);

    const playerStrict = toFiniteNumber(playerParticipant?.queues.strict.rating ?? playerMeta?.ratings.strict?.rating);
    const opponentStrict = toFiniteNumber(opponentParticipant?.queues.strict.rating ?? opponentMeta?.ratings.strict?.rating);
    const playerFree = toFiniteNumber(playerParticipant?.queues.free.rating ?? playerMeta?.ratings.free?.rating);
    const opponentFree = toFiniteNumber(opponentParticipant?.queues.free.rating ?? opponentMeta?.ratings.free?.rating);

    const queueToUse: Queue | null = playerStrict != null && opponentStrict != null ? 'strict' : playerFree != null && opponentFree != null ? 'free' : null;
    if (!queueToUse) return map;

    const playerRating = queueToUse === 'strict' ? playerStrict : playerFree;
    const opponentRating = queueToUse === 'strict' ? opponentStrict : opponentFree;
    if (playerRating == null || opponentRating == null) return map;

    const playerExpectedScore = computeEloExpectedScore(playerRating, opponentRating);
    const opponentExpectedScore = computeEloExpectedScore(opponentRating, playerRating);

    map.set(playerKey, {
      queue: queueToUse,
      expectedScore: playerExpectedScore,
      expectedPct: Math.round(playerExpectedScore * 100),
      selfRating: playerRating,
      opponentRating,
    });

    map.set(opponentKey, {
      queue: queueToUse,
      expectedScore: opponentExpectedScore,
      expectedPct: Math.round(opponentExpectedScore * 100),
      selfRating: opponentRating,
      opponentRating: playerRating,
    });

    return map;
  }, [combatants.length, generationParticipantByEntityKey, metaByEntityKey, readableCombatants]);

  const rows = useMemo<ArenaRosterRowView[]>(() => combatants.map((combatant, index) => {
    const isPlaceholder = 'id' in combatant;
    const key = getCombatantKey(combatant);
    return Object.freeze({
      key,
      displayName: isPlaceholder ? combatant.filename : getCombatantDisplayName(combatant.data),
      typeLabel: isPlaceholder
        ? (combatant.type === 'random-magical-girl' ? '随机魔法少女' : '随机残兽')
        : COMBATANT_TYPE_LABELS[combatant.type],
      guidance: isPlaceholder ? '' : (combatant.characterGuidance ?? ''),
      index,
      teamKey: combatant.teamId ? `${TEAM_KEY_PREFIX}${combatant.teamId}` : null,
      isPlaceholder,
    });
  }), [combatants]);

  const teamViews = useMemo<ArenaRosterTeamView[]>(() => teams.map((team) => Object.freeze({
    key: `${TEAM_KEY_PREFIX}${team.id}`,
    name: team.name,
    memberKeys: Object.freeze(rows
      .filter((row) => row.teamKey === `${TEAM_KEY_PREFIX}${team.id}`)
      .map((row) => row.key)),
    collapsed: team.isCollapsed,
  })), [rows, teams]);

  const rowExtras = (row: ArenaRosterRowView): ArenaRosterRowExtras | undefined => {
    const combatant = combatants.find((item) => getCombatantKey(item) === row.key);
    if (!combatant || 'id' in combatant) return undefined;
    const data = combatant;
    const entityKey = buildEntityKeyForCombatant(data);
    const meta = entityKey ? metaByEntityKey.get(entityKey) : null;
    const tierBadge = meta ? pickTierBadge(meta.ratings) : null;
    const localTech = techByCombatantKey.get(row.key) ?? null;
    const techLevel = meta?.tech?.techLevel ?? localTech?.techLevel ?? null;
    const techScore = meta?.tech?.techScore ?? localTech?.techScore ?? null;
    const generationParticipant = entityKey ? generationParticipantByEntityKey.get(entityKey) : null;
    const generationTier = generationParticipant?.queues.strict.tier ?? generationParticipant?.queues.free.tier ?? null;
    const generationTierLabel =
      generationParticipant?.queues.strict.tier ? '严格' : (generationParticipant?.queues.free.tier ? '自由' : '');
    const tierToShow = generationTier ?? tierBadge?.tier ?? (entityKey ? '无牌' : '未登记');
    const tierLabelToShow = generationTier ? generationTierLabel : (tierBadge?.label ?? '');
    const prediction = eloPredictionByCombatantKey.get(row.key);

    return {
      tags: <ArenaCombatantTags combatant={data} />,
      copied: Boolean(copiedStatus[getCombatantKey(data)]),
      onShowDetails: () => onShowDetails(data),
      onDownload: data.wasCorrected ? () => downloadJson(data) : undefined,
      onCopy: data.wasCorrected ? () => { void copyJson(data); } : undefined,
      rankingBadge: tierToShow ? (
        <span className="flex flex-wrap items-center gap-1 min-w-0">
          <TierBadge tier={tierToShow} />
          {typeof techLevel === 'string' && techLevel.trim() ? (
            <TechBadge mode="level" techScore={techScore} techLevel={techLevel} />
          ) : null}
          {tierLabelToShow ? <span className="text-[10px] text-gray-500">({tierLabelToShow})</span> : null}
        </span>
      ) : undefined,
      ranking: (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <ArenaCombatantTechScore techScore={techScore} />
            <ArenaRankingQueueFeedback queue="strict" result={generationParticipant?.queues.strict ?? null} fallbackRating={meta?.ratings.strict?.rating} />
            <ArenaRankingQueueFeedback queue="free" result={generationParticipant?.queues.free ?? null} fallbackRating={meta?.ratings.free?.rating} />
            {(() => {
              if (!prediction) return null;
              const queueLabel = prediction.queue === 'strict' ? '严格' : '自由';
              const title = `预计胜率（Elo · ${queueLabel}）：${prediction.expectedPct}%（${prediction.selfRating} vs ${prediction.opponentRating}）`;
              return (
                <span className="whitespace-nowrap" title={title}>
                  预计胜率：<span className="font-mono font-semibold text-sky-700">{prediction.expectedPct}%</span>
                  <span className="ml-1 text-gray-500">（{queueLabel}）</span>
                </span>
              );
            })()}
          </div>
          {!entityKey ? (
            <div className="mt-0.5 text-[11px] text-gray-500">提示：未登记为数据卡/预设时，无法参与排位计分。</div>
          ) : entityKey && lastGenerationId && !generationParticipant && generationRankingData?.success && generationRankingData.state === 'pending' ? (
            <div className="mt-0.5 text-[11px] text-gray-500">
              {generationRankingPollingStopped ? '排位结果暂未就绪，已停止自动查询。' : '排位结算中…（可能需要几秒钟）'}
              {generationRankingPollingStopped ? (
                <button
                  type="button"
                  className="ml-1 text-sky-700 hover:underline"
                  onClick={() => {
                    generationRankingPollingRef.current = {
                      generationId: lastGenerationId,
                      startedAt: Date.now(),
                      attemptCount: 0,
                    };
                    void generationRankingQuery.refetch();
                  }}
                >
                  手动刷新
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ),
    };
  };

  return {
    rows,
    teams: teamViews,
    capabilities: {
      reorderRows: true,
      removeRows: true,
      editGuidance: true,
      ranking: true,
      addPlaceholders: true,
      clearRoster: true,
      createTeams: true,
      renameTeams: true,
      removeTeams: true,
      reorderTeams: false,
      assignTeamMembers: true,
      reorderTeamMembers: false,
      collapseTeams: true,
    },
    disabled: isGenerating,
    combatantCountLabel: formatCombatantCount(combatants.length),
    combatantCapReached: isCombatantLimitReached(combatants.length),
    rowExtras,
    actions: {
      moveRow: moveCombatant,
      removeRow: (key) => removeCombatant({ rosterKey: key }),
      setGuidance: (key, value) => updateCombatantCharacterGuidance({ rosterKey: key }, value),
      addPlaceholder: handleAddRandomPlaceholder,
      clearRoster: handleClearRoster,
      createTeam: () => `${TEAM_KEY_PREFIX}${addTeam()}`,
      renameTeam: (key, name) => renameTeam(teamIdFromKey(key), name),
      removeTeam: (key) => removeTeam(teamIdFromKey(key)),
      moveTeam: () => undefined,
      assignCombatant: (combatantKey, teamKey) => updateCombatantTeam({ rosterKey: combatantKey }, teamKey ? teamIdFromKey(teamKey) : null),
      moveTeamMember: () => undefined,
      toggleTeamCollapsed: (key) => toggleTeamCollapsed(teamIdFromKey(key)),
    },
  };
};
