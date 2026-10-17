-- 公开摘要保留 NULL 回退与 id 并列顺序；只索引可公开展示的行。
-- is_public/review_status 前缀让绑定参数查询在尚无统计信息时也能选择索引。
CREATE INDEX IF NOT EXISTS idx_data_cards_public_summary_created
  ON data_cards(is_public, review_status,
    COALESCE(created_at, updated_at) DESC, COALESCE(updated_at, created_at) DESC,
    id DESC, type, user_id)
  WHERE is_public = 1 AND review_status = 'approved' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_data_cards_public_summary_likes
  ON data_cards(is_public, review_status,
    COALESCE(like_count, 0) DESC, COALESCE(updated_at, created_at) DESC,
    id DESC, type, user_id)
  WHERE is_public = 1 AND review_status = 'approved' AND deleted_at IS NULL;

-- 单类型入口使用 type 等值前缀；避免统计信息促使优化器退回原始时间索引并排序。
CREATE INDEX IF NOT EXISTS idx_data_cards_public_summary_type_created
  ON data_cards(is_public, review_status, type,
    COALESCE(created_at, updated_at) DESC, COALESCE(updated_at, created_at) DESC,
    id DESC, user_id)
  WHERE is_public = 1 AND review_status = 'approved' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_data_cards_public_summary_type_likes
  ON data_cards(is_public, review_status, type,
    COALESCE(like_count, 0) DESC, COALESCE(updated_at, created_at) DESC,
    id DESC, user_id)
  WHERE is_public = 1 AND review_status = 'approved' AND deleted_at IS NULL;
