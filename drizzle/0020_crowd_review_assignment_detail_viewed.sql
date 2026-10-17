-- 众查派单记录巡查使首次打开目标卡片详情的时间，用于审议门槛校验。
ALTER TABLE crowd_review_assignments ADD COLUMN detail_viewed_at TEXT;
