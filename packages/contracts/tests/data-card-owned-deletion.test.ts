import { describe, expect, test } from 'vitest';
import {
  OwnedDataCardDeletionPreviewQuerySchema, OwnedDataCardDeletionPreviewSchema,
  OwnedDataCardDeletionRequestSchema, OwnedDataCardSoftDeleteAcknowledgementSchema,
  OwnedDataCardPurgeActiveAcknowledgementSchema, OwnedRecycleBinPurgeRequestSchema,
  OwnedRecycleBinPurgeAcknowledgementSchema,
} from '../src/data-cards';
const target = { id: 'card', version: 'a'.repeat(64) };
const fence = { success: true, accountFenceVersion: 1, deleteProtocolVersion: 1, ownerUserId: 7 };
describe('confirmed deletion wire contract', () => {
  test('requires strict owner, opaque full version and an explicit unique bounded set', () => {
    expect(OwnedDataCardDeletionRequestSchema.safeParse({ expectedUserId: 7, ...target }).success).toBe(true);
    for (const input of [{ ...target }, { expectedUserId: '7', ...target }, { expectedUserId: 7, ...target, force: true }, { expectedUserId: 7, id: 'card', version: 'timestamp' }]) {
      expect(OwnedDataCardDeletionRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(OwnedRecycleBinPurgeRequestSchema.safeParse({ expectedUserId: 7, targets: [target], continuationTarget: { ...target, id: 'active' } }).success).toBe(true);
    for (const targets of [[], [target, target], Array.from({ length: 17 }, (_, i) => ({ ...target, id: String(i) }))]) {
      expect(OwnedRecycleBinPurgeRequestSchema.safeParse({ expectedUserId: 7, targets }).success).toBe(false);
    }
  });
  test('strict operation acknowledgements cannot impersonate another delete action', () => {
    const soft = { ...fence, operation: 'soft-delete', id: target.id };
    expect(OwnedDataCardSoftDeleteAcknowledgementSchema.safeParse(soft).success).toBe(true);
    expect(OwnedDataCardPurgeActiveAcknowledgementSchema.safeParse(soft).success).toBe(false);
    expect(OwnedDataCardSoftDeleteAcknowledgementSchema.safeParse({ ...soft, extra: true }).success).toBe(false);
    expect(OwnedRecycleBinPurgeAcknowledgementSchema.safeParse({ ...fence, operation: 'purge-recycle', ids: ['a', 'a'] }).success).toBe(false);
  });
  test('preview never reports a truncated or duplicate set as complete', () => {
    const preview = { ...fence, operation: 'preview-recycle', targets: [{ ...target, type: 'character', name: '卡', description: null }], total: 1, recycleLimit: 5 };
    expect(OwnedDataCardDeletionPreviewSchema.safeParse(preview).success).toBe(true);
    expect(OwnedDataCardDeletionPreviewSchema.safeParse({ ...preview, total: 2 }).success).toBe(false);
    expect(OwnedDataCardDeletionPreviewSchema.safeParse({ ...preview, targets: [preview.targets[0], preview.targets[0]], total: 2 }).success).toBe(false);
    expect(OwnedDataCardDeletionPreviewQuerySchema.safeParse({ expectedUserId: 7, scope: 'active' }).success).toBe(false);
    expect(OwnedDataCardDeletionPreviewQuerySchema.safeParse({ expectedUserId: 7, scope: 'recycle' }).success).toBe(true);
  });
});
