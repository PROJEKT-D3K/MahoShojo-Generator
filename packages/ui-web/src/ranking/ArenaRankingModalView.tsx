'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { PublicRankingItem, PublicRankingTag as Tag } from '@mahoshojo/contracts/public-ranking';
import { getStrictRangeCheckResult } from '@mahoshojo/domain/arena-strict-range';
import { formatSeasonTitle, getCurrentSeason, rankingTransportFilters, LIVE_LEADERBOARD_TOP_RANK_LIMIT, type RankingFilters } from '@mahoshojo/domain/public-ranking';
import { TechBadge, TierBadge, buildTitleDisplay } from '../card-library';
import { useBaseModalAccessibility } from '../modal/BaseModal';
import type { RankingDetailsTarget, RankingLinkProps, RankingQueryHook, RankingRankCache } from './RankingPageView';

type Queue = 'strict' | 'free';
type Sort = 'rating' | 'tech';

export type ArenaRankingRosterEntity = { entityType: 'data_card' | 'preset'; entityId: string };
export type ArenaRankingModalViewProps = {
  isOpen: boolean;
  onClose: () => void;
  useRankingQuery: RankingQueryHook;
  Link: ComponentType<RankingLinkProps>;
  /** Only verified online cards or packaged presets supplied by the host qualify as pivots. */
  rankableRosterEntities: readonly ArenaRankingRosterEntity[];
  /** UI selection only; these keys never grant ranking eligibility. */
  selectedEntityKeys: ReadonlySet<string>;
  selectionCountLabel: string;
  onToggleEntity: (item: PublicRankingItem, nextSelected: boolean, signal: AbortSignal) => Promise<void | false>;
  /** Global host operation guard; unlike per-entity availability it also blocks removal. */
  selectionDisabledReason?: string | null;
  getEntityUnavailableReason?: (item: PublicRankingItem) => string | null;
  onSelectionError?: (message: string | null) => void;
  onOpenEntityDetails?: (target: RankingDetailsTarget) => void;
  canOpenEntityDetails?: (target: Pick<RankingDetailsTarget, 'entityType' | 'entityId'>) => boolean;
  cache?: RankingRankCache;
};

const EMPTY_ITEMS: PublicRankingItem[] = [];

export function ArenaRankingModalView({
  isOpen, onClose, useRankingQuery, Link, rankableRosterEntities, selectedEntityKeys, selectionCountLabel,
  onToggleEntity, selectionDisabledReason, getEntityUnavailableReason, onSelectionError, onOpenEntityDetails, canOpenEntityDetails, cache,
}: ArenaRankingModalViewProps) {
  const [queue, setQueue] = useState<Queue>('strict');
  const [sort, setSort] = useState<Sort>('rating');
  const [includePresets, setIncludePresets] = useState(true);
  const [strictCountableOnly, setStrictCountableOnly] = useState(false);
  const [isNative, setIsNative] = useState<'any' | '1' | '0'>('any');
  const [includeTagIds, setIncludeTagIds] = useState<string[]>([]);
  const [excludeTagIds, setExcludeTagIds] = useState<string[]>([]);
  const [isTagFilterExpanded, setIsTagFilterExpanded] = useState(false);
  const [minRating, setMinRating] = useState('');
  const [maxRating, setMaxRating] = useState('');
  const [minGames, setMinGames] = useState('');
  const [maxGames, setMaxGames] = useState('');
  const [minTechScore, setMinTechScore] = useState('');
  const [maxTechScore, setMaxTechScore] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 30;
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const cancelSelection = useCallback(() => {
    operationRef.current?.abort();
    operationRef.current = null;
    setAddingKey(null);
  }, []);
  useEffect(() => {
    if (!isOpen) {
      cancelSelection();
      setSelectionError(null);
    }
    return () => {
      operationRef.current?.abort();
      operationRef.current = null;
    };
  }, [cancelSelection, isOpen]);
  const handleClose = () => {
    cancelSelection();
    onClose();
  };
  const { dialogRef, initialFocusRef, titleId } = useBaseModalAccessibility({ isOpen, onClose: handleClose });
  const canViewDetails = (target: Pick<RankingDetailsTarget, 'entityType' | 'entityId'>) =>
    Boolean(onOpenEntityDetails) && (canOpenEntityDetails?.(target) ?? true);

  const strictRangePivotCandidate = useMemo<ArenaRankingRosterEntity | null>(() => {
    if (queue !== 'strict') return null;
    if (rankableRosterEntities.length !== 1) return null;
    return rankableRosterEntities[0] ?? null;
  }, [queue, rankableRosterEntities]);

  useEffect(() => {
    if (!strictCountableOnly) return;
    if (queue !== 'strict' || !strictRangePivotCandidate) {
      setStrictCountableOnly(false);
    }
  }, [queue, strictCountableOnly, strictRangePivotCandidate]);

  const tagsQuery = useRankingQuery({ request: { kind: 'tags' }, staleTime: 60_000, enabled: isOpen });
  const seasonsQuery = useRankingQuery({ request: { kind: 'seasons' }, staleTime: 60_000, enabled: isOpen });

  const currentSeason = useMemo(() => getCurrentSeason(seasonsQuery.data), [seasonsQuery.data]);

  const activeTags = useMemo(
    () => (tagsQuery.data?.tags ?? []).filter((t) => t.isActive),
    [tagsQuery.data?.tags],
  );

  const tagById = useMemo(() => {
    const map = new Map<string, Tag>();
    for (const tag of activeTags) map.set(tag.id, tag);
    return map;
  }, [activeTags]);

  const groupedActiveTags = useMemo(() => {
    const sorted = activeTags.slice().sort((a, b) => {
      const category = (a.category ?? '').localeCompare(b.category ?? '', 'zh-CN');
      if (category !== 0) return category;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    const map = new Map<string, Tag[]>();
    for (const tag of sorted) {
      const key = tag.category ?? '未分类';
      const list = map.get(key) ?? [];
      list.push(tag);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
  }, [activeTags]);

  const selectedTagChips = useMemo(() => {
    const chips: Array<{ mode: 'include' | 'exclude'; id: string; label: string }> = [];
    for (const id of includeTagIds) chips.push({ mode: 'include', id, label: tagById.get(id)?.name ?? id });
    for (const id of excludeTagIds) chips.push({ mode: 'exclude', id, label: tagById.get(id)?.name ?? id });
    return chips;
  }, [excludeTagIds, includeTagIds, tagById]);

  const filters = useMemo<RankingFilters>(() => ({
    queue, sort, order: 'desc', includePresets, isNative, includeTagIds, excludeTagIds,
    minRating, maxRating, minGames, maxGames, minTechScore, maxTechScore,
  }), [queue, sort, includePresets, isNative, includeTagIds, excludeTagIds,
    minRating, maxRating, minGames, maxGames, minTechScore, maxTechScore]);
  const leaderboardQuery = useRankingQuery({
    request: { kind: 'leaderboard', filters: rankingTransportFilters(filters), offset, limit },
    staleTime: 10_000,
    enabled: isOpen,
  });
  const items = leaderboardQuery.data?.items ?? EMPTY_ITEMS;

  useEffect(() => {
    if (!isOpen || items.length === 0 || !cache?.isCanonicalQuery(filters)) return;
    cache.onLiveItems({ queue, items, maxRankSeen: offset + items.length });
  }, [cache, filters, isOpen, items, offset, queue]);

  const strictRangePivotFromCurrentPage = useMemo<{ rating: number; games: number } | null>(() => {
    if (queue !== 'strict') return null;
    if (!strictCountableOnly) return null;
    if (!strictRangePivotCandidate) return null;
    const found = items.find((it) => it.entityType === strictRangePivotCandidate.entityType && it.entityId === strictRangePivotCandidate.entityId);
    if (!found) return null;
    return { rating: found.rating, games: found.games };
  }, [items, queue, strictCountableOnly, strictRangePivotCandidate]);

  const strictRangePivotRatingQuery = useRankingQuery({
    request: {
      kind: 'entityRating',
      entityType: 'data_card',
      entityId: strictRangePivotCandidate?.entityType === 'data_card' ? strictRangePivotCandidate.entityId : '',
    },
    staleTime: 30_000,
    enabled:
      isOpen &&
      queue === 'strict' &&
      strictCountableOnly &&
      strictRangePivotCandidate?.entityType === 'data_card' &&
      strictRangePivotFromCurrentPage == null,
  });

  const visibleItems = useMemo(() => {
    if (queue !== 'strict' || !strictCountableOnly) return items;
    if (!strictRangePivotCandidate) return items;

    const pivotKey = `${strictRangePivotCandidate.entityType}:${strictRangePivotCandidate.entityId}`;

    const pivotRating = strictRangePivotFromCurrentPage
      ?? (strictRangePivotCandidate.entityType === 'data_card' && strictRangePivotRatingQuery.data?.entityId === strictRangePivotCandidate.entityId
        ? { rating: strictRangePivotRatingQuery.data.rating, games: strictRangePivotRatingQuery.data.games }
        : null);

    return items.filter((it) => {
      const key = `${it.entityType}:${it.entityId}`;
      if (key === pivotKey) return false;
      if (it.entityType === 'preset' || strictRangePivotCandidate.entityType === 'preset') return true;
      if (!pivotRating) return true;
      const range = getStrictRangeCheckResult(pivotRating, { rating: it.rating, games: it.games });
      return range == null || range.exceededBy === 0;
    });
  }, [
    items,
    queue,
    strictCountableOnly,
    strictRangePivotCandidate,
    strictRangePivotFromCurrentPage,
    strictRangePivotRatingQuery.data,
  ]);

  const canGoPrev = offset > 0;
  const canGoNext = items.length >= limit && offset + limit < LIVE_LEADERBOARD_TOP_RANK_LIMIT;

  const toggleIncludeTag = (tagId: string) => {
    setOffset(0);
    setIncludeTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  };

  const toggleExcludeTag = (tagId: string) => {
    setOffset(0);
    setExcludeTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  };

  const handleToggleEntity = async (item: PublicRankingItem) => {
    if (!isOpen || selectionDisabledReason || operationRef.current) return;
    const key = `${item.entityType}:${item.entityId}`;
    const nextSelected = !selectedEntityKeys.has(key);
    if (nextSelected && getEntityUnavailableReason?.(item)) return;
    const operation = new AbortController();
    operationRef.current = operation;
    setAddingKey(key);
    setSelectionError(null);
    try {
      const result = await onToggleEntity(item, nextSelected, operation.signal);
      if (operation.signal.aborted || operationRef.current !== operation) return;
      if (result === false) {
        // The host may already have a more specific validation or capacity message.
        setSelectionError(nextSelected ? '未能加入参战，请查看参战区提示。' : '未能移除参战者，请查看参战区提示。');
        return;
      }
      // Successful admission may publish a host warning; do not overwrite it.
    } catch (error) {
      if (operation.signal.aborted || operationRef.current !== operation) return;
      const message = `❌ ${nextSelected ? '加入参战' : '移除参战者'}失败：${error instanceof Error ? error.message : '未知错误'}`;
      setSelectionError(message);
      onSelectionError?.(message);
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setAddingKey(null);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="p-5 border-b flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <div id={titleId} className="text-lg font-bold text-gray-800">排位排行榜（可加入参战）</div>
                {currentSeason ? (
                  <span className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-800 ring-1 ring-purple-200">
                    当前赛季：{formatSeasonTitle(currentSeason)}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                这里展示公共榜单（公开 + 已审核）与预设。名次仅展示 Top300；未入榜角色不展示名次。点击“加入参战”会把角色加入当前对战阵容。
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Link href="/ranking" className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                打开完整排行榜页
              </Link>
              <button
                ref={initialFocusRef}
                onClick={handleClose}
                className="px-3 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50"
              >
                关闭
              </button>
            </div>
          </div>

          <div className="p-5 overflow-auto">
            <div className="grid gap-3 md:grid-cols-6">
              <label className="text-sm text-gray-700">
                天梯
                <select
                  value={queue}
                  onChange={(e) => {
                    setOffset(0);
                    setQueue(e.target.value === 'free' ? 'free' : 'strict');
                  }}
                  className="input-field mt-1"
                >
                  <option value="strict">严格</option>
                  <option value="free">自由</option>
                </select>
              </label>
              <label className="text-sm text-gray-700">
                排序
                <select
                  value={sort}
                  onChange={(e) => {
                    setOffset(0);
                    setSort(e.target.value === 'tech' ? 'tech' : 'rating');
                  }}
                  className="input-field mt-1"
                >
                  <option value="rating">排位分</option>
                  <option value="tech">技术值</option>
                </select>
              </label>
              <label className="text-sm text-gray-700">
                原生性
                <select
                  value={isNative}
                  onChange={(e) => {
                    setOffset(0);
                    const v = e.target.value;
                    setIsNative(v === '1' ? '1' : v === '0' ? '0' : 'any');
                  }}
                  className="input-field mt-1"
                >
                  <option value="any">不限</option>
                  <option value="1">原生</option>
                  <option value="0">非原生</option>
                </select>
              </label>
              <label className="text-sm text-gray-700">
                最低分
                <input
                  type="number"
                  value={minRating}
                  onChange={(e) => {
                    setOffset(0);
                    setMinRating(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="如 800"
                />
              </label>
              <label className="text-sm text-gray-700">
                最高分
                <input
                  type="number"
                  value={maxRating}
                  onChange={(e) => {
                    setOffset(0);
                    setMaxRating(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="如 1500"
                />
              </label>
              <label className="text-sm text-gray-700">
                最少对局
                <input
                  type="number"
                  value={minGames}
                  onChange={(e) => {
                    setOffset(0);
                    setMinGames(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="如 5"
                />
              </label>
              <label className="text-sm text-gray-700">
                最多对局
                <input
                  type="number"
                  value={maxGames}
                  onChange={(e) => {
                    setOffset(0);
                    setMaxGames(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="可留空"
                />
              </label>
              <label className="text-sm text-gray-700">
                最低技术值
                <input
                  type="number"
                  value={minTechScore}
                  onChange={(e) => {
                    setOffset(0);
                    setMinTechScore(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="0-100"
                />
              </label>
              <label className="text-sm text-gray-700">
                最高技术值
                <input
                  type="number"
                  value={maxTechScore}
                  onChange={(e) => {
                    setOffset(0);
                    setMaxTechScore(e.target.value);
                  }}
                  className="input-field mt-1"
                  placeholder="0-100"
                />
              </label>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-wrap items-center gap-4">
              <label className="text-sm text-gray-700 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includePresets}
                  onChange={(e) => {
                    setOffset(0);
                    setIncludePresets(e.target.checked);
                  }}
                />
                <span>包含预设</span>
              </label>

              <label
                className={[
                  'text-sm text-gray-700 flex items-center gap-2',
                  (queue !== 'strict' || !strictRangePivotCandidate) ? 'opacity-60' : '',
                ].join(' ')}
                title={
                  queue !== 'strict'
                    ? '仅严格天梯可用'
                    : (!strictRangePivotCandidate ? '需先在参战列表中只保留 1 位参战者作为我方' : '按严格分差规则预筛对手（花牌及以上启用分差限制，任一方不足 10 局时上限为 400）')
                }
              >
                <input
                  type="checkbox"
                  checked={strictCountableOnly}
                  onChange={(e) => {
                    setOffset(0);
                    setStrictCountableOnly(e.target.checked);
                  }}
                  disabled={queue !== 'strict' || !strictRangePivotCandidate}
                />
                <span>严格分差预筛</span>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-xs text-gray-500">标签筛选只作用于数据卡；预设不会被标签包含/排除。</div>
              <button
                type="button"
                onClick={() => setIsTagFilterExpanded((prev) => !prev)}
                className="text-xs font-medium text-blue-600 hover:underline"
                aria-expanded={isTagFilterExpanded}
              >
                {isTagFilterExpanded ? '收起标签' : '展开标签'}
              </button>
            </div>
          </div>

          <div className="mt-1 text-xs text-gray-500">
            仅预筛当前页的分差，冷却与每日限额等不在此预判；最终计分仍由服务器判定。
          </div>

          <div className="mt-3">
            {!isTagFilterExpanded ? (
              <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
                  <div>
                    包含 {includeTagIds.length} · 排除 {excludeTagIds.length}
                  </div>
                  {(includeTagIds.length > 0 || excludeTagIds.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setOffset(0);
                        setIncludeTagIds([]);
                        setExcludeTagIds([]);
                      }}
                      className="text-xs font-medium text-gray-500 hover:text-gray-700 hover:underline"
                    >
                      清空标签
                    </button>
                  )}
                </div>

                {(includeTagIds.length > 0 || excludeTagIds.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedTagChips.slice(0, 12).map((chip) => (
                      <button
                        key={`${chip.mode}:${chip.id}`}
                        type="button"
                        onClick={() => {
                          if (chip.mode === 'include') toggleIncludeTag(chip.id);
                          else toggleExcludeTag(chip.id);
                        }}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                          chip.mode === 'include'
                            ? 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100'
                            : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                        }`}
                        title="点击移除"
                      >
                        {chip.label}
                      </button>
                    ))}
                    {selectedTagChips.length > 12 && (
                      <div className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-500">
                        还有 {selectedTagChips.length - 12} 个…
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : tagsQuery.isLoading ? (
              <div className="text-sm text-gray-500">正在加载标签库...</div>
            ) : tagsQuery.isError ? (
              <div className="text-sm text-red-600">标签库加载失败：{String(tagsQuery.error)}</div>
            ) : activeTags.length === 0 ? (
              <div className="text-sm text-gray-500">暂无可用标签</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold text-gray-700 mb-2">包含标签（OR）</div>
                  <div className="max-h-56 overflow-auto pr-1 space-y-3">
                    {groupedActiveTags.map(([category, categoryTags]) => (
                      <div key={`include:${category}`}>
                        <div className="text-[11px] font-medium text-gray-600">
                          {category}（{categoryTags.length}）
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {categoryTags.map((tag) => (
                            <button
                              key={`include:${tag.id}`}
                              type="button"
                              onClick={() => toggleIncludeTag(tag.id)}
                              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                                includeTagIds.includes(tag.id)
                                  ? 'bg-purple-600 text-white border-purple-600'
                                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                              }`}
                              title={tag.description ?? undefined}
                            >
                              {tag.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-gray-700 mb-2">排除标签</div>
                  <div className="max-h-56 overflow-auto pr-1 space-y-3">
                    {groupedActiveTags.map(([category, categoryTags]) => (
                      <div key={`exclude:${category}`}>
                        <div className="text-[11px] font-medium text-gray-600">
                          {category}（{categoryTags.length}）
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {categoryTags.map((tag) => (
                            <button
                              key={`exclude:${tag.id}`}
                              type="button"
                              onClick={() => toggleExcludeTag(tag.id)}
                              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                                excludeTagIds.includes(tag.id)
                                  ? 'bg-red-600 text-white border-red-600'
                                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                              }`}
                              title={tag.description ?? undefined}
                            >
                              {tag.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-5">
            {leaderboardQuery.isLoading ? (
              <div className="text-sm text-gray-500">正在加载排行榜...</div>
            ) : leaderboardQuery.isError ? (
              <div className="text-sm text-red-600">加载失败：{String(leaderboardQuery.error)}</div>
            ) : (
              <div className="overflow-auto rounded-lg border border-gray-200">
                {queue === 'strict' && strictCountableOnly && strictRangePivotCandidate?.entityType === 'data_card' && strictRangePivotFromCurrentPage == null ? (
                  strictRangePivotRatingQuery.isLoading ? (
                    <div className="px-3 py-2 text-xs text-gray-500 border-b">
                      正在读取我方排位分，用于严格分差预筛…
                    </div>
                  ) : strictRangePivotRatingQuery.isError ? (
                    <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-b">
                      无法读取我方排位分，已降级为不筛选严格范围：{String(strictRangePivotRatingQuery.error)}
                    </div>
                  ) : null
                ) : null}
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr className="text-left text-gray-600 border-b">
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">角色</th>
                      <th className="py-2 px-3">段位</th>
                      <th className="py-2 px-3">分</th>
                      <th className="py-2 px-3">局</th>
                      <th className="py-2 px-3">W/L/D</th>
                      <th className="py-2 px-3">技术</th>
                      <th className="py-2 px-3">原生</th>
                      <th className="py-2 px-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => {
                      const isSelected = selectedEntityKeys.has(`${item.entityType}:${item.entityId}`);
                      const unavailableReason = selectionDisabledReason ?? (isSelected ? null : getEntityUnavailableReason?.(item));
                      const isBusy = addingKey === `${item.entityType}:${item.entityId}`;
                      const { display: displayName, full: fullName } = buildTitleDisplay(item.displayName || '未命名');
                      const authorName =
                        item.entityType === 'preset'
                          ? '官方'
                          : typeof item.authorName === 'string' && item.authorName.trim()
                            ? item.authorName.trim()
                            : '未知';
                      const nativeBadge = item.isNative == null ? (
                        <span className="text-gray-500">-</span>
                      ) : item.isNative ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
                          原生
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200">
                          非原生
                        </span>
                      );
                      return (
                        <tr key={`${item.entityType}:${item.entityId}`} className="border-b last:border-b-0">
                          <td className="py-2 px-3 text-gray-500">{item.rank}</td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => {
                                const winRate = item.games > 0 ? Math.round((item.wins / item.games) * 1000) / 10 : null;
                                const detailsNotice = `当前榜单：#${item.rank} · 段位 ${item.tier} · 分 ${item.rating} · 局 ${item.games} · W/L/D ${item.wins}/${item.losses}/${item.draws}${winRate == null ? '' : ` · 胜率 ${winRate}%`}`;
                                onOpenEntityDetails?.({
                                  entityType: item.entityType,
                                  entityId: item.entityId,
                                  displayName: item.displayName,
                                  authorName: item.authorName,
                                  pendingNotice: detailsNotice,
                                });
                              }}
                              disabled={!canViewDetails(item)}
                              className="block w-full text-left font-medium text-gray-800 hover:underline underline-offset-2 disabled:no-underline"
                              aria-label={`查看角色详情：${fullName}`}
                              title={fullName}
                            >
                              {displayName}
                            </button>
                            <div className="text-xs text-gray-500">
                              {item.entityType === 'preset' ? '预设' : '数据卡'} · 作者：{authorName}
                            </div>
                          </td>
                          <td className="py-2 px-3"><TierBadge tier={item.tier} /></td>
                          <td className="py-2 px-3 font-mono">{item.rating}</td>
                          <td className="py-2 px-3 font-mono">{item.games}</td>
                          <td className="py-2 px-3 font-mono">{item.wins}/{item.losses}/{item.draws}</td>
                          <td className="py-2 px-3"><TechBadge techScore={item.techScore} techLevel={item.techLevel} /></td>
                          <td className="py-2 px-3">{nativeBadge}</td>
                          <td className="py-2 px-3">
                            <button
                              onClick={() => void handleToggleEntity(item)}
                              disabled={addingKey !== null || Boolean(unavailableReason)}
                              className={`px-3 py-1 rounded text-xs border ${
                                isSelected
                                  ? 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
                                  : 'bg-purple-600 border-purple-600 text-white hover:bg-purple-700'
                              } disabled:opacity-50`}
                              title={unavailableReason ?? (isSelected ? '再次点击可移除参战者' : undefined)}
                            >
                              {isBusy ? '处理中...' : isSelected ? '移除/已加入' : '加入参战'}
                            </button>
                            {unavailableReason ? <div className="mt-1 text-xs text-gray-500">{unavailableReason}</div> : null}
                          </td>
                        </tr>
                      );
                    })}
                    {visibleItems.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-gray-500">
                          {queue === 'strict' && strictCountableOnly && items.length > 0
                            ? '本页暂无符合严格分差预筛的对手，可尝试翻页或调整筛选'
                            : '暂无数据'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {selectionError ? <div role="alert" className="mt-3 text-sm text-red-600">{selectionError}</div> : null}

          <div className="mt-4 flex items-center justify-between gap-3 flex-wrap text-sm">
            <div className="text-gray-500">
              已选择参战者：{selectionCountLabel}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setOffset((v) => Math.max(0, v - limit))}
                disabled={!canGoPrev}
                className="px-3 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-white"
              >
                上一页
              </button>
              <button
                onClick={() => setOffset((v) => v + limit)}
                disabled={!canGoNext}
                className="px-3 py-1 rounded border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:hover:bg-white"
              >
                下一页
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </>
  );
}
