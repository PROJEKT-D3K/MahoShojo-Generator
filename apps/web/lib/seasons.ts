import type { SeasonBattleMode } from '@mahoshojo/domain/arena-strict-setup';
export { deriveSeasonStrictRules, type SeasonBattleMode, type SeasonStrictRules } from '@mahoshojo/domain/arena-strict-setup';

export type SeasonStatus = 'current' | 'history';

export type SeasonSpecialRules = {
  /**
   * 指定赛季排位要求使用的模式。
   * - 未填写：默认仍按严格排位的经典模式规则处理。
   */
  mode?: SeasonBattleMode;
  /**
   * 指定赛季排位要求使用的故事引导（会与严格排位计分校验联动）。
   * - 空字符串/未填写：表示不要求，严格排位默认要求“无故事引导”。
   */
  storyGuidance?: string;
  /**
   * 指定赛季排位要求使用的预设情景文件名（仅在 mode='scenario' 下生效）。
   * 支持省略 .json 扩展名（会自动补齐并校验存在性）。
   */
  scenarioPresetFilename?: string;
  /**
   * 是否允许严格排位使用“问卷/设定卡 Lore 注入”。
   * - 未填写/false：不允许（视为无许可）。
   * - true：允许。
   */
  questionnaireLoreAllowed?: boolean;
  /**
   * 严格排位要求注入的“问卷/设定卡 Lore”（预设问卷 ID）。
   * - 未填写/空数组：不要求；若已允许问卷注入，用户可自选。
   * - 非空：严格排位必须注入这些 Lore，并且不允许注入列表外的其它 Lore。
   */
  questionnaireLorePresetIds?: string[];
};

export type SeasonMeta = {
  id: string;
  name: string;
  startsAt: string;
  endsAt?: string | null;
  status: SeasonStatus;
  description: string;
  specialRules?: SeasonSpecialRules | null;
  archivedAt?: string | null;
};

export type SeasonsConfig = {
  schemaVersion: 1;
  seasons: SeasonMeta[];
};

export type SeasonArchiveEntityRef = {
  entityType: 'data_card' | 'preset';
  entityId: string;
};

export type SeasonArchiveQueueSnapshot = {
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  ratingUpdatedAt: string | null;
  seasonPeakRating?: number | null;
  seasonPeakGames?: number | null;
  seasonPeakAt?: string | null;
  seasonPeakTier?: string | null;
  seasonLowRating?: number | null;
  seasonLowGames?: number | null;
  seasonLowAt?: string | null;
  /**
   * v2 历史归档曾在队列快照里写入 `rank/tier`（用于直接渲染 Top/Bottom）。
   * v3 起不再把“榜单视图”当作归档必需数据，这两个字段会在前端按当前口径计算。
   */
  rank?: number;
  tier?: string;
};

export type SeasonArchiveEntity = {
  entityType: 'data_card' | 'preset';
  entityId: string;
  displayName: string;
  authorName?: string | null;
  authorId?: number | null;
  likeCount?: number | null;
  favoriteCount?: number | null;
  usageCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  description?: string | null;
  techScore: number | null;
  techLevel: string | null;
  isNative: boolean | null;
  tagIds: string[];
  queues: {
    strict?: SeasonArchiveQueueSnapshot | null;
    free?: SeasonArchiveQueueSnapshot | null;
  };
};

export type SeasonArchiveLeaderboard = {
  queue: 'strict' | 'free';
  total: number;
  top: SeasonArchiveEntityRef[];
  bottom: SeasonArchiveEntityRef[];
};

export type SeasonArchiveSnapshotPolicy =
  | {
      mode: 'top_bottom';
      top: number;
      bottom: number;
    }
  | {
      mode: 'full';
    };

export type SeasonArchiveV2 = {
  schemaVersion: 2;
  generatedAt: string;
  season: Pick<SeasonMeta, 'id' | 'name' | 'startsAt' | 'endsAt' | 'description' | 'specialRules'>;
  entities: SeasonArchiveEntity[];
  leaderboards: {
    strict: SeasonArchiveLeaderboard;
    free: SeasonArchiveLeaderboard;
  };
};

export type SeasonArchiveV3 = {
  schemaVersion: 3;
  generatedAt: string;
  season: Pick<SeasonMeta, 'id' | 'name' | 'startsAt' | 'endsAt' | 'description' | 'specialRules'>;
  /**
   * 赛季结算快照策略（用于解释“为什么历史榜单不是全量”）。
   */
  snapshotPolicy: SeasonArchiveSnapshotPolicy;
  /**
   * 全榜可上榜实体总数（按 strict/free 分别统计），用于 UI 文案解释与比例感知。
   */
  totalEligible: {
    strict: number;
    free: number;
  };
  /**
   * 实体快照（facts）：仅保存角色事实数据；榜单视图在前端按当前口径计算。
   */
  entities: SeasonArchiveEntity[];
};

export type SeasonArchive = SeasonArchiveV2 | SeasonArchiveV3;

export { isSafeSeasonId, getCurrentSeason, formatSeasonTitle, formatYmdSlash, seasonArchiveUrl } from '@mahoshojo/domain/public-ranking';
