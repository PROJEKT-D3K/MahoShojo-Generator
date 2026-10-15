import { sql } from 'drizzle-orm';
import {
  OwnedRecycleBinCardDetailSchema,
  OwnedRecycleBinCardSummarySchema,
  type OwnedRecycleBinCardDetail,
  type OwnedRecycleBinCardSummary,
  type OwnedRecycleBinPage,
  type OwnedRecycleBinQuery,
} from '@mahoshojo/contracts/data-cards';
import type { AppDrizzleDb } from '@/lib/db/drizzle';
import { legacyQuestionnaire } from '@/lib/db/repositories/data-card-summaries';

// 列表不选择 data 正文列；旧问卷提示仅在数据库内计算。详情才读取单张墓碑原件。
const summaryColumns = sql`id, type, name, description,
  CAST(is_public AS INTEGER) AS is_public, review_status, created_at, updated_at, deleted_at,
  COALESCE(usage_count, 0) AS usage_count, COALESCE(like_count, 0) AS like_count,
  COALESCE(${legacyQuestionnaire}, 0) AS isLegacyQuestionnaire`;

type RecyclePage = Pick<OwnedRecycleBinPage, 'cards' | 'total' | 'filteredCount' | 'nextOffset'>;

export async function listOwnedRecycleBin(
  db: AppDrizzleDb,
  userId: number,
  query: Pick<OwnedRecycleBinQuery, 'limit' | 'offset' | 'type'>,
): Promise<RecyclePage> {
  const typeFilter = query.type === 'questionnaire'
    ? sql`(type = ${query.type} OR ${legacyQuestionnaire})`
    : query.type ? sql`type = ${query.type}` : sql`1 = 1`;
  const [counts, rows] = await Promise.all([
    db.all<{ total: number; filteredCount: number }>(sql`
      SELECT COUNT(*) AS total, COUNT(CASE WHEN ${typeFilter} THEN 1 END) AS filteredCount
      FROM data_cards WHERE user_id = ${userId} AND deleted_at IS NOT NULL`),
    db.all<OwnedRecycleBinCardSummary>(sql`
      SELECT ${summaryColumns} FROM data_cards
      WHERE user_id = ${userId} AND deleted_at IS NOT NULL AND ${typeFilter}
      ORDER BY deleted_at DESC, id DESC LIMIT ${query.limit} OFFSET ${query.offset}`),
  ]);
  // 聚合查询应始终返回一行，缺失是存储故障，不能伪装为成功空列表。
  if (!counts[0]) throw new Error('Missing recycle-bin counts');
  const { total, filteredCount } = counts[0];
  const cards = rows.map((row) => OwnedRecycleBinCardSummarySchema.parse({ ...row, isLegacyQuestionnaire: Boolean(row.isLegacyQuestionnaire) }));
  const end = query.offset + cards.length;
  return { cards, total, filteredCount, nextOffset: cards.length > 0 && end < filteredCount ? end : null };
}

export async function readOwnedRecycleBinCard(
  db: AppDrizzleDb,
  userId: number,
  id: string,
): Promise<OwnedRecycleBinCardDetail | null> {
  const rows = await db.all<OwnedRecycleBinCardDetail>(sql`
    SELECT ${summaryColumns}, data FROM data_cards
    WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NOT NULL LIMIT 1`);
  return rows[0] ? OwnedRecycleBinCardDetailSchema.parse({ ...rows[0], isLegacyQuestionnaire: Boolean(rows[0].isLegacyQuestionnaire) }) : null;
}
