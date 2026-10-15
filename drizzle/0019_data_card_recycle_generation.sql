-- 保留恢复前的代际；每次进入回收站换代，兼容尚未显式写 token 的 A 版本。
ALTER TABLE data_cards ADD COLUMN recycle_generation TEXT;
--> statement-breakpoint
CREATE TRIGGER data_cards_recycle_generation
AFTER UPDATE OF deleted_at ON data_cards
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
  AND (NEW.recycle_generation IS NULL OR NEW.recycle_generation IS OLD.recycle_generation)
BEGIN
  UPDATE data_cards SET recycle_generation = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
