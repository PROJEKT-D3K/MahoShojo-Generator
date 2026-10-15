import { z } from './zod';
import { SafeJsonValueSchema } from './json-value';

export const ONLINE_DATA_CARD_TYPES = [
  'character',
  'scenario',
  'history',
  'questionnaire',
] as const;

export const OnlineDataCardTypeSchema = z.enum(ONLINE_DATA_CARD_TYPES);
export type OnlineDataCardType = z.infer<typeof OnlineDataCardTypeSchema>;

export const RepairQuestionnaireDataCardTypeRequestSchema = z.object({
  id: z.string().trim().min(1).max(200),
}).strict();
export type RepairQuestionnaireDataCardTypeRequest = z.infer<typeof RepairQuestionnaireDataCardTypeRequestSchema>;

export const DATA_CARD_REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const DataCardReviewStatusSchema = z.enum(DATA_CARD_REVIEW_STATUSES);
export type DataCardReviewStatus = z.infer<typeof DataCardReviewStatusSchema>;

export const ONLINE_DATA_CARD_VISIBILITIES = [-1, 0, 1] as const;

export const OnlineDataCardVisibilitySchema = z.union([
  z.literal(-1),
  z.literal(0),
  z.literal(1),
]);
export type OnlineDataCardVisibility = z.infer<typeof OnlineDataCardVisibilitySchema>;

// 摘要查询为增量模式；未指定 view 的旧调用方仍使用完整列表契约。
export const DataCardSummaryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 24).default(0),
  search: z.string().trim().max(200).optional(),
  sortBy: z.enum(['updated_at', 'created_at', 'likes', 'usage', 'favorites', 'favorited_at']).default('updated_at'),
  types: z.array(OnlineDataCardTypeSchema).max(4).optional(),
  visibility: z.enum(['private', 'public', 'banned']).optional(),
  roleType: z.enum(['magical-girl', 'canshou', 'general']).optional(),
  author: z.string().trim().max(200).optional(),
  minLikes: z.coerce.number().int().min(0).optional(),
  maxLikes: z.coerce.number().int().min(0).optional(),
  minUsage: z.coerce.number().int().min(0).optional(),
  maxUsage: z.coerce.number().int().min(0).optional(),
  minFavorites: z.coerce.number().int().min(0).optional(),
  maxFavorites: z.coerce.number().int().min(0).optional(),
  tagIds: z.array(z.string().min(1).max(100)).max(30).optional(),
  tagMatch: z.enum(['any', 'all']).default('any'),
  nativeOnly: z.boolean().default(false),
  nativeAllowedOnly: z.boolean().default(false),
  recommendedOnly: z.boolean().default(false),
  includeLegacyQuestionnaires: z.boolean().default(false),
});
export type DataCardSummaryQuery = z.infer<typeof DataCardSummaryQuerySchema>;
export type DataCardSummaryQueryInput = z.input<typeof DataCardSummaryQuerySchema>;

export const DataCardSummarySchema = z.object({
  id: z.string(), user_id: z.number().int(), type: OnlineDataCardTypeSchema,
  name: z.string(), description: z.string().nullable(),
  is_public: OnlineDataCardVisibilitySchema, review_status: z.string().nullable(),
  created_at: z.string().nullable(), updated_at: z.string().nullable(),
  usage_count: z.number(), like_count: z.number(), favorite_count: z.number(),
  is_recommended: z.number(), username: z.string(),
  roleType: z.enum(['magical-girl', 'canshou', 'general']).nullable(),
  nativeAllowed: z.boolean(), has_pending_update: z.boolean(),
  tag_ids: z.array(z.string()), favorited_at: z.string().nullable(),
  isLegacyQuestionnaire: z.boolean().optional(),
});
export type DataCardSummary = z.infer<typeof DataCardSummarySchema>;
export const DataCardSummaryPageSchema = z.object({
  success: z.literal(true), cards: z.array(DataCardSummarySchema),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  stats: z.object({ private: z.number(), public: z.number(), pending: z.number() }).optional(),
});
export type DataCardSummaryPage = z.infer<typeof DataCardSummaryPageSchema>;

// 新建的账号围栏是独立端点协议；旧 POST 不因兼容字段获得此保证。
export const DataCardExpectedOwnerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OwnedDataCardCreateAcknowledgementSchema = z.object({
  success: z.literal(true),
  id: z.string().trim().min(1).max(200),
  accountFenceVersion: z.literal(1),
  ownerUserId: DataCardExpectedOwnerSchema,
});

// 内容替换始终保留已选目标的名称、描述和可见性；元信息编辑是独立操作。
export const OwnedDataCardReplacementVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const OwnedDataCardReplacementTargetSchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: OnlineDataCardTypeSchema,
  name: z.string(),
  description: z.string().nullable(),
  isPublic: OnlineDataCardVisibilitySchema,
  reviewStatus: DataCardReviewStatusSchema.nullable(),
  hasPendingUpdate: z.boolean(),
  version: OwnedDataCardReplacementVersionSchema,
});
export type OwnedDataCardReplacementTarget = z.infer<typeof OwnedDataCardReplacementTargetSchema>;
export const OwnedDataCardReplaceRequestSchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  id: z.string().trim().min(1).max(200),
  type: OnlineDataCardTypeSchema,
  expectedVersion: OwnedDataCardReplacementVersionSchema,
  data: SafeJsonValueSchema,
}).strict();
export const OwnedDataCardReplaceAcknowledgementSchema = OwnedDataCardCreateAcknowledgementSchema.extend({
  replacementVersion: z.literal(1),
  pendingReview: z.boolean(),
});
export const OwnedDataCardReplacementTargetResponseSchema = z.object({
  success: z.literal(true),
  accountFenceVersion: z.literal(1),
  ownerUserId: DataCardExpectedOwnerSchema,
  target: OwnedDataCardReplacementTargetSchema,
});

// 元信息更新复用目标快照，但独立于正文替换，不接受 data/type/审核字段。
export const OwnedDataCardMetadataRequestSchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  id: z.string().trim().min(1).max(200),
  expectedVersion: OwnedDataCardReplacementVersionSchema,
  name: z.string().trim().min(1).max(20),
  description: z.string().max(300),
  isPublic: OnlineDataCardVisibilitySchema,
}).strict();
export type OwnedDataCardMetadataRequest = z.infer<typeof OwnedDataCardMetadataRequestSchema>;
export const OwnedDataCardMetadataAcknowledgementSchema = OwnedDataCardCreateAcknowledgementSchema.extend({
  metadataVersion: z.literal(1),
}).strict();

// 回收站只读协议：列表不携带正文，详情只读取当前账号的单个墓碑。
export const OwnedRecycleBinQuerySchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  limit: z.number().int().min(1).max(24).default(12),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 24).default(0),
  type: OnlineDataCardTypeSchema.optional(),
}).strict();
export type OwnedRecycleBinQuery = z.infer<typeof OwnedRecycleBinQuerySchema>;
export const OwnedRecycleBinDetailQuerySchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  id: z.string().trim().min(1).max(200),
}).strict();
export const OWNED_RECYCLE_DETAIL_MAX_BYTES = 1024 * 1024;
export const OwnedRecycleBinCardSummarySchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: OnlineDataCardTypeSchema,
  name: z.string(), description: z.string().nullable(),
  is_public: OnlineDataCardVisibilitySchema,
  review_status: DataCardReviewStatusSchema.nullable(),
  created_at: z.string().nullable(), updated_at: z.string().nullable(),
  deleted_at: z.string().min(1),
  isLegacyQuestionnaire: z.boolean(),
  usage_count: z.number().int().nonnegative(), like_count: z.number().int().nonnegative(),
}).strict();
export type OwnedRecycleBinCardSummary = z.infer<typeof OwnedRecycleBinCardSummarySchema>;
export const OwnedRecycleBinCardDetailSchema = OwnedRecycleBinCardSummarySchema.extend({
  data: z.string().max(OWNED_RECYCLE_DETAIL_MAX_BYTES).refine((value) => new TextEncoder().encode(value).byteLength <= OWNED_RECYCLE_DETAIL_MAX_BYTES, '数据卡正文超过 1 MiB'),
}).strict();
export type OwnedRecycleBinCardDetail = z.infer<typeof OwnedRecycleBinCardDetailSchema>;
export const OwnedRecycleBinPageSchema = z.object({
  success: z.literal(true), accountFenceVersion: z.literal(1), ownerUserId: DataCardExpectedOwnerSchema,
  cards: z.array(OwnedRecycleBinCardSummarySchema).max(24),
  total: z.number().int().nonnegative(), filteredCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict();
export type OwnedRecycleBinPage = z.infer<typeof OwnedRecycleBinPageSchema>;
export const OwnedRecycleBinDetailResponseSchema = z.object({
  success: z.literal(true), accountFenceVersion: z.literal(1), ownerUserId: DataCardExpectedOwnerSchema,
  card: OwnedRecycleBinCardDetailSchema,
}).strict();

// 确认式删除使用内容与回收代际快照；永久删除只接受明确列出的目标。
export const OWNED_DELETE_TARGET_LIMIT = 16;
export const OwnedDataCardDeletionVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const OwnedDataCardDeletionReferenceSchema = z.object({
  id: z.string().min(1).max(200), version: OwnedDataCardDeletionVersionSchema,
}).strict();
export type OwnedDataCardDeletionReference = z.infer<typeof OwnedDataCardDeletionReferenceSchema>;
export const OwnedDataCardDeletionTargetSchema = OwnedDataCardDeletionReferenceSchema.extend({
  type: OnlineDataCardTypeSchema, name: z.string(), description: z.string().nullable(),
}).strict();
export type OwnedDataCardDeletionTarget = z.infer<typeof OwnedDataCardDeletionTargetSchema>;
export const OwnedDataCardDeletionPreviewQuerySchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  scope: z.enum(['active', 'recycle']), id: z.string().min(1).max(200).optional(),
}).strict().refine((query) => query.scope !== 'active' || query.id !== undefined, '活动卡预览必须指定 id');
export const OwnedDataCardDeletionRequestSchema = OwnedDataCardDeletionReferenceSchema.extend({
  expectedUserId: DataCardExpectedOwnerSchema,
}).strict();
export const OwnedRecycleBinPurgeRequestSchema = z.object({
  expectedUserId: DataCardExpectedOwnerSchema,
  targets: z.array(OwnedDataCardDeletionReferenceSchema).min(1).max(OWNED_DELETE_TARGET_LIMIT),
  continuationTarget: OwnedDataCardDeletionReferenceSchema.optional(),
}).strict().refine((request) => new Set(request.targets.map((target) => target.id)).size === request.targets.length, '删除目标不能重复');
export type OwnedRecycleBinPurgeRequest = z.infer<typeof OwnedRecycleBinPurgeRequestSchema>;
const ownedDeletionFence = {
  success: z.literal(true), accountFenceVersion: z.literal(1), deleteProtocolVersion: z.literal(1),
  ownerUserId: DataCardExpectedOwnerSchema,
};
export const OwnedDataCardDeletionPreviewSchema = z.object({
  ...ownedDeletionFence, operation: z.enum(['preview-active', 'preview-recycle']),
  targets: z.array(OwnedDataCardDeletionTargetSchema).max(OWNED_DELETE_TARGET_LIMIT),
  total: z.number().int().nonnegative().max(OWNED_DELETE_TARGET_LIMIT),
  recycleLimit: z.number().int().nonnegative(),
}).strict().refine((response) => response.total === response.targets.length
  && new Set(response.targets.map((target) => target.id)).size === response.targets.length
  && (response.operation !== 'preview-active' || response.targets.length === 1), '删除预览必须完整且不重复');
export type OwnedDataCardDeletionPreview = z.infer<typeof OwnedDataCardDeletionPreviewSchema>;
export const OwnedDataCardSoftDeleteAcknowledgementSchema = z.object({
  ...ownedDeletionFence, operation: z.literal('soft-delete'), id: z.string().min(1).max(200),
}).strict();
export const OwnedDataCardPurgeActiveAcknowledgementSchema = z.object({
  ...ownedDeletionFence, operation: z.literal('purge-active'), id: z.string().min(1).max(200),
}).strict();
export const OwnedRecycleBinPurgeAcknowledgementSchema = z.object({
  ...ownedDeletionFence, operation: z.literal('purge-recycle'),
  ids: z.array(z.string().min(1).max(200)).min(1).max(OWNED_DELETE_TARGET_LIMIT),
}).strict().refine((response) => new Set(response.ids).size === response.ids.length, '删除回执不能重复');

// 恢复接受当前墓碑快照；回执回显被接受的版本，不代表恢复后的版本。
export const OwnedDataCardRestoreRequestSchema = OwnedDataCardDeletionReferenceSchema.extend({
  expectedUserId: DataCardExpectedOwnerSchema,
}).strict();
export type OwnedDataCardRestoreRequest = z.infer<typeof OwnedDataCardRestoreRequestSchema>;
export const OwnedDataCardRestoreAcknowledgementSchema = OwnedDataCardDeletionReferenceSchema.extend({
  success: z.literal(true), accountFenceVersion: z.literal(1), restoreProtocolVersion: z.literal(1),
  ownerUserId: DataCardExpectedOwnerSchema, operation: z.literal('restore'),
}).strict();
