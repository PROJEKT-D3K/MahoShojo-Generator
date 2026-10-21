import { isArenaRealCombatant } from './roster-types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ARENA_CANONICAL_CAPABILITIES } from '@mahoshojo/contracts/arena-capabilities';
import type { PublicEntityRating } from '@mahoshojo/contracts/public-ranking';
import { predictArenaPair, type ArenaQueueRatings } from '@mahoshojo/domain/arena-elo';
import { readDesktopRanking } from '../ranking/use-ranking-query';
import { isDesktopStrictSource } from './strict-source';
import type { ArenaDraft } from './session';

type Entity = { entityType: 'preset' | 'data_card'; entityId: string };
type Target = Entity & { key: string; observationKey: string };
export type RosterRatingObservation = ArenaQueueRatings & { failed: boolean; tiers: { strict: PublicEntityRating['tier']; free: PublicEntityRating['tier'] } };
type Reader = (request: Entity & { kind: 'entityRating'; queue: 'strict' | 'free' }, signal: AbortSignal) => Promise<PublicEntityRating>;
const emptyRatings: ReadonlyMap<string, RosterRatingObservation> = new Map();
const STALE_MS = 60_000;

/** 身份只来自当前可信选择路径，不从正文扩展/历史缓存猜测在线身份。 */
export function projectRosterRatingTargets(combatants: ArenaDraft['combatants']): readonly (Target | null)[] {
  if (combatants.length > ARENA_CANONICAL_CAPABILITIES.maxCombatants) return combatants.map(() => null);
  return combatants.map(card => {
    if (!isArenaRealCombatant(card) || !isDesktopStrictSource(card)) return null;
    const entityType = card.desktopSource === 'preset' ? 'preset' : 'data_card';
    const entityId = entityType === 'preset' ? card.filename : card.sourceDataCardId!.trim();
    const key = `${entityType}:${entityId}`;
    return { entityType, entityId, key, observationKey: JSON.stringify([key, card.sourceDataCardUpdatedAt ?? null, card.data]) };
  });
}

/** 只读实体观察值。无轮询，无本地持久化，不改变 Strict 准入与模型请求。 */
export function useDesktopRosterRatings(combatants: ArenaDraft['combatants'], scope: string, enabled: boolean, read: Reader = readDesktopRanking) {
  const projected = useMemo(() => projectRosterRatingTargets(combatants), [combatants]);
  const key = JSON.stringify([scope, enabled, projected.map(target => target?.observationKey ?? null)]);
  const inFlight = useRef(new Set<Promise<void>>());
  const latestTargets = useRef(projected); latestTargets.current = projected;
  const cache = useMemo(() => new Map<string, { at: number; value: RosterRatingObservation }>(), [scope]);
  const [state, setState] = useState<{ key: string; ratings: ReadonlyMap<string, RosterRatingObservation> }>({ key: '', ratings: emptyRatings });
  useEffect(() => {
    const targets = latestTargets.current;
    const active = new Set(targets.flatMap(target => target ? [target.observationKey] : []));
    for (const cachedKey of cache.keys()) if (!active.has(cachedKey)) cache.delete(cachedKey);
    if (!enabled) { setState({ key, ratings: emptyRatings }); return; }
    const controller = new AbortController();
    const ratings = new Map<string, RosterRatingObservation>();
    const unique = new Map(targets.flatMap(target => target ? [[target.key, target] as const] : []));
    const pending: Target[] = [];
    for (const target of unique.values()) {
      const cached = cache.get(target.observationKey);
      if (cached && Date.now() - cached.at < STALE_MS) ratings.set(target.key, cached.value);
      else pending.push(target);
    }
    setState({ key, ratings: new Map(ratings) });
    const work = pending.flatMap(target => (['strict', 'free'] as const).map(queue => ({ target, queue })));
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const task = work[cursor++];
        if (!task) return;
        const value = ratings.get(task.target.key) ?? { strict: null, free: null, failed: false, tiers: { strict: null, free: null } };
        ratings.set(task.target.key, value);
        try {
          // IPC 发出后 AbortSignal 只能拒收，不能取消原生 HTTP；跨轮也共享四个在飞槽。
          while (inFlight.current.size >= 4) await Promise.race(inFlight.current);
          if (controller.signal.aborted) return;
          const request = Promise.resolve().then(() => read({ kind: 'entityRating', entityType: task.target.entityType, entityId: task.target.entityId, queue: task.queue }, controller.signal));
          const settled = request.then(() => undefined, () => undefined);
          inFlight.current.add(settled);
          let result: PublicEntityRating;
          try { result = await request; } finally { inFlight.current.delete(settled); }
          if (controller.signal.aborted) return;
          // 服务的 found=false 会返回初始 1000；这里必须保留“没有评分”的语义。
          value[task.queue] = result.found && Number.isFinite(result.rating) ? result.rating : null;
          value.tiers[task.queue] = result.found ? result.tier ?? null : null;
        } catch {
          if (controller.signal.aborted) return;
          value.failed = true;
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, work.length) }, worker)).then(() => {
      if (controller.signal.aborted) return;
      for (const target of targets) {
        const value = target && ratings.get(target.key);
        if (target && value && !value.failed) cache.set(target.observationKey, { at: Date.now(), value });
      }
      setState({ key, ratings: new Map(ratings) });
    });
    return () => controller.abort();
  }, [key, enabled, cache, read]);
  // 同一帧就拒绝旧 scope/正文的数据，不依赖 effect 事后清理。
  const ratings = enabled && state.key === key ? state.ratings : emptyRatings;
  // 保持无关 phase/流事件更新时的引用，避免调用方重复扫描未变化的整卡技术指标。
  // ratings 已在本次渲染按 key 屏蔽旧 scope/正文；不能把该守卫移到 effect 中。
  return useMemo(() => {
    const rows = projected.map(target => target ? ratings.get(target.key) ?? null : null);
    const predictions = rows.length === 2 && rows[0] && rows[1] ? predictArenaPair(rows[0], rows[1]) : null;
    return rows.map((rating, index) => ({ hasSource: enabled && projected[index] !== null, rating, prediction: predictions?.[index] ?? null }));
  }, [projected, ratings, enabled]);
}
